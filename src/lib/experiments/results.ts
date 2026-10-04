import type { Database } from "../history/database.ts";
import { INTERVAL_SECONDS, HISTORY_SOURCE } from "../history/constants.ts";
import { readExperiment, ExperimentError } from "./store.ts";
import type { Experiment } from "./schema.ts";

const DAY = 86_400_000;
const WINDOW = 7 * DAY;
const SLOT = INTERVAL_SECONDS * 1000;
const EXPECTED = WINDOW / SLOT;
const MIN_COVERAGE = 0.8;
type Gap = "observed" | "missed" | "not_sampled" | "unavailable";
export type ExperimentObservation = { slot: string; observedAt: string | null; playing: number | null; status: Gap };
export type ExperimentResult = {
  status: "available" | "insufficient" | "awaiting_window" | "unavailable";
  reason: "descriptive_change" | "coverage_below_threshold" | "window_not_complete" | "release_date_missing" | "target_game_missing" | "metric_unavailable" | "history_unavailable";
  metric: Experiment["intendedMetric"];
  releaseDate: string | null;
  computedAt: string;
  semantics: { causal: false; source: string; releaseDateSource: "user_entered_utc_calendar_date"; alignment: "same_weekday_and_utc_five_minute_slot"; windowDays: 7; minimumPairedCoverage: number; caveats: string[] };
  windows: { before: { from: string; to: string }; after: { from: string; to: string } } | null;
  coverage: { expectedPerWindow: number; beforeObserved: number; afterObserved: number; paired: number; beforeGaps: number; afterGaps: number };
  freshness: { latestObservedAt: string | null; stale: boolean | null; staleAfterSeconds: number };
  summary: { beforeMeanPlaying: number; afterMeanPlaying: number; absoluteChange: number; percentChange: number | null } | null;
  pairs: { before: ExperimentObservation; after: ExperimentObservation }[];
};
type Row = { slot: Date | string; target_status: string | null; observed_at: Date | string | null; playing: string | number | null };
const iso = (value: number | Date | string) => new Date(value).toISOString();

/** No interpolation or extrapolation: comparisons use the same recorded slots in both weeks. */
export function summarizeExperimentObservations(experiment: Pick<Experiment, "intendedMetric" | "universeId" | "releaseDate">, rows: Row[], latestObservedAt: string | null, now = Date.now()): ExperimentResult {
  const release = experiment.releaseDate ? Date.parse(`${experiment.releaseDate}T00:00:00Z`) : null;
  const result: ExperimentResult = {
    status: "unavailable", reason: "release_date_missing", metric: experiment.intendedMetric, releaseDate: experiment.releaseDate, computedAt: iso(now),
    semantics: { causal: false, source: HISTORY_SOURCE, releaseDateSource: "user_entered_utc_calendar_date", alignment: "same_weekday_and_utc_five_minute_slot", windowDays: 7, minimumPairedCoverage: MIN_COVERAGE, caveats: ["descriptive_not_causal", "public_sample_only", "missing_slots_not_zero", "release_time_unknown", "private_metrics_unavailable"] },
    windows: release === null ? null : { before: { from: iso(release - WINDOW), to: iso(release) }, after: { from: iso(release), to: iso(release + WINDOW) } },
    coverage: { expectedPerWindow: EXPECTED, beforeObserved: 0, afterObserved: 0, paired: 0, beforeGaps: EXPECTED, afterGaps: EXPECTED },
    freshness: { latestObservedAt, stale: latestObservedAt === null ? null : now - Date.parse(latestObservedAt) > 1800_000, staleAfterSeconds: 1800 },
    summary: null, pairs: [],
  };
  if (experiment.intendedMetric !== "public_playing") { result.reason = "metric_unavailable"; return result; }
  if (!experiment.universeId) { result.reason = "target_game_missing"; return result; }
  if (release === null) return result;
  const bySlot = new Map(rows.map(row => [new Date(row.slot).getTime(), row]));
  function point(slot: number): ExperimentObservation {
    const row = bySlot.get(slot);
    const observedAt = row?.observed_at ? iso(row.observed_at) : null;
    const playing = row?.playing === null || row?.playing === undefined ? null : Number(row.playing);
    const valid = observedAt !== null && Date.parse(observedAt) >= slot && Date.parse(observedAt) < slot + SLOT && Date.parse(observedAt) <= now && playing !== null && Number.isSafeInteger(playing) && playing >= 0;
    return { slot: iso(slot), observedAt: valid ? observedAt : null, playing: valid ? playing : null, status: valid ? "observed" : !row ? "missed" : row.target_status ? "unavailable" : "not_sampled" };
  }
  for (let offset = 0; offset < WINDOW; offset += SLOT) {
    const before = point(release - WINDOW + offset);
    const after = point(release + offset);
    result.pairs.push({ before, after });
    if (before.status === "observed") result.coverage.beforeObserved++;
    if (after.status === "observed") result.coverage.afterObserved++;
    if (before.status === "observed" && after.status === "observed") result.coverage.paired++;
  }
  result.coverage.beforeGaps = EXPECTED - result.coverage.beforeObserved;
  result.coverage.afterGaps = EXPECTED - result.coverage.afterObserved;
  if (now < release + WINDOW) { result.status = "awaiting_window"; result.reason = "window_not_complete"; return result; }
  if (result.coverage.paired / EXPECTED < MIN_COVERAGE) { result.status = "insufficient"; result.reason = "coverage_below_threshold"; return result; }
  const matched = result.pairs.filter(pair => pair.before.status === "observed" && pair.after.status === "observed");
  const beforeMeanPlaying = matched.reduce((sum, pair) => sum + pair.before.playing!, 0) / matched.length;
  const afterMeanPlaying = matched.reduce((sum, pair) => sum + pair.after.playing!, 0) / matched.length;
  const absoluteChange = afterMeanPlaying - beforeMeanPlaying;
  result.status = "available"; result.reason = "descriptive_change";
  result.summary = { beforeMeanPlaying, afterMeanPlaying, absoluteChange, percentChange: beforeMeanPlaying === 0 ? null : absoluteChange / beforeMeanPlaying * 100 };
  return result;
}

export async function readExperimentResult(db: Database, ownerId: string, id: string, now = Date.now()): Promise<ExperimentResult> {
  const experiment = await readExperiment(db, ownerId, id);
  if (!experiment) throw new ExperimentError("not_found", "Task not found.");
  if (!experiment.releaseDate || !experiment.universeId || experiment.intendedMetric !== "public_playing") return summarizeExperimentObservations(experiment, [], null, now);
  const release = Date.parse(`${experiment.releaseDate}T00:00:00Z`);
  const { rows } = await db.query<Row>(`SELECT r.slot,t.status AS target_status,o.observed_at,o.playing FROM history_runs r LEFT JOIN history_targets t ON t.run_id=r.id AND t.universe_id=$1 LEFT JOIN history_observations o ON o.run_id=r.id AND o.universe_id=$1 WHERE r.slot >= $2 AND r.slot < $3 ORDER BY r.slot LIMIT 4032`, [experiment.universeId, iso(release - WINDOW), iso(release + WINDOW)]);
  const { rows: latest } = await db.query<{ latest: Date | string | null }>("SELECT max(observed_at) AS latest FROM history_observations WHERE universe_id=$1 AND observed_at <= $2", [experiment.universeId, iso(now)]);
  const result = summarizeExperimentObservations(experiment, rows, latest[0]?.latest ? iso(latest[0].latest) : null, now);
  if (!rows.length && result.status !== "awaiting_window") result.reason = "history_unavailable";
  return result;
}
