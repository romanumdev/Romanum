import { randomUUID } from "node:crypto";
import type { Database } from "./database.ts";
import { getRobloxChart, getGameStats, type ChartGame, type GameStats } from "../roblox.ts";
import { MARKET_CHARTS } from "../public-data.ts";
import { isRobloxImageUrl } from "../roblox-icons.ts";
import { INTERVAL_SECONDS } from "./constants.ts";
import { evaluateWatchlists } from "../watchlists/store.ts";

export const COHORT_LIMIT = 300;
const validId = (value: number) => Number.isSafeInteger(value) && value > 0;
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const loaders = { getRobloxChart, getGameStats };

/** Fresh upstream reads only. This path never promotes a cached response into a new observation. */
export async function collectHistory(database: Database, options: { loaders?: typeof loaders; now?: () => number } = {}) {
  const upstream = options.loaders ?? loaders;
  const now = options.now ?? Date.now;
  const started = now();
  const slot = new Date(Math.floor(started / (INTERVAL_SECONDS * 1000)) * INTERVAL_SECONDS * 1000).toISOString();
  const runId = randomUUID();
  const claim = await database.query("INSERT INTO history_runs(id, slot, started_at, status) VALUES ($1,$2,$3,'running') ON CONFLICT (slot) DO NOTHING RETURNING id", [runId, slot, new Date(started).toISOString()]);
  if (!claim.rows.length) return { skipped: true, slot };

  try {
    for (const chart of MARKET_CHARTS) {
      let games: ChartGame[];
      try { games = await upstream.getRobloxChart(chart); }
      catch {
        await database.query("INSERT INTO history_chart_fetches(run_id, chart_id, status) VALUES ($1,$2,'failed')", [runId, chart]);
        continue;
      }
      const fetchedAt = new Date(now()).toISOString();
      const valid = games.filter((game) => validId(game.universeId) && validId(game.rootPlaceId) && validId(game.rank) && typeof game.name === "string" && count(game.playing) !== null && typeof game.sponsored === "boolean");
      const unique = [...new Map(valid.map((game) => [game.universeId, game])).values()];
      const rejected = games.length - unique.length;
      await database.transaction(async (sql) => {
        await sql.query("INSERT INTO history_chart_fetches(run_id, chart_id, observed_at, status, rejected) VALUES ($1,$2,$3,$4,$5)", [runId, chart, fetchedAt, rejected ? "partial" : "complete", rejected]);
        if (!unique.length) return;
        const input = JSON.stringify(unique.map((game) => ({ ...game, iconUrl: isRobloxImageUrl(game.iconUrl) ? game.iconUrl : null })));
        await sql.query(`INSERT INTO history_games(universe_id,root_place_id,name,icon_url,first_seen,last_seen)
          SELECT "universeId", "rootPlaceId", name, "iconUrl", $2, $2 FROM jsonb_to_recordset($1::jsonb)
          AS x("universeId" bigint,"rootPlaceId" bigint,name text,"iconUrl" text)
          ON CONFLICT(universe_id) DO UPDATE SET root_place_id=EXCLUDED.root_place_id,name=EXCLUDED.name,
          icon_url=COALESCE(EXCLUDED.icon_url,history_games.icon_url),last_seen=EXCLUDED.last_seen`, [input, fetchedAt]);
        await sql.query(`INSERT INTO history_chart_entries(run_id,chart_id,universe_id,rank,name,genre,playing,sponsored)
          SELECT $2,$3,"universeId",rank,name,genre,playing,sponsored FROM jsonb_to_recordset($1::jsonb)
          AS x("universeId" bigint,rank integer,name text,genre text,playing bigint,sponsored boolean)`, [input, runId, chart]);
      });
    }

    // Reserve at most 50 of the existing 300 slots for explicitly saved public
    // games/peers. Oldest attempted saved games rotate fairly under capacity;
    // failed reads do not monopolize the reserve. Unused reserve stays with charts.
    const { rows: targets } = await database.query<{ universe_id: string }>(`WITH chart AS (
      SELECT universe_id,row_number() OVER(ORDER BY min(rank),universe_id) AS position FROM history_chart_entries
      WHERE run_id=$1 AND NOT sponsored GROUP BY universe_id
    ), saved AS (
      SELECT DISTINCT unnest(array_prepend(universe_id,peer_ids)) AS universe_id FROM analytics_watchlists
    ), reserved AS (
      SELECT s.universe_id FROM saved s WHERE NOT EXISTS(SELECT 1 FROM chart c WHERE c.universe_id=s.universe_id AND c.position<=250)
      ORDER BY (SELECT max(r.slot) FROM history_targets t JOIN history_runs r ON r.id=t.run_id WHERE t.universe_id=s.universe_id) ASC NULLS FIRST,s.universe_id LIMIT 50
    ), candidates AS (
      SELECT universe_id,0 AS priority,position AS position FROM chart WHERE position<=250
      UNION ALL SELECT universe_id,1 AS priority,0 AS position FROM reserved
      UNION ALL SELECT universe_id,2 AS priority,position FROM chart WHERE position>250 AND universe_id NOT IN(SELECT universe_id FROM reserved)
    ) SELECT universe_id FROM candidates ORDER BY priority,position,universe_id LIMIT $2`, [runId, COHORT_LIMIT]);
    const ids = targets.map((target) => Number(target.universe_id));
    await database.query("INSERT INTO history_targets(run_id,universe_id,status) SELECT $1,unnest($2::bigint[]),'pending'", [runId, ids]);
    await database.query("UPDATE history_runs SET targeted=$2 WHERE id=$1", [runId, ids.length]);

    // Batches match the existing public tool limit; only three requests execute concurrently.
    let cursor = 0;
    const batches: number[][] = [];
    for (let index = 0; index < ids.length; index += 10) batches.push(ids.slice(index, index + 10));
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (;;) {
        const batch = batches[cursor++];
        if (!batch) return;
        let games: GameStats[] = [];
        try { games = await upstream.getGameStats(batch); } catch { /* Failure is persisted below, never converted to zero. */ }
        const fetchedAt = new Date(now()).toISOString();
        const valid = [...new Map(games.filter((game) => batch.includes(game.universeId) && count(game.playing) !== null).map((game) => [game.universeId, game])).values()];
        await database.transaction(async (sql) => {
          await sql.query("UPDATE history_targets SET status='unavailable' WHERE run_id=$1 AND universe_id=ANY($2::bigint[])", [runId, batch]);
          for (const game of valid) {
            await sql.query(`INSERT INTO history_observations(run_id,universe_id,observed_at,playing,visits,favorites,likes,dislikes)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [runId, game.universeId, fetchedAt, game.playing, count(game.visits), count(game.favorites), count(game.likes), count(game.dislikes)]);
            await sql.query("UPDATE history_targets SET status='observed' WHERE run_id=$1 AND universe_id=$2", [runId, game.universeId]);
          }
        });
      }
    }));
    const { rows: counts } = await database.query<{ observed: number; chart_failures: number }>(`SELECT
      (SELECT count(*)::integer FROM history_observations WHERE run_id=$1) AS observed,
      (SELECT count(*)::integer FROM history_chart_fetches WHERE run_id=$1 AND status<>'complete') AS chart_failures`, [runId]);
    const observed = counts[0].observed;
    const status = counts[0].chart_failures || observed !== ids.length ? (observed ? "partial" : "failed") : "complete";
    await database.query("UPDATE history_runs SET status=$2,observed=$3,finished_at=$4 WHERE id=$1", [runId, status, observed, new Date(now()).toISOString()]);
    // Alert failure must not undo successfully persisted public collection.
    let alertStatus: "complete" | "unavailable" = "complete";
    let notifications = 0;
    try { notifications = await evaluateWatchlists(database,slot,now()); }
    catch { alertStatus = "unavailable"; }
    return { skipped: false, runId, slot, status, targeted: ids.length, observed, chartFailures: counts[0].chart_failures, alertStatus, notifications };
  } catch (error) {
    await database.query("UPDATE history_runs SET status='failed',finished_at=$2,observed=(SELECT count(*) FROM history_observations WHERE run_id=$1) WHERE id=$1", [runId, new Date(now()).toISOString()]).catch(() => {});
    throw error;
  }
}
