import type { Database } from "../history/database.ts";
import { secretsKey } from "../secrets.ts";
import { SYNCED_METRICS } from "./metrics.ts";
import { OpenCloudError, queryDailyMetric, type AnalyticsCredential, type OpenCloudOptions } from "./open-cloud.ts";
import { openGameCredential } from "./store.ts";

// Syncs linked games' daily metrics from the Analytics Query API with their owners' keys. Consent is checked again
// in the transaction that writes: a sync that started before its game's collection was turned off, its key was
// replaced, or it was disconnected or deleted, writes nothing.

/** The first sync fetches four weeks; later ones refetch recent days, which change as late data and retention arrive. */
const BACKFILL_DAYS = 28;
const REFRESH_DAYS = 10;
export const SYNC_EVERY_HOURS = 6;
/** Space between queries, under the Analytics API's limit of 30 a minute per key owner. */
const QUERY_SPACING_MS = 2_500;

const DAY_MS = 86_400_000;
const startOfUtcDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

export type SyncOptions = OpenCloudOptions & { now?: Date; secretsKey?: Buffer };
export type SyncResult = { outcome: "synced" | "partial" | "skipped" | "discarded" | "key_rejected"; stored: number };

type Claim = { accountId: string; universeId: number; consentVersion: number; firstSync: boolean };

/** Marks the game as syncing, unless it isn't collecting, has no key, or another sync started in the last ten minutes. */
async function claim(database: Database, gameId: string): Promise<Claim | null> {
  const { rows } = await database.query<{ account_id: string; universe_id: string | number; consent_version: number; synced_at: Date | string | null }>(
    `UPDATE linked_games SET sync_started_at=now()
     WHERE id=$1 AND status='active' AND collect AND (sync_started_at IS NULL OR sync_started_at < now() - interval '10 minutes')
     RETURNING account_id, universe_id, consent_version, synced_at`,
    [gameId],
  );
  const row = rows[0];
  return row ? { accountId: row.account_id, universeId: Number(row.universe_id), consentVersion: row.consent_version, firstSync: row.synced_at === null } : null;
}

/** Writes a sync's values if the game's consent is unchanged since the sync started; otherwise discards them. */
async function write(database: Database, gameId: string, claimed: Claim, values: { metric: string; day: string; value: number; status: string | null }[], failure: OpenCloudError | null): Promise<SyncResult> {
  return database.transaction(async (sql) => {
    const { rows } = await sql.query<{ consent_version: number; collect: boolean; status: string }>(
      "SELECT consent_version, collect, status FROM linked_games WHERE id=$1 FOR UPDATE",
      [gameId],
    );
    const current = rows[0];
    if (!current || current.consent_version !== claimed.consentVersion || !current.collect || current.status !== "active") {
      return { outcome: "discarded", stored: 0 };
    }
    // One row per metric and day: a repeated day would stop the upsert.
    values = [...new Map(values.map((value) => [`${value.metric}|${value.day}`, value])).values()];
    if (values.length) {
      await sql.query(
        `INSERT INTO linked_game_metrics(game_id, metric, day, value, status)
         SELECT $1, v.metric, v.day, v.value, v.status FROM jsonb_to_recordset($2::jsonb) AS v(metric text, day date, value float8, status text)
         ON CONFLICT (game_id, metric, day) DO UPDATE SET value=EXCLUDED.value, status=EXCLUDED.status, fetched_at=now()`,
        [gameId, JSON.stringify(values)],
      );
    }
    if (failure?.kind === "key_rejected") {
      await sql.query(
        "UPDATE linked_games SET status='key_rejected', sync_error=$2, consent_version=consent_version + 1 WHERE id=$1",
        [gameId, failure.message],
      );
      return { outcome: "key_rejected", stored: values.length };
    }
    // A partial sync keeps the last complete time, so the game stays due and the rest is fetched next time.
    await sql.query(
      "UPDATE linked_games SET synced_at=CASE WHEN $2::text IS NULL THEN now() ELSE synced_at END, sync_error=$2 WHERE id=$1",
      [gameId, failure?.message ?? null],
    );
    return { outcome: failure ? "partial" : "synced", stored: values.length };
  });
}

/** Syncs one linked game's metrics with its stored key. */
export async function syncLinkedGame(database: Database, gameId: string, options: SyncOptions = {}): Promise<SyncResult> {
  const claimed = await claim(database, gameId);
  if (!claimed) return { outcome: "skipped", stored: 0 };
  let key: Buffer;
  // One bounded metric can spend several minutes polling. Refresh before that
  // window and check again between metrics, rather than retaining a near-expiry token.
  const credentialOptions = { fetch: options.fetch, signal: options.signal };
  let apiKey: AnalyticsCredential | null;
  try {
    key = options.secretsKey ?? (await secretsKey());
    apiKey = await openGameCredential(database, claimed.accountId, gameId, key, credentialOptions);
  } catch (error) {
    // The secrets key changed or the sealed key was altered: the person has to link the game again.
    return write(database, gameId, claimed, [], error instanceof OpenCloudError ? error : new OpenCloudError("key_rejected", "Reconnect this game through Roblox."));
  }
  if (!apiKey) return { outcome: "skipped", stored: 0 };

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const end = startOfUtcDay(options.now ?? new Date());
  const start = new Date(end.getTime() - (claimed.firstSync ? BACKFILL_DAYS : REFRESH_DAYS) * DAY_MS);
  const values: { metric: string; day: string; value: number; status: string | null }[] = [];
  let failure: OpenCloudError | null = null;
  for (const [index, { metric }] of SYNCED_METRICS.entries()) {
    if (index > 0) await sleep(QUERY_SPACING_MS);
    try {
      if (index > 0 && typeof apiKey !== "string") {
        const current = await database.query<{ consent_version: number; collect: boolean; status: string }>(
          "SELECT consent_version,collect,status FROM linked_games WHERE id=$1 AND account_id=$2", [gameId,claimed.accountId]);
        if (!current.rows[0] || current.rows[0].consent_version !== claimed.consentVersion || !current.rows[0].collect || current.rows[0].status !== "active") {
          return write(database,gameId,claimed,values,null);
        }
        const refreshed = await openGameCredential(database,claimed.accountId,gameId,key,credentialOptions);
        if (!refreshed || typeof refreshed === "string") throw new OpenCloudError("key_rejected","Reconnect this game through Roblox.");
        apiKey = refreshed;
      }
      for (const point of await queryDailyMetric(apiKey, claimed.universeId, metric, { start, end }, { ...options, sleep })) values.push({ metric, ...point });
    } catch (error) {
      // A metric this experience can't be queried for is left out; anything else stops the sync for now.
      if (error instanceof OpenCloudError && error.kind === "bad_request") continue;
      failure = error instanceof OpenCloudError ? error : new OpenCloudError("unavailable", "The sync failed.");
      break;
    }
  }
  return write(database, gameId, claimed, values, failure);
}

/** Syncs the linked games that are due, oldest first: all accounts', or one account's. For the collector and page visits. */
export async function syncDueGames(database: Database, options: SyncOptions & { accountId?: string; limit?: number } = {}): Promise<number> {
  const { rows } = await database.query<{ id: string }>(
    `SELECT id FROM linked_games
     WHERE status='active' AND collect AND ($1::uuid IS NULL OR account_id=$1)
       AND (synced_at IS NULL OR synced_at < now() - make_interval(hours => $2))
       AND (sync_started_at IS NULL OR sync_started_at < now() - interval '10 minutes')
     ORDER BY synced_at NULLS FIRST, id LIMIT $3`,
    [options.accountId ?? null, SYNC_EVERY_HOURS, options.limit ?? 5],
  );
  let synced = 0;
  for (const { id } of rows) if ((await syncLinkedGame(database, id, options)).outcome !== "skipped") synced += 1;
  return synced;
}
