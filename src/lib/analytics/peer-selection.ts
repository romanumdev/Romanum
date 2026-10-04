import { HISTORY_INPUT } from "../history/service.ts";
import { historyDatabase, type Database } from "../history/database.ts";

export const HISTORY_PEERS_INPUT = HISTORY_INPUT;
type Entry = { universe_id: string; name: string; genre: string | null; playing: string; chart_id: string; rank: number; slot: string | Date; observed_at: string | Date };
const normalize = (genre: string | null) => genre?.trim().toLowerCase();

/** Suggestions describe one recorded public chart sample, never an exhaustive market. */
export function rankRecordedPeers(entries: Entry[], universeId: number) {
  const grouped = new Map<number, Entry[]>();
  for (const entry of entries) {
    const id = Number(entry.universe_id), playing = Number(entry.playing);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(playing) || playing < 0) continue;
    const group = grouped.get(id) ?? []; group.push(entry); grouped.set(id, group);
  }
  const target = grouped.get(universeId)?.[0];
  if (!target) return { target: null, peers: [] };
  const result = (entry: Entry) => ({ universeId: Number(entry.universe_id), name: entry.name, genre: entry.genre,
    playing: Number(entry.playing), observedAt: new Date(entry.observed_at).toISOString(),
    placements: (grouped.get(Number(entry.universe_id)) ?? []).map(item => ({ chart: item.chart_id, rank: item.rank, observedAt: new Date(item.observed_at).toISOString() })) });
  const peers = [...grouped.values()].filter(group => Number(group[0].universe_id) !== universeId).map(group => {
    const entry = group[0], sameGenre = Boolean(normalize(target.genre) && normalize(entry.genre) === normalize(target.genre));
    const sizeDistance = Math.abs(Math.log2((Number(entry.playing) + 1) / (Number(target.playing) + 1)));
    return { ...result(entry), sameGenre, similarSize: sizeDistance <= 1, sizeDistance,
      reason: `${sameGenre ? "Same recorded genre" : "Genre differs or is unavailable"}; ${sizeDistance <= 1 ? "within a factor of two on CCU + 1" : "nearest available size fallback"}.` };
  }).sort((a, b) => Number(b.sameGenre) - Number(a.sameGenre) || a.sizeDistance - b.sizeDistance || a.universeId - b.universeId).slice(0, 4);
  return { target: result(target), peers };
}

export function createHistoryPeerService(getDatabase: () => Promise<Database | null> = historyDatabase, now = Date.now) {
  return { async peers(input: unknown) {
    const { universeId, days } = HISTORY_PEERS_INPUT.parse(input);
    const cutoff = new Date(now()).toISOString(), from = new Date(Date.parse(cutoff) - days * 86400000).toISOString();
    const database = await getDatabase();
    const rows = database ? (await database.query<Entry>(`WITH anchor AS (
      SELECT r.id FROM history_runs r JOIN history_chart_entries e ON e.run_id=r.id
      JOIN history_chart_fetches f ON f.run_id=e.run_id AND f.chart_id=e.chart_id
      WHERE e.universe_id=$1 AND NOT e.sponsored AND f.observed_at >= $2 AND f.observed_at <= $3
      ORDER BY r.slot DESC LIMIT 1)
      SELECT e.universe_id,e.name,e.genre,e.playing,e.chart_id,e.rank,r.slot,f.observed_at
      FROM anchor a JOIN history_runs r ON r.id=a.id JOIN history_chart_entries e ON e.run_id=a.id
      JOIN history_chart_fetches f ON f.run_id=e.run_id AND f.chart_id=e.chart_id
      WHERE NOT e.sponsored AND f.observed_at >= $2 AND f.observed_at <= $3
      ORDER BY e.universe_id,e.chart_id`, [universeId, from, cutoff])).rows : [];
    return { available: database !== null, from, cutoff, slot: rows.length ? new Date(rows[0].slot).toISOString() : null,
      ...rankRecordedPeers(rows, universeId), source: "Romanum recorded public Roblox chart sample",
      limitations: ["Suggestions prefer a matching recorded genre, then nearest recorded CCU size. A fallback can differ in genre or size; inspect each reason.", "Only the latest recorded run containing this game in the requested period is considered. Charts are incomplete and retrieval times differ. Suggestions do not establish comparable gameplay or demand.", "Chart CCU is the actual chart sample, separate from the game-stat observations used by history comparisons. No updates, revenue or causes are recorded."] };
  } };
}
export const historyPeerService = createHistoryPeerService();
