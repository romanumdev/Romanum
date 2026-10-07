import { randomUUID } from "node:crypto";
import type { Database } from "../history/database.ts";
import { openSecret, sealSecret } from "../secrets.ts";
import { openGameOAuthCredential, saveGameOAuthGrant, OAuthError, type AnalyticsOAuthGrant, type OAuthOptions } from "./oauth.ts";
import { OpenCloudError, type AnalyticsCredential } from "./open-cloud.ts";

// Account-scoped games and private metrics. Optional OAuth grants and retained legacy keys
// are sealed on the server; their plaintext never enters a game response.

/** Version of the short notices beside the collection and sharing switches, recorded with each choice. */
export const CONSENT_NOTICE = "2026-10-07";

export type LinkedGameStatus = "active" | "key_rejected" | "disconnected";

export type LinkedGame = {
  id: string;
  universeId: number;
  authorization: "oauth" | "legacy_key" | "none";
  /** Collect analytics: whether its metrics sync from Roblox. */
  collect: boolean;
  /** Help improve Romanum: off by default. */
  share: boolean;
  /** Allow the hosted assistant to query private analytics. Separate from improvement sharing. */
  aiAnalysis: boolean;
  status: LinkedGameStatus;
  /** A sync started within the last ten minutes and hasn't finished. */
  syncing: boolean;
  syncedAt: string | null;
  syncError: string | null;
  /** The key's last four characters; null once disconnected. */
  keyHint: string | null;
  keyExpiresAt: string | null;
};

export type MetricPoint = { day: string; value: number; status: string | null };

type Row = {
  id: string;
  universe_id: string | number;
  collect: boolean;
  share: boolean;
  ai_analysis: boolean;
  status: LinkedGameStatus;
  syncing: boolean;
  synced_at: Date | string | null;
  sync_error: string | null;
  hint: string | null;
  expires_at: Date | string | null;
  authorization: LinkedGame["authorization"];
};

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

const toGame = (row: Row): LinkedGame => ({
  id: row.id,
  universeId: Number(row.universe_id),
  authorization: row.authorization,
  collect: row.collect,
  share: row.share,
  aiAnalysis: row.ai_analysis,
  status: row.status,
  syncing: row.syncing,
  syncedAt: iso(row.synced_at),
  syncError: row.sync_error,
  keyHint: row.hint,
  keyExpiresAt: iso(row.expires_at),
});

const SELECT = `SELECT g.id, g.universe_id, g.collect, g.share, g.ai_analysis,
  CASE WHEN o.reconnect_required AND g.status='active' THEN 'key_rejected' ELSE g.status END AS status, g.synced_at, g.sync_error,
  CASE WHEN o.game_id IS NOT NULL THEN 'oauth' WHEN k.game_id IS NOT NULL THEN 'legacy_key' ELSE 'none' END AS authorization,
  CASE WHEN o.game_id IS NULL THEN k.hint ELSE NULL END AS hint,
  CASE WHEN o.game_id IS NULL THEN k.expires_at ELSE NULL END AS expires_at,
  (g.sync_started_at IS NOT NULL AND g.sync_started_at > now() - interval '10 minutes' AND (g.synced_at IS NULL OR g.synced_at < g.sync_started_at)) AS syncing
  FROM linked_games g LEFT JOIN linked_game_keys k ON k.game_id = g.id LEFT JOIN linked_game_oauth o ON o.game_id=g.id`;

/** A game's sealed key names its record, so it can't be moved to another game. */
export const keyContext = (gameId: string) => `linked-game-key:${gameId}`;

export async function listLinkedGames(database: Database, accountId: string): Promise<LinkedGame[]> {
  const { rows } = await database.query<Row>(`${SELECT} WHERE g.account_id=$1 ORDER BY g.created_at, g.id`, [accountId]);
  return rows.map(toGame);
}

export async function readLinkedGame(database: Database, accountId: string, gameId: string): Promise<LinkedGame | null> {
  const { rows } = await database.query<Row>(`${SELECT} WHERE g.id=$1 AND g.account_id=$2`, [gameId, accountId]);
  return rows[0] ? toGame(rows[0]) : null;
}

export async function linkedGameForUniverse(database: Database, accountId: string, universeId: number): Promise<LinkedGame | null> {
  const { rows } = await database.query<Row>(`${SELECT} WHERE g.account_id=$1 AND g.universe_id=$2`, [accountId, universeId]);
  return rows[0] ? toGame(rows[0]) : null;
}

const recordConsent = (sql: Pick<Database, "query">, accountId: string, universeId: number, setting: "collect" | "share" | "ai_analysis", enabled: boolean) =>
  sql.query("INSERT INTO linked_game_consents(account_id, universe_id, setting, enabled, notice) VALUES ($1,$2,$3,$4,$5)", [
    accountId,
    universeId,
    setting,
    enabled,
    CONSENT_NOTICE,
  ]);

/**
 * Links a game with an API key that has been checked with Roblox, or replaces the key of a game already linked.
 * A new game collects analytics from the start; a relinked one keeps its collection and sharing choices.
 */
export async function saveLinkedGame(
  database: Database,
  input: { accountId: string; universeId: number; apiKey: string; keyExpiresAt: string | null },
  secretsKey: Buffer,
): Promise<LinkedGame> {
  const id = await database.transaction(async (sql) => {
    const { rows } = await sql.query<{ id: string; created: boolean }>(
      `INSERT INTO linked_games(id, account_id, universe_id) VALUES ($1,$2,$3)
       ON CONFLICT (account_id, universe_id) DO UPDATE
         SET status='active', sync_error=NULL, sync_started_at=NULL, consent_version=linked_games.consent_version + 1
       RETURNING id, (id = $1) AS created`,
      [randomUUID(), input.accountId, input.universeId],
    );
    const game = rows[0];
    const sealed = sealSecret(input.apiKey, keyContext(game.id), secretsKey);
    await sql.query(
      `INSERT INTO linked_game_keys(game_id, key_version, iv, ciphertext, tag, hint, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (game_id) DO UPDATE SET key_version=EXCLUDED.key_version, iv=EXCLUDED.iv, ciphertext=EXCLUDED.ciphertext,
         tag=EXCLUDED.tag, hint=EXCLUDED.hint, expires_at=EXCLUDED.expires_at, created_at=now()`,
      [game.id, sealed.keyVersion, sealed.iv, sealed.ciphertext, sealed.tag, input.apiKey.slice(-4), input.keyExpiresAt],
    );
    if (game.created) await recordConsent(sql, input.accountId, input.universeId, "collect", true);
    return game.id;
  });
  return (await readLinkedGame(database, input.accountId, id))!;
}

/** An explicit verified OAuth connection preserves the game's data, choices and legacy key. */
export async function saveOAuthLinkedGame(database: Database, input: { accountId: string; universeId: number; grant: AnalyticsOAuthGrant }, key: Buffer): Promise<LinkedGame> {
  const id = await database.transaction(async sql => {
    const { rows } = await sql.query<{ id: string; created: boolean }>(
      `INSERT INTO linked_games(id,account_id,universe_id) VALUES ($1,$2,$3)
       ON CONFLICT (account_id,universe_id) DO UPDATE SET status='active',sync_error=NULL,sync_started_at=NULL,consent_version=linked_games.consent_version+1
       RETURNING id,(id=$1) AS created`, [randomUUID(),input.accountId,input.universeId]);
    const game = rows[0];
    const scoped: Database = { ...sql, transaction: operation => operation(sql), close: async () => {} };
    await saveGameOAuthGrant(scoped,input.accountId,game.id,input.grant,key);
    if (game.created) await recordConsent(sql,input.accountId,input.universeId,"collect",true);
    return game.id;
  });
  return (await readLinkedGame(database,input.accountId,id))!;
}

/** OAuth is preferred once connected. Errors never fall back to a retained legacy key. */
export async function openGameCredential(database: Database, accountId: string, gameId: string, key: Buffer, options: OAuthOptions = {}): Promise<AnalyticsCredential | null> {
  const game = await readLinkedGame(database,accountId,gameId);
  if (!game || game.status === "disconnected") return null;
  try {
    const oauth = await openGameOAuthCredential(database,accountId,gameId,key,options);
    return oauth ?? await openGameKey(database,gameId,key);
  } catch (error) {
    if (error instanceof OAuthError) throw new OpenCloudError(error.kind === "unavailable" ? "unavailable" : "key_rejected",error.message);
    throw error;
  }
}

/**
 * Turns collecting analytics on or off. Off stops syncing, including a sync already under way, and keeps the stored
 * metrics. Each change is recorded with the notice shown beside the switch.
 */
export async function setCollect(database: Database, accountId: string, gameId: string, enabled: boolean): Promise<LinkedGame | null> {
  await database.transaction(async (sql) => {
    const { rows } = await sql.query<{ universe_id: string | number }>(
      `UPDATE linked_games SET collect=$3, consent_version=consent_version + 1, sync_started_at=NULL
       WHERE id=$1 AND account_id=$2 AND collect <> $3 RETURNING universe_id`,
      [gameId, accountId, enabled],
    );
    if (rows[0]) await recordConsent(sql, accountId, Number(rows[0].universe_id), "collect", enabled);
  });
  return readLinkedGame(database, accountId, gameId);
}

/**
 * Turns Help improve Romanum on or off. On covers days from now only; off withdraws the game's metrics from any
 * improvement use at once, since that use reads them through metricsSharedForImprovement.
 */
export async function setShare(database: Database, accountId: string, gameId: string, enabled: boolean): Promise<LinkedGame | null> {
  await database.transaction(async (sql) => {
    const { rows } = await sql.query<{ universe_id: string | number }>(
      `UPDATE linked_games SET share=$3, shared_since=CASE WHEN $3 THEN now() ELSE NULL END, consent_version=consent_version + 1
       WHERE id=$1 AND account_id=$2 AND share <> $3 RETURNING universe_id`,
      [gameId, accountId, enabled],
    );
    if (rows[0]) await recordConsent(sql, accountId, Number(rows[0].universe_id), "share", enabled);
  });
  return readLinkedGame(database, accountId, gameId);
}

/** Opt in to owner-only AI analysis; revoking or changing it invalidates in-flight reads. */
export async function setAiAnalysis(database: Database, accountId: string, gameId: string, enabled: boolean): Promise<LinkedGame | null> {
  await database.transaction(async (sql) => {
    const { rows } = await sql.query<{ universe_id: string | number }>(
      `UPDATE linked_games SET ai_analysis=$3, consent_version=consent_version + 1
       WHERE id=$1 AND account_id=$2 AND ai_analysis <> $3 RETURNING universe_id`,
      [gameId, accountId, enabled],
    );
    if (rows[0]) await recordConsent(sql, accountId, Number(rows[0].universe_id), "ai_analysis", enabled);
  });
  return readLinkedGame(database, accountId, gameId);
}

/** Server-only access snapshot. The account is supplied by the authenticated route, never the model. */
export async function analyticsAccess(database: Database, accountId: string, gameId: string): Promise<{ universeId: number; version: number } | null> {
  const { rows } = await database.query<{ universe_id: string | number; consent_version: number }>(
    `SELECT g.universe_id, g.consent_version FROM linked_games g LEFT JOIN linked_game_keys k ON k.game_id=g.id LEFT JOIN linked_game_oauth o ON o.game_id=g.id
     WHERE g.id=$1 AND g.account_id=$2 AND g.ai_analysis AND g.collect AND g.status='active'
       AND ((o.game_id IS NOT NULL AND NOT o.reconnect_required) OR (o.game_id IS NULL AND k.game_id IS NOT NULL AND (k.expires_at IS NULL OR k.expires_at > now())))`,
    [gameId, accountId],
  );
  return rows[0] ? { universeId: Number(rows[0].universe_id), version: rows[0].consent_version } : null;
}

/** Revalidate private consent around opening either kind of server-only credential. */
export async function openAnalyticsCredential(database: Database, accountId: string, gameId: string, version: number, key: Buffer, options: OAuthOptions = {}): Promise<AnalyticsCredential | null> {
  const before = await analyticsAccess(database,accountId,gameId);
  if (!before || before.version !== version) return null;
  const credential = await openGameCredential(database,accountId,gameId,key,options);
  const after = await analyticsAccess(database,accountId,gameId);
  return after?.version === version ? credential : null;
}

/** Opens only this account's AI-enabled key at the captured consent version, even if linking changes concurrently. */
export async function openAnalyticsKey(database: Database, accountId: string, gameId: string, version: number, secretsKey: Buffer): Promise<string | null> {
  const { rows } = await database.query<{ key_version: number; iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }>(
    `SELECT k.key_version, k.iv, k.ciphertext, k.tag FROM linked_game_keys k JOIN linked_games g ON g.id=k.game_id
     WHERE g.id=$1 AND g.account_id=$2 AND g.consent_version=$3 AND g.ai_analysis AND g.collect AND g.status='active'
       AND (k.expires_at IS NULL OR k.expires_at > now())`,
    [gameId, accountId, version],
  );
  const row = rows[0];
  return row ? openSecret({ keyVersion: row.key_version, iv: row.iv, ciphertext: row.ciphertext, tag: row.tag }, keyContext(gameId), secretsKey) : null;
}

/** Deletes the game's stored key and stops syncing. Its metrics stay until the game's data is deleted. */
export async function disconnectGame(database: Database, accountId: string, gameId: string): Promise<LinkedGame | null> {
  await database.transaction(async (sql) => {
    const { rows } = await sql.query(
      `UPDATE linked_games SET status='disconnected', sync_started_at=NULL, consent_version=consent_version + 1
       WHERE id=$1 AND account_id=$2 RETURNING id`,
      [gameId, accountId],
    );
    if (rows[0]) {
      await sql.query("DELETE FROM linked_game_keys WHERE game_id=$1", [gameId]);
      await sql.query("DELETE FROM linked_game_oauth WHERE game_id=$1", [gameId]);
    }
  });
  return readLinkedGame(database, accountId, gameId);
}

/** Removes the game from the account with its key and metrics. The record of its consent choices stays. */
export async function deleteLinkedGame(database: Database, accountId: string, gameId: string): Promise<boolean> {
  const { rows } = await database.query("DELETE FROM linked_games WHERE id=$1 AND account_id=$2 RETURNING id", [gameId, accountId]);
  return rows.length > 0;
}

/** A linked game's stored metrics, by metric, oldest day first. */
export async function readGameMetrics(database: Database, accountId: string, gameId: string): Promise<Record<string, MetricPoint[]>> {
  const { rows } = await database.query<{ metric: string; day: string; value: number; status: string | null }>(
    `SELECT m.metric, m.day::text AS day, m.value, m.status FROM linked_game_metrics m JOIN linked_games g ON g.id = m.game_id
     WHERE g.id=$1 AND g.account_id=$2 ORDER BY m.metric, m.day`,
    [gameId, accountId],
  );
  const metrics: Record<string, MetricPoint[]> = {};
  for (const row of rows) (metrics[row.metric] ??= []).push({ day: row.day, value: Number(row.value), status: row.status });
  return metrics;
}

/**
 * The only way work to improve Romanum may read private metrics: games that turned Help improve Romanum on, and only
 * days from when they did. Games that never turned it on, which is the default, are never included.
 */
export async function metricsSharedForImprovement(database: Database): Promise<{ universeId: number; metric: string; day: string; value: number }[]> {
  const { rows } = await database.query<{ universe_id: string | number; metric: string; day: string; value: number }>(
    `SELECT g.universe_id, m.metric, m.day::text AS day, m.value FROM linked_game_metrics m JOIN linked_games g ON g.id = m.game_id
     WHERE g.share AND m.day >= (g.shared_since AT TIME ZONE 'UTC')::date ORDER BY g.universe_id, m.metric, m.day`,
  );
  return rows.map((row) => ({ universeId: Number(row.universe_id), metric: row.metric, day: row.day, value: Number(row.value) }));
}

/** Opens a game's stored key for a sync. Null once it's disconnected. */
export async function openGameKey(database: Database, gameId: string, secretsKey: Buffer): Promise<string | null> {
  const { rows } = await database.query<{ key_version: number; iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }>(
    "SELECT key_version, iv, ciphertext, tag FROM linked_game_keys WHERE game_id=$1",
    [gameId],
  );
  const row = rows[0];
  return row ? openSecret({ keyVersion: row.key_version, iv: row.iv, ciphertext: row.ciphertext, tag: row.tag }, keyContext(gameId), secretsKey) : null;
}
