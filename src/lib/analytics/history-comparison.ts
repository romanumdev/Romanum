import { z } from "zod";
import { createHistoryService, HISTORY_INPUT } from "../history/service.ts";
import { historyDatabase, type Database } from "../history/database.ts";
import { HISTORY_SOURCE, INTERVAL_SECONDS } from "../history/constants.ts";

export const HISTORY_COMPARISON_INPUT = z.object({
  universeIds: z.array(HISTORY_INPUT.shape.universeId).min(2).max(5)
    .refine((ids) => new Set(ids).size === ids.length, "Choose distinct games."),
  days: HISTORY_INPUT.shape.days,
}).strict();

// A descriptive evidence floor, not statistical confidence or a growth test.
export const HISTORY_COMPARISON_POLICY = Object.freeze({ minimumPairedSlots: 3, minimumOverlapFraction: 0.5 });

const PERIOD = INTERVAL_SECONDS * 1000;
const iso = (time: number) => new Date(time).toISOString();
const span = (times: number[]) => times.length ? { from: iso(Math.min(...times)), to: iso(Math.max(...times)) } : null;
type Observation = { universeId: number; observedAt: string; playing: number; chartRanks: Record<string, number> };
type Sample = Observation & { slot: string };

/** Keep the actual run slot from the existing service's reads, without changing its SQL or response.
 * Flooring observedAt would incorrectly join delayed fetches from different collection runs.
 */
function captureSlots(database: Database) {
  const slotsByObservation = new Map<number, Set<number>>();
  const reader: Database = {
    ...database,
    async query<T>(text: string, values?: unknown[]) {
      const result = await database.query<T>(text, values);
      for (const row of result.rows) {
        if (typeof row !== "object" || row === null || !("slot" in row) || !("observed_at" in row) || row.observed_at === null) continue;
        const observed = new Date(row.observed_at as string | Date).getTime();
        const slot = new Date(row.slot as string | Date).getTime();
        if (!Number.isFinite(observed) || !Number.isFinite(slot) || slot % PERIOD !== 0) continue;
        const slots = slotsByObservation.get(observed) ?? new Set<number>();
        slots.add(slot);
        slotsByObservation.set(observed, slots);
      }
      return result;
    },
  };
  return { reader, slotsByObservation };
}

async function readGame(database: Database | null, universeId: number, days: number, cutoff: number, expectedSlots: number) {
  const capture = database ? captureSlots(database) : null;
  const history = await createHistoryService(async () => capture?.reader ?? null, () => cutoff).history({ universeId, days });
  const from = cutoff - days * 86_400_000;
  if (history.from !== iso(from) || history.to !== iso(cutoff) || history.intervalSeconds !== INTERVAL_SECONDS ||
    history.source !== HISTORY_SOURCE || history.truncated || history.points.length > expectedSlots) {
    throw new Error("History does not match the requested comparison period.");
  }
  const samples = new Map<string, Sample>();
  const gapCounts = { missed: 0, unavailable: 0, notSampled: 0, invalidObservation: 0, ambiguousObservation: 0 };
  const rejectedSlots = new Set<string>();
  for (const point of history.points) {
    if (point.status !== "observed") {
      if (point.status === "missed") gapCounts.missed++;
      else if (point.status === "not_sampled") gapCounts.notSampled++;
      else gapCounts.unavailable++;
      continue;
    }
    const observed = Date.parse(point.observedAt);
    const slots = capture?.slotsByObservation.get(observed);
    if (slots && slots.size > 1) { gapCounts.ambiguousObservation++; continue; }
    const slot = slots?.values().next().value;
    if (!Number.isSafeInteger(point.playing) || point.playing === null || point.playing < 0 ||
      !Number.isFinite(observed) || observed < from || observed > cutoff || slot === undefined ||
      slot < Math.floor(from / PERIOD) * PERIOD || slot > cutoff) {
      gapCounts.invalidObservation++;
      continue;
    }
    const key = iso(slot);
    if (samples.has(key) || rejectedSlots.has(key)) {
      if (samples.delete(key)) gapCounts.ambiguousObservation++;
      rejectedSlots.add(key);
      gapCounts.ambiguousObservation++;
      continue;
    }
    samples.set(key, { slot: key, universeId, observedAt: point.observedAt, playing: point.playing, chartRanks: point.chartRanks });
  }
  const values = [...samples.values()];
  return {
    samples,
    report: {
      universeId,
      status: !history.available ? "unavailable" : !history.game ? "not_recorded" : "recorded",
      game: history.game,
      recordedSpan: span(values.map((point) => Date.parse(point.observedAt))),
      recordedSlotSpan: span(values.map((point) => Date.parse(point.slot))),
      coverage: {
        returnedSlots: history.points.length,
        validSamples: samples.size,
        gaps: history.points.length - samples.size,
        gapCounts,
        requestedSlotsWithoutValidSample: expectedSlots - samples.size,
        validFractionOfRequestedSlots: samples.size / expectedSlots,
      },
    },
  };
}


/** Endpoint changes only, on explicitly matching recorded slots. */
export function observedGrowth(samples: Sample[]) {
  const first = samples[0], last = samples.at(-1);
  if (!first || !last) return null;
  const base = first.playing;
  return {
    first, last, absoluteChange: last.playing - base,
    percentChange: base === 0 ? null : (last.playing - base) / base * 100,
    indexStatus: base === 0 ? "zero_baseline" : "indexed",
    series: samples.map(point => ({ ...point, index: base === 0 ? null : point.playing / base * 100 })),
  };
}

function comparePair(left: Awaited<ReturnType<typeof readGame>>, right: Awaited<ReturnType<typeof readGame>>, expectedSlots: number) {
  const paired = [...left.samples.keys()].filter((slot) => right.samples.has(slot)).sort();
  const union = new Set([...left.samples.keys(), ...right.samples.keys()]).size;
  const overlapFraction = union ? paired.length / union : null;
  const reasons = [];
  if (left.report.status !== "recorded" || right.report.status !== "recorded") reasons.push("history_unavailable_or_game_not_recorded");
  if (paired.length < HISTORY_COMPARISON_POLICY.minimumPairedSlots) reasons.push("too_few_paired_slots");
  if (overlapFraction === null || overlapFraction < HISTORY_COMPARISON_POLICY.minimumOverlapFraction) reasons.push("low_overlap");
  const first = paired.length ? paired[0] : null;
  const last = paired.length ? paired[paired.length - 1] : null;
  const endpoint = (slot: string) => ({ slot, left: left.samples.get(slot)!, right: right.samples.get(slot)! });
  const evidence = paired.map((slot) => endpoint(slot));
  // Means avoid overflowing a sum of safe integer counts; no unpaired samples enter any statistic.
  const mean = (side: "left" | "right") => evidence.reduce((value, point) => value + point[side].playing / evidence.length, 0);
  const leftMean = mean("left"), rightMean = mean("right");
  const difference = evidence.reduce((value, point) => value + (point.left.playing - point.right.playing) / evidence.length, 0);
  return {
    universeIds: [left.report.universeId, right.report.universeId],
    status: reasons.length ? "insufficient_data" : "compared",
    reasons,
    coverage: {
      pairedSlots: paired.length,
      unionValidSlots: union,
      overlapFraction,
      pairedFractionOfRequestedSlots: paired.length / expectedSlots,
      leftUnpairedSamples: left.samples.size - paired.length,
      rightUnpairedSamples: right.samples.size - paired.length,
      pairedSlotSpan: first && last ? { from: first, to: last } : null,
    },
    growth: reasons.length ? null : { left: observedGrowth(evidence.map(point => point.left)), right: observedGrowth(evidence.map(point => point.right)) },
    observedPlayerCounts: reasons.length ? null : {
      leftMean, rightMean, meanDifference: difference,
      minimumDifference: Math.min(...evidence.map((point) => point.left.playing - point.right.playing)),
      maximumDifference: Math.max(...evidence.map((point) => point.left.playing - point.right.playing)),
      first: endpoint(first!), last: endpoint(last!),
      description: `Across ${paired.length} matching recorded slots, universe ${left.report.universeId} averaged ${leftMean.toFixed(2)} observed concurrent players and universe ${right.report.universeId} averaged ${rightMean.toFixed(2)}; the mean left-minus-right difference was ${difference.toFixed(2)} players.`,
    },
  };
}

/** Public persisted history only. One database handle and one cutoff serve every selected game. */
export function createHistoryComparisonService(getDatabase: () => Promise<Database | null> = historyDatabase, now = Date.now) {
  return {
    async compare(input: unknown) {
      const { universeIds, days } = HISTORY_COMPARISON_INPUT.parse(input);
      const cutoff = now();
      const from = cutoff - days * 86_400_000;
      const expectedSlots = Math.floor(cutoff / PERIOD) - Math.floor(from / PERIOD) + 1;
      const database = await getDatabase();
      const games = await Promise.all(universeIds.map((id) => readGame(database, id, days, cutoff, expectedSlots)));
      const pairs = games.flatMap((left, index) => games.slice(index + 1).map((right) => comparePair(left, right, expectedSlots)));
      const compared = pairs.filter((pair) => pair.status === "compared").length;
      const matrix = new Map<string, Observation[]>();
      for (const game of games) for (const { slot, ...observation } of game.samples.values()) {
        const observations = matrix.get(slot) ?? [];
        observations.push(observation);
        matrix.set(slot, observations);
      }
      const slots = [...matrix].sort(([left], [right]) => left.localeCompare(right)).map(([slot, observations]) => ({ slot, observations }));
      const commonSlots = slots.filter((slot) => slot.observations.length === games.length).length;
      const common = slots.filter(slot => slot.observations.length === games.length);
      const sharedReasons = pairs.some(pair => pair.status !== "compared") ? ["pair_evidence_floor_not_met"] : [];
      if (common.length < HISTORY_COMPARISON_POLICY.minimumPairedSlots) sharedReasons.push("too_few_all_game_slots");
      return {
        sameWindow: {
          status: sharedReasons.length ? "insufficient_data" : "compared", reasons: sharedReasons,
          pairedSlots: common.length, span: span(common.map(point => Date.parse(point.slot))),
          games: sharedReasons.length ? [] : games.map(game => ({ universeId: game.report.universeId,
            ...observedGrowth(common.map(point => ({ slot: point.slot, ...point.observations.find(observation => observation.universeId === game.report.universeId)! }))) })),
        },
        available: database !== null,
        status: compared === pairs.length ? "compared" : compared ? "partial" : "insufficient_data",
        metric: { id: "playing", unit: "concurrent_players", differenceDirection: "left_minus_right" },
        source: HISTORY_SOURCE,
        storage: "Romanum recorded public observations",
        from: iso(from), to: iso(cutoff), cutoff: iso(cutoff), intervalSeconds: INTERVAL_SECONDS,
        policy: HISTORY_COMPARISON_POLICY,
        coverage: { requestedSlots: expectedSlots, unionValidSlots: slots.length, allGamesPairedSlots: commonSlots, allGamesPairedFractionOfRequestedSlots: commonSlots / expectedSlots },
        games: games.map((game) => game.report),
        pairs,
        slots,
        annotations: { updates: "not_recorded", discovery: "chartRanks contain only actual recorded non-sponsored chart placements; absence is unknown, not a chart exit." },
        limitations: [
          "Growth describes first-to-last observed CCU on matching slots, not sustained growth. Index 100 uses the first shared observation; a zero baseline has null index and percentage, while absolute change remains available. Updates and reasons for changes are not recorded.",
          "All games use the same requested UTC period and fixed cutoff. Reads are not an atomic database snapshot; an in-flight collector may finish during them.",
          "Slots are the actual five-minute collection runs; observedAt is retrieval time, not Roblox's measurement time. Retrieval times within a run can differ.",
          "Only matching valid observed slots enter pair statistics. Missing, failed, unrecorded and ambiguous observations are never zero-filled or interpolated.",
          "The overlap floor is three paired slots and at least half the union of the pair's valid slots. It does not guarantee full-period coverage or statistical significance; inspect recorded spans and requested-slot coverage.",
          "Requested-slot coverage includes the partial boundary slots. Before collection began and absent games have no backfilled history; a still-open slot without a run is omitted by the history service.",
          "Collection samples selected public chart games and is not all of Roblox. Different pairs can have different observed overlap, reported per pair; their means are not a shared-period ranking.",
          "Observed concurrent-player differences do not establish retention, unique users, revenue, causation or sustained market growth. A short or sparse history supports only its recorded observations.",
        ],
      };
    },
  };
}

export const historyComparisonService = createHistoryComparisonService();
