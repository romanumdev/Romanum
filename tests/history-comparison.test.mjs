import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryComparisonService, HISTORY_COMPARISON_INPUT } from "../src/lib/analytics/history-comparison.ts";

const base = Date.parse("2026-10-01T00:00:00Z");
const period = 300_000;
const iso = time => new Date(time).toISOString();
const run = (index, players, extra = {}) => ({ slot: base + index * period, players, ...extra });

// No connections or writes: this fixture supplies the existing history service's three SELECTs.
function fixture(runs, knownIds = [1, 2, 3, 4, 5]) {
  const reads = [];
  const database = {
    async query(text, values) {
      reads.push({ text, values });
      assert.match(text, /^SELECT /);
      if (text.startsWith("SELECT * FROM history_games")) {
        const id = values[0];
        return { rows: knownIds.includes(id) ? [{ universe_id: String(id), root_place_id: String(id * 100), name: `Fixture ${id}`, icon_url: null }] : [] };
      }
      if (text.startsWith("SELECT min(slot)")) return { rows: [{ first: runs.length ? iso(Math.min(...runs.map(run => run.slot))) : null }] };
      assert.match(text, /^SELECT r\.slot/);
      const [id, from, to, first] = values;
      return { rows: runs.filter(run => run.slot >= Date.parse(first) && run.slot <= Date.parse(to)).sort((a, b) => a.slot - b.slot).map(run => {
        const value = run.players[id];
        const observedAt = run.observedAt?.[id] ?? run.slot + 15_000 + id * 1000;
        const observed = value !== undefined && observedAt >= Date.parse(from) && observedAt <= Date.parse(to);
        return { slot: iso(run.slot), run_status: run.status ?? "complete", observed_at: observed ? iso(observedAt) : null,
          playing: observed ? value : null, visits: null, favorites: null, likes: null, dislikes: null,
          target_status: observed ? "observed" : run.unavailable?.includes(id) ? "unavailable" : null, chart_ranks: {} };
      }) };
    },
    exec() { assert.fail("Comparison must not write."); },
    transaction() { assert.fail("Comparison must not start write transactions."); },
    close() { assert.fail("Comparison must not close a shared database."); },
  };
  let connections = 0, clockReads = 0;
  const service = createHistoryComparisonService(async () => { connections++; return database; }, () => { clockReads++; return base + 40 * 60_000 + clockReads; });
  return { service, reads, counts: () => ({ connections, clockReads }) };
}

test("real zeros are valid; missing, failed and skipped slots remain gaps", async () => {
  const { service } = fixture([
    run(0, { 1: 0, 2: 10 }), run(1, { 1: 10, 2: 20 }), run(2, { 1: 20, 2: 30 }),
    run(3, { 1: 0 }, { unavailable: [2] }), run(4, {}, { status: "failed" }), run(6, {}),
  ]);
  const result = await service.compare({ universeIds: [1, 2] });
  assert.equal(result.status, "compared");
  const pair = result.pairs[0];
  assert.equal(pair.coverage.pairedSlots, 3);
  assert.equal(pair.coverage.leftUnpairedSamples, 1);
  assert.equal(pair.observedPlayerCounts.leftMean, 10);
  assert.equal(pair.observedPlayerCounts.rightMean, 20);
  assert.equal(pair.observedPlayerCounts.meanDifference, -10);
  assert.equal(pair.observedPlayerCounts.first.left.playing, 0);
  assert.equal(result.games[0].coverage.validSamples, 4);
  assert.deepEqual(result.games[1].coverage.gapCounts, { missed: 2, unavailable: 2, notSampled: 1, invalidObservation: 0, ambiguousObservation: 0 });
  assert.equal(result.games[1].coverage.gaps, 5);
  assert.equal(result.slots.find(slot => slot.slot === iso(base + 3 * period)).observations.length, 1);
  assert.ok(result.slots.every(slot => slot.observations.every(point => point.playing !== null)));
});

test("nonoverlapping recordings cannot produce a comparison", async () => {
  const { service } = fixture([run(0, { 1: 100 }), run(1, { 1: 110 }), run(2, { 1: 120 }), run(3, { 2: 1 }), run(4, { 2: 2 }), run(5, { 2: 3 })]);
  const result = await service.compare({ universeIds: [1, 2] });
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.pairs[0].observedPlayerCounts, null);
  assert.equal(result.pairs[0].coverage.pairedSlots, 0);
  assert.equal(result.pairs[0].coverage.pairedSlotSpan, null);
  assert.deepEqual(result.pairs[0].reasons, ["too_few_paired_slots", "low_overlap"]);
  assert.notDeepEqual(result.games[0].recordedSpan, result.games[1].recordedSpan);
});

test("unequal coverage uses the union denominator and refuses sparse overlap", async () => {
  const { service } = fixture(Array.from({ length: 8 }, (_, i) => run(i, { 1: 50, ...(i < 3 ? { 2: 20 } : {}) })));
  const result = await service.compare({ universeIds: [1, 2] });
  assert.equal(result.pairs[0].coverage.overlapFraction, 3 / 8);
  assert.equal(result.pairs[0].coverage.pairedFractionOfRequestedSlots, 3 / 289);
  assert.equal(result.pairs[0].observedPlayerCounts, null);
  assert.deepEqual(result.pairs[0].reasons, ["low_overlap"]);
  assert.equal(result.games[1].coverage.requestedSlotsWithoutValidSample, 286);
});

test("the policy boundaries accept half-overlap and reject fewer than three pairs", async () => {
  const { service } = fixture(Array.from({ length: 6 }, (_, i) => run(i, { 1: 50, ...(i < 3 ? { 2: 20 } : {}) })));
  assert.equal((await service.compare({ universeIds: [1, 2] })).pairs[0].status, "compared");
  const small = fixture([run(0, { 1: 0, 2: 0 }), run(1, { 1: 0, 2: 0 })]);
  const pair = (await small.service.compare({ universeIds: [1, 2] })).pairs[0];
  assert.equal(pair.coverage.overlapFraction, 1);
  assert.equal(pair.observedPlayerCounts, null);
  assert.deepEqual(pair.reasons, ["too_few_paired_slots"]);
});

test("one cutoff and database handle cover all five games, even if the clock changes", async () => {
  const fixtureData = fixture([run(0, { 1: 10, 2: 20, 3: 30, 4: 40, 5: 50 }), run(1, { 1: 20, 2: 30, 3: 40, 4: 50, 5: 60 }), run(2, { 1: 30, 2: 40, 3: 50, 4: 60, 5: 70 })]);
  const result = await fixtureData.service.compare({ universeIds: [1, 2, 3, 4, 5], days: 30 });
  assert.deepEqual(fixtureData.counts(), { connections: 1, clockReads: 1 });
  assert.equal(result.pairs.length, 10);
  assert.equal(result.status, "compared");
  assert.equal(result.coverage.requestedSlots, 8641);
  assert.equal(result.coverage.allGamesPairedSlots, 3);
  const requests = fixtureData.reads.filter(read => read.text.startsWith("SELECT r.slot"));
  assert.equal(requests.length, 5);
  assert.ok(requests.every(read => read.values[1] === result.from && read.values[2] === result.cutoff));
  assert.equal(result.to, result.cutoff);
  assert.equal(result.source, "https://games.roblox.com/v1/games");
  assert.match(result.limitations.join(" "), /not an atomic database snapshot/);
  assert.match(result.limitations.join(" "), /retention.*causation.*sustained market growth/);
});

test("actual slots pair delayed retrievals and distinguish different runs in the same time bucket", async () => {
  const delayed = fixture([0, 1, 2].map(i => run(i, { 1: 10, 2: 20 }, { observedAt: { 1: base + i * period + 1000, 2: base + (i + 1) * period + 2000 } })));
  const paired = (await delayed.service.compare({ universeIds: [1, 2] })).pairs[0];
  assert.equal(paired.status, "compared");
  assert.equal(paired.coverage.pairedSlots, 3);
  assert.equal(paired.observedPlayerCounts.first.slot, iso(base));
  assert.equal(paired.observedPlayerCounts.first.right.observedAt, iso(base + period + 2000));
  const separate = fixture([run(0, { 1: 10 }, { observedAt: { 1: base + period + 1000 } }), run(1, { 2: 20 })]);
  assert.equal((await separate.service.compare({ universeIds: [1, 2] })).pairs[0].coverage.pairedSlots, 0);
});

test("ambiguous timestamps and invalid numeric observations are excluded, never coerced", async () => {
  const { service } = fixture([
    run(0, { 1: -1, 2: 5 }), run(1, { 1: null, 2: 5 }), run(2, { 1: NaN, 2: 5 }),
    run(3, { 1: 1.5, 2: 5 }), run(4, { 1: Number.MAX_SAFE_INTEGER + 1, 2: 5 }),
    run(5, { 1: 10, 2: 5 }, { observedAt: { 1: base + 7 * period } }),
    run(6, { 1: 10, 2: 5 }, { observedAt: { 1: base + 7 * period } }),
  ]);
  const result = await service.compare({ universeIds: [1, 2] });
  assert.equal(result.games[0].coverage.validSamples, 0);
  assert.equal(result.games[0].coverage.gapCounts.invalidObservation, 5);
  assert.equal(result.games[0].coverage.gapCounts.ambiguousObservation, 2);
  assert.equal(result.pairs[0].observedPlayerCounts, null);
});

test("partially comparable selections report individual pair periods without a pooled ranking", async () => {
  const { service } = fixture([run(0, { 1: 10, 2: 20 }), run(1, { 1: 10, 2: 20 }), run(2, { 1: 10, 2: 20 }), run(3, { 3: 50 })]);
  const result = await service.compare({ universeIds: [1, 2, 3] });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.pairs.map(pair => pair.status), ["compared", "insufficient_data", "insufficient_data"]);
  assert.equal(result.coverage.allGamesPairedSlots, 0);
  assert.equal(result.pairs[1].observedPlayerCounts, null);
});

test("future and out-of-window observations never enter the comparison", async () => {
  const cutoff = base + 40 * 60_000 + 1;
  const { service } = fixture([run(-290, { 1: 99, 2: 99 }), run(0, { 1: 0, 2: 0 }), run(8, { 1: 99, 2: 99 }, { observedAt: { 1: cutoff + 1, 2: cutoff + 1 } }), run(9, { 1: 99, 2: 99 })]);
  const result = await service.compare({ universeIds: [1, 2] });
  assert.equal(result.games[0].coverage.validSamples, 1);
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].observations[0].playing, 0);
});

test("missing storage, unrecorded games and an empty recorded period have honest results", async () => {
  const offline = createHistoryComparisonService(async () => null, () => base);
  const result = await offline.compare({ universeIds: [1, 2] });
  assert.equal(result.available, false);
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.games[0].recordedSpan, null);
  assert.equal(result.pairs[0].coverage.overlapFraction, null);
  assert.equal(result.pairs[0].observedPlayerCounts, null);
  const unknown = fixture([run(0, { 1: 1 })], [1]);
  const missing = await unknown.service.compare({ universeIds: [1, 2] });
  assert.equal(missing.games[1].status, "not_recorded");
  const empty = fixture([]);
  assert.equal((await empty.service.compare({ universeIds: [1, 2] })).games[0].recordedSpan, null);
});

test("bounded invalid inputs fail before touching clock or storage", async () => {
  const service = createHistoryComparisonService(() => assert.fail("Invalid input reached storage."), () => assert.fail("Invalid input read the clock."));
  for (const input of [
    {}, { universeIds: [1] }, { universeIds: [1, 2, 3, 4, 5, 6] }, { universeIds: [1, 1] },
    { universeIds: [0, 2] }, { universeIds: [-1, 2] }, { universeIds: [1.5, 2] },
    { universeIds: ["1", 2] }, { universeIds: [Number.MAX_SAFE_INTEGER + 1, 2] },
    ...[0, 31, 1.5, "1", null].map(days => ({ universeIds: [1, 2], days })),
    { universeIds: [1, 2], cutoff: iso(base) }, { universeIds: [1, 2], ownerId: "private" },
  ]) await assert.rejects(service.compare(input));
  assert.equal(HISTORY_COMPARISON_INPUT.parse({ universeIds: [1, Number.MAX_SAFE_INTEGER] }).days, 1);
});

test("the complete thirty-day five-game bound retains every observed boundary slot", async () => {
  const runs = Array.from({ length: 8641 }, (_, index) => {
    const slotIndex = index - 8632;
    return run(slotIndex, { 1: 0, 2: 10, 3: 20, 4: 30, 5: 40 }, {
      observedAt: Object.fromEntries([1, 2, 3, 4, 5].map(id => [id, base + slotIndex * period + 1])),
    });
  });
  const { service } = fixture(runs);
  const result = await service.compare({ universeIds: [1, 2, 3, 4, 5], days: 30 });
  assert.equal(result.coverage.requestedSlots, 8641);
  assert.equal(result.coverage.allGamesPairedSlots, 8641);
  assert.equal(result.slots.length, 8641);
  assert.equal(result.slots.flatMap(slot => slot.observations).length, 43_205);
  assert.equal(result.status, "compared");
  assert.ok(result.games.every(game => game.coverage.validSamples === 8641 && game.coverage.gaps === 0));
  assert.ok(result.pairs.every(pair => pair.coverage.pairedFractionOfRequestedSlots === 1 && pair.coverage.overlapFraction === 1));
  assert.equal(result.pairs[0].observedPlayerCounts.meanDifference.toFixed(6), "-10.000000");
  assert.equal(result.games[0].recordedSpan.from, result.from);
  assert.equal(result.games[0].recordedSpan.to, result.cutoff);
});


test("growth uses shared endpoints, preserves zero baselines and refuses sparse evidence", async () => {
  const { service } = fixture([run(0, { 1: 0, 2: 10 }), run(1, { 1: 10, 2: 15 }), run(2, { 1: 20, 2: 20 }), run(3, { 1: 999 })]);
  const result = await service.compare({ universeIds: [1, 2] });
  assert.equal(result.sameWindow.status, "compared");
  const [left, right] = result.sameWindow.games;
  assert.equal(left.absoluteChange, 20);
  assert.equal(left.percentChange, null);
  assert.equal(left.indexStatus, "zero_baseline");
  assert.ok(left.series.every(point => point.index === null));
  assert.equal(right.percentChange, 100);
  assert.deepEqual(right.series.map(point => point.index), [100, 150, 200]);
  assert.equal(right.first.slot, result.pairs[0].growth.right.first.slot);
  assert.equal(left.series.length, 3);
  assert.deepEqual(left.series[0].chartRanks, {});
  const sparse = await fixture([run(0, { 1: 0, 2: 0 })]).service.compare({ universeIds: [1, 2] });
  assert.deepEqual(sparse.sameWindow.games, []);
  assert.equal(sparse.pairs[0].growth, null);
});
