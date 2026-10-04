import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../history/database.ts";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import { getGameStats, type GameStats } from "../roblox.ts";
import { isRobloxImageUrl } from "../roblox-icons.ts";
import { evaluateRule, type PublicSample, type WatchRule } from "./rules.ts";

export const MAX_WATCHLISTS = 20;
const universe = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const watchInput = z.object({ name: z.string().trim().min(1).max(100), universeId: universe, peerIds: z.array(universe).max(5).default([]), enabled: z.boolean().default(true), direction: z.enum(["up", "down", "either"]).default("either"), thresholdPercent: z.number().int().min(5).max(500).default(20), minimumPlayers: z.number().int().min(1).max(1_000_000).default(25), windowMinutes: z.union([z.literal(30),z.literal(60)]).default(30) }).strict().refine(v => !v.peerIds.includes(v.universeId) && new Set(v.peerIds).size === v.peerIds.length, "Peers must be distinct from the saved game.");
export type WatchInput = z.infer<typeof watchInput>;
export class WatchlistError extends Error { readonly code: "invalid" | "not_found" | "limit" | "conflict" | "unavailable"; constructor(code: WatchlistError["code"], message: string) { super(message); this.code=code; } }
export type Watchlist = WatchInput & { id: string; revision: number; coverage: "waiting" | "ready" | "unavailable"; detail: string; updatedAt: string };
type Row = { id: string; owner_id: string; name: string; universe_id: string; peer_ids: string[]; enabled: boolean; direction: WatchRule["direction"]; threshold_percent: number; minimum_players: number; window_minutes: 30 | 60; revision: number; updated_at: Date | string; coverage?: Watchlist["coverage"]; detail?: string; evaluated_slot?: Date | string | null };
const owner = (id: string) => ownerIdSchema.parse(id);
const view = (r: Row): Watchlist => ({ id: r.id, name: r.name, universeId: Number(r.universe_id), peerIds: r.peer_ids.map(Number), enabled: r.enabled, direction: r.direction, thresholdPercent: r.threshold_percent, minimumPlayers: r.minimum_players, windowMinutes: r.window_minutes, revision: r.revision, coverage: r.coverage ?? "waiting", detail: r.detail ?? "Saving requests bounded collection; waiting for matched public observations. Capacity is shared and collection is not guaranteed.", updatedAt: new Date(r.updated_at).toISOString() });
async function lock(sql: Sql, ownerId: string) { await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [ownerId]); }
export async function listWatchlists(db: Database, ownerId: string): Promise<Watchlist[]> {
  const { rows } = await db.query<Row>(`SELECT w.*,s.coverage,s.detail,s.evaluated_slot FROM analytics_watchlists w LEFT JOIN analytics_watchlist_state s ON s.watchlist_id=w.id AND s.owner_id=w.owner_id WHERE w.owner_id=$1 ORDER BY w.updated_at DESC,w.id LIMIT ${MAX_WATCHLISTS}`, [owner(ownerId)]);
  return rows.map(row => view(row.enabled && row.evaluated_slot && Date.now()-new Date(row.evaluated_slot).getTime()>600_000 ? {...row,coverage:"unavailable",detail:"Collection or rule evaluation is stale or outside current capacity. Alerts wait for fresh matched observations."} : row));
}
/** Explicit saves only: validate public existence, register metadata, then privately save.
 * A metadata read is never inserted as a historical observation. */
export async function saveWatchlist(db: Database, ownerId: string, input: unknown, options: { id?: string; revision?: number; load?: (ids: number[]) => Promise<GameStats[]> } = {}): Promise<Watchlist> {
  ownerId = owner(ownerId);
  const parsed = watchInput.safeParse(input);
  if (!parsed.success) throw new WatchlistError("invalid", "Check the saved game, distinct peers and bounded rule settings.");
  if (options.id && !idSchema.safeParse(options.id).success) throw new WatchlistError("not_found", "Watchlist not found.");
  const data = parsed.data;
  const ids = [data.universeId,...data.peerIds];
  // Bound the external metadata request; all identities are still authorized below.
  let games: GameStats[];
  try { games = await (options.load ?? getGameStats)(ids); } catch { throw new WatchlistError("unavailable", "Public game validation is unavailable. Try saving later."); }
  if (ids.some(id => !games.some(g => g.universeId === id && Number.isSafeInteger(g.rootPlaceId) && g.rootPlaceId > 0 && typeof g.name === "string" && g.name.length > 0))) throw new WatchlistError("invalid", "Every saved game and peer must be available through public Roblox data.");
  return db.transaction(async sql => {
    await lock(sql,ownerId);
    const { rows: existing } = await sql.query<Row>("SELECT * FROM analytics_watchlists WHERE owner_id=$1 AND " + (options.id ? "id=$2" : "universe_id=$2") + " FOR UPDATE",[ownerId,options.id ?? data.universeId]);
    if (options.id && !existing[0]) throw new WatchlistError("not_found", "Watchlist not found.");
    if (options.id && existing[0].revision !== options.revision) throw new WatchlistError("conflict", "This watchlist changed. Reload before editing.");
    if (!existing[0]) {
      const { rows } = await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM analytics_watchlists WHERE owner_id=$1",[ownerId]);
      if (rows[0].count >= MAX_WATCHLISTS) throw new WatchlistError("limit", `Keep up to ${MAX_WATCHLISTS} saved games.`);
    } else if (!options.id) return view(existing[0]);
    for (const id of ids) {
      const g = games.find(g => g.universeId === id)!;
      await sql.query(`INSERT INTO history_games(universe_id,root_place_id,name,icon_url,first_seen,last_seen) VALUES($1,$2,$3,$4,now(),now()) ON CONFLICT(universe_id) DO UPDATE SET name=EXCLUDED.name,root_place_id=EXCLUDED.root_place_id,icon_url=COALESCE(EXCLUDED.icon_url,history_games.icon_url)`,[id,g.rootPlaceId,g.name.slice(0,500),isRobloxImageUrl(g.iconUrl) ? g.iconUrl : null]);
    }
    const id = existing[0]?.id ?? randomUUID();
    const { rows } = await sql.query<Row>(`INSERT INTO analytics_watchlists(id,owner_id,name,universe_id,peer_ids,enabled,direction,threshold_percent,minimum_players,window_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,universe_id=EXCLUDED.universe_id,peer_ids=EXCLUDED.peer_ids,enabled=EXCLUDED.enabled,direction=EXCLUDED.direction,threshold_percent=EXCLUDED.threshold_percent,minimum_players=EXCLUDED.minimum_players,window_minutes=EXCLUDED.window_minutes,revision=analytics_watchlists.revision+1,updated_at=now() RETURNING *`,[id,ownerId,data.name,data.universeId,data.peerIds,data.enabled,data.direction,data.thresholdPercent,data.minimumPlayers,data.windowMinutes]);
    await sql.query("DELETE FROM analytics_watchlist_state WHERE watchlist_id=$1 AND owner_id=$2",[id,ownerId]);
    return view(rows[0]);
  });
}
export async function deleteWatchlist(db: Database, ownerId: string, id: string) {
  if (!idSchema.safeParse(id).success) throw new WatchlistError("not_found", "Watchlist not found.");
  return db.transaction(async sql => { await lock(sql,owner(ownerId)); const { rows } = await sql.query("DELETE FROM analytics_watchlists WHERE id=$1 AND owner_id=$2 RETURNING id",[id,ownerId]); if (!rows.length) throw new WatchlistError("not_found", "Watchlist not found."); });
}
export async function listNotifications(db: Database, ownerId: string) {
  return (await db.query("SELECT id,watchlist_id,observed_at,title,evidence,acknowledged_at,created_at FROM analytics_notifications WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT 100",[owner(ownerId)])).rows;
}
export async function acknowledgeNotification(db: Database, ownerId: string, id: string) {
  if (!idSchema.safeParse(id).success) throw new WatchlistError("not_found", "Notification not found.");
  return db.transaction(async sql => { await lock(sql,owner(ownerId)); const { rows } = await sql.query("UPDATE analytics_notifications SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1 AND owner_id=$2 RETURNING id",[id,ownerId]); if (!rows.length) throw new WatchlistError("not_found", "Notification not found."); });
}

/** Called after the existing collector completes. State + notification share the owner
 * transaction and closed-owner guard. Stale/gapped data cannot emit or clear a latch. */
export async function evaluateWatchlists(db: Database, slot: string, now = Date.now()) {
  // Evaluate at most 100 rules per collector pass; least recently evaluated
  // rules rotate first. Excess demand remains waiting, never promised a cadence.
  const { rows: due } = await db.query<{ owner_id: string; id: string }>(`SELECT w.owner_id,w.id FROM analytics_watchlists w LEFT JOIN analytics_watchlist_state s ON s.watchlist_id=w.id WHERE w.enabled ORDER BY s.evaluated_slot ASC NULLS FIRST,w.id LIMIT 100`);
  const owners = [...new Set(due.map(row => row.owner_id))];
  let emitted = 0;
  for (const ownerId of owners) {
    await db.transaction(async sql => {
      await lock(sql,ownerId);
      const { rows: watches } = await sql.query<Row>("SELECT * FROM analytics_watchlists WHERE owner_id=$1 AND enabled AND id=ANY($2::uuid[]) ORDER BY id",[ownerId,due.filter(row=>row.owner_id===ownerId).map(row=>row.id)]);
      for (const row of watches) {
        const watch = view(row);
        const { rows: state } = await sql.query<{ revision: number; latched: boolean; evaluated_slot: Date | null }>("SELECT revision,latched,evaluated_slot FROM analytics_watchlist_state WHERE watchlist_id=$1 AND owner_id=$2 FOR UPDATE",[row.id,ownerId]);
        if (state[0]?.evaluated_slot && Date.parse(slot) <= new Date(state[0].evaluated_slot).getTime()) continue;
        const { rows } = await sql.query<{ universe_id: string; slot: Date; observed_at: Date; playing: string }>(`SELECT o.universe_id,r.slot,o.observed_at,o.playing FROM history_observations o JOIN history_runs r ON r.id=o.run_id WHERE o.universe_id=ANY($1::bigint[]) AND ((r.slot BETWEEN $2::timestamptz-interval '55 minutes' AND $2::timestamptz) OR (r.slot BETWEEN $2::timestamptz-interval '24 hours 55 minutes' AND $2::timestamptz-interval '24 hours'))`,[[watch.universeId,...watch.peerIds],slot]);
        const samples: PublicSample[] = rows.map(r => ({ universeId: Number(r.universe_id), slot: new Date(r.slot).toISOString(), observedAt: new Date(r.observed_at).toISOString(), playing: Number(r.playing) }));
        const result = evaluateRule(watch,samples,slot,now);
        if (result.coverage === "waiting") {
          const { rows: failures } = await sql.query("SELECT 1 FROM history_targets t JOIN history_runs r ON r.id=t.run_id WHERE r.slot=$1 AND t.universe_id=ANY($2::bigint[]) AND t.status='unavailable' LIMIT 1",[slot,[watch.universeId,...watch.peerIds]]);
          if (failures.length) { result.coverage="unavailable"; result.detail="The latest public fetch is unavailable for this game or a peer. Alerts are suppressed; unavailable samples never count as zero."; }
        }
        let latched = state[0]?.revision === row.revision && state[0].latched;
        if (result.coverage === "ready" && result.recovered) latched = false;
        if (result.crossed && !latched && result.evidence) {
          const evidence = result.evidence;
          const title = `${watch.name}: ${evidence.signalPercent >= 0 ? "+" : ""}${evidence.signalPercent.toFixed(1)}${watch.peerIds.length ? " percentage points versus peers" : "% public player change"}`.slice(0,200);
          const { rows: inserted } = await sql.query("INSERT INTO analytics_notifications(id,owner_id,watchlist_id,dedupe_key,observed_at,title,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id",[randomUUID(),ownerId,row.id,`${row.id}:${row.revision}:${slot}`,slot,title,JSON.stringify(evidence)]);
          emitted += inserted.length;
          latched = true;
        }
        await sql.query("INSERT INTO analytics_watchlist_state(watchlist_id,owner_id,revision,latched,evaluated_slot,coverage,detail) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(watchlist_id) DO UPDATE SET revision=EXCLUDED.revision,latched=EXCLUDED.latched,evaluated_slot=EXCLUDED.evaluated_slot,coverage=EXCLUDED.coverage,detail=EXCLUDED.detail",[row.id,ownerId,row.revision,Boolean(latched),slot,result.coverage,result.detail]);
        // Keep notification storage bounded while preserving the most recent history.
        await sql.query("DELETE FROM analytics_notifications WHERE owner_id=$1 AND id IN (SELECT id FROM analytics_notifications WHERE owner_id=$1 ORDER BY created_at DESC,id OFFSET 100)",[ownerId]);
      }
    });
  }
  return emitted;
}
