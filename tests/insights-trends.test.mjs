import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { analyzeRecordedTrends, createMarketTrendService, TREND_METHOD } from "../src/lib/insights/trends.ts";
import { readCurrentInsight } from "../src/lib/insights/read.ts";

const now = Date.parse("2026-10-03T12:00:30.000Z");
const end = Date.parse("2026-10-03T12:00:00.000Z");
const DAY = 86_400_000, PERIOD = 300_000;
const charts = ["top-playing-now", "top-trending", "up-and-coming", "top-earning"];
const iso = time => new Date(time).toISOString();
const game = (universeId, playing, extra = {}) => ({ universeId, rootPlaceId: universeId * 100,
  rank: universeId, name: `Fixture Obby ${universeId}`, genre: "Adventure", playing, sponsored: false, ...extra });
const row = (slot, chart, entries, extra = {}) => ({ slot: iso(slot), chart_id: chart,
  observed_at: iso(slot + 10_000), status: "complete", rejected: 0, entries, ...extra });
const rowsAt = (slot, games, extra = {}) => charts.map(chart => row(slot, chart, games, extra));
const full = (change = records => records) => Array.from({ length: 288 }, (_, index) => {
  const slot = end - DAY + index * PERIOD;
  return [
    ...change(rowsAt(slot, [game(1, 200), game(2, 40)]), "recent", index),
    ...change(rowsAt(slot - 7 * DAY, [game(1, 100), game(2, 20)]), "baseline", index),
  ];
}).flat();

test("complete matching UTC windows compare only observed chart players with sample competition and concentration", () => {
  const input = full(), before = structuredClone(input);
  const evidence = analyzeRecordedTrends(input, {}, now);
  assert.deepEqual(input, before);
  assert.equal(evidence.status, "compared");
  assert.deepEqual(evidence.reasons, []);
  assert.equal(evidence.comparison.pairedSlots, 288);
  assert.equal(evidence.comparison.stableGames, 2);
  const adventure = evidence.comparison.groups.find(group => group.kind === "genre");
  assert.equal(adventure.recentMeanPlayers, 240);
  assert.equal(adventure.baselineMeanPlayers, 120);
  assert.equal(adventure.differencePlayers, 120);
  assert.equal(adventure.relativeChange, 1);
  assert.equal(evidence.sample.games, 2, "a universe in four charts counts once");
  const group = evidence.sample.groups.find(group => group.kind === "genre");
  assert.equal(group.activity.medianPlayersPerGame, 120);
  assert.equal(group.concentration.largestGameShare, 200 / 240);
  assert.equal(group.competition.sampledGames, 2);
  assert.equal(evidence.saturation.status, "unmeasured");
  assert.equal(evidence.demand.status, "unmeasured");
  assert.equal(evidence.freshness.ageSeconds, 320);
  assert.equal(evidence.freshness.latestCompletedSlotRecorded, true);
  assert.equal(evidence.windows.recent.to, iso(end));
  assert.equal(evidence.windows.baseline.to, iso(end - 7 * DAY));
  assert.equal(new Date(evidence.windows.baseline.from).getUTCDay(), new Date(evidence.windows.recent.from).getUTCDay());
});

test("zero baseline players are real observations, with no infinite percentage or invented concentration", () => {
  const evidence = analyzeRecordedTrends(full((records, window) => window === "baseline"
    ? records.map(record => ({ ...record, entries: record.entries.map(game => ({ ...game, playing: 0 })) })) : records), {}, now);
  assert.equal(evidence.status, "compared");
  assert.ok(evidence.comparison.groups.every(group => group.baselineMeanPlayers === 0 && group.relativeChange === null));
  const zero = analyzeRecordedTrends(full(records => records.map(record => ({ ...record,
    entries: record.entries.map(game => ({ ...game, playing: 0 })) }))), {}, now);
  assert.equal(zero.status, "compared");
  assert.ok(zero.sample.groups.every(group => group.concentration.largestGameShare === null && group.activity.shareOfSamplePlayers === null));
});

test("a sparse pair retains known samples but cannot support a window trend", () => {
  const evidence = analyzeRecordedTrends([
    ...rowsAt(end - PERIOD, [game(1, 200)]), ...rowsAt(end - 7 * DAY - PERIOD, [game(1, 100)]),
  ], {}, now);
  assert.equal(evidence.sample.observedPlayers, 200);
  assert.equal(evidence.comparison.pairedSlots, 1);
  assert.equal(evidence.comparison.fractionOfRequestedSlots, 1 / 288);
  assert.equal(evidence.comparison.groups, null);
  assert.equal(evidence.status, "insufficient_data");
  assert.deepEqual(evidence.reasons, ["incomplete_windows"]);
  assert.match(evidence.summary, /no trend conclusion/);
});

test("missing, partial, failed and duplicate fetches stay distinct from successful empty charts", () => {
  const slot = end - PERIOD;
  const records = [
    row(slot, charts[0], []), row(slot, charts[1], [game(1, 99)], { status: "partial", rejected: 1 }),
    row(slot, charts[2], [], { status: "failed", observed_at: null }),
  ];
  const evidence = analyzeRecordedTrends(records, {}, now);
  assert.equal(evidence.windows.recent.charts[0].empty, 1);
  assert.equal(evidence.windows.recent.charts[1].partial, 1);
  assert.equal(evidence.windows.recent.charts[2].failed, 1);
  assert.equal(evidence.windows.recent.charts[3].missing, 288);
  assert.equal(evidence.sample.games, 0);
  assert.equal(evidence.sample.complete, false);
  assert.equal(evidence.comparison.groups, null);
  const duplicate = analyzeRecordedTrends([...records, records[0]], {}, now);
  assert.equal(duplicate.windows.recent.charts[0].invalid, 1);
  assert.equal(duplicate.sample, null);
});

test("all-empty completed charts are measured coverage but not a measured genre opportunity", () => {
  const evidence = analyzeRecordedTrends(full(records => records.map(record => ({ ...record, entries: [] }))), {}, now);
  assert.equal(evidence.windows.recent.completeSlots, 288);
  assert.equal(evidence.comparison.pairedSlots, 288);
  assert.deepEqual(evidence.reasons, ["no_stable_common_cohort"]);
  assert.equal(evidence.comparison.groups, null);
  assert.deepEqual(evidence.sample.groups, []);
});

test("nonmatching slots and recent-only history never compare unrelated endpoints", () => {
  const records = [
    ...rowsAt(end - PERIOD, [game(1, 200)]), ...rowsAt(end - 7 * DAY - 2 * PERIOD, [game(1, 100)]),
  ];
  const evidence = analyzeRecordedTrends(records, {}, now);
  assert.equal(evidence.comparison.pairedSlots, 0);
  assert.equal(evidence.comparison.groups, null);
  const recentOnly = analyzeRecordedTrends(full().filter(row => Date.parse(row.slot) >= end - DAY), {}, now);
  assert.equal(recentOnly.windows.baseline.recordedSlots, 0);
  assert.equal(recentOnly.sample.observedPlayers, 240);
  assert.equal(recentOnly.comparison.groups, null);
});

test("changing sample membership excludes games rather than mistaking absence for decline or growth", () => {
  const evidence = analyzeRecordedTrends(full((records, window, index) => records.map(record => ({ ...record,
    entries: window === "recent" && index === 287 ? [game(1, 200), game(3, 1000)] : record.entries,
  }))), {}, now);
  assert.equal(evidence.status, "compared");
  assert.equal(evidence.comparison.commonGames, 1);
  assert.equal(evidence.comparison.excludedForMembershipChange, 2);
  assert.equal(evidence.comparison.groups.find(group => group.kind === "genre").differencePlayers, 100);
  assert.deepEqual(evidence.comparison.groups[0].cohortUniverseIds, [1]);
  assert.equal(evidence.sample.observedPlayers, 1200, "latest visible sample stays separate from the fixed cohort");
});

test("recorded genre changes and title-pattern changes cannot become apparent genre growth", () => {
  for (const changed of [{ genre: "Simulation" }, { name: "Fixture Pet 1" }]) {
    const evidence = analyzeRecordedTrends(full((records, window, index) => records.map(record => ({ ...record,
      entries: record.entries.map(game => game.universeId === 1 && window === "recent" && index === 287 ? { ...game, ...changed } : game),
    }))), {}, now);
    assert.equal(evidence.comparison.excludedForClassificationChange, 1);
    assert.equal(evidence.comparison.stableGames, 1);
    assert.ok(evidence.comparison.groups.every(group => !group.cohortUniverseIds.includes(1)));
  }
});

test("changing the preferred measurement chart is not a comparable observation source", () => {
  const evidence = analyzeRecordedTrends(full((records, window, index) => records.map(record => ({ ...record,
    entries: window === "recent" && index === 287 && record.chart_id === charts[0]
      ? record.entries.filter(game => game.universeId !== 1) : record.entries,
  }))), {}, now);
  assert.equal(evidence.comparison.commonGames, 2);
  assert.equal(evidence.comparison.excludedForSourceChange, 1);
  assert.equal(evidence.comparison.stableGames, 1);
  assert.ok(evidence.comparison.groups.every(group => !group.cohortUniverseIds.includes(1)));
});

test("invalid counts, IDs, rank collisions, sponsored entries and delayed timestamps invalidate a chart slot", () => {
  for (const changed of [
    { entries: [game(1, -1)] }, { entries: [game(1, NaN)] }, { entries: [game(1, Number.MAX_SAFE_INTEGER + 1)] },
    { entries: [game(0, 1)] }, { entries: [game(1, 1, { sponsored: true })] },
    { entries: [game(1, 1), game(1, 2)] }, { entries: [game(1, 1), game(2, 2, { rank: 1 })] },
    { observed_at: iso(end) }, { observed_at: "invalid" },
    { entries: Array.from({ length: 11 }, (_, i) => game(i + 1, 10)) },
  ]) {
    const records = rowsAt(end - PERIOD, [game(1, 20)]);
    records[0] = { ...records[0], ...changed };
    const evidence = analyzeRecordedTrends(records, {}, now);
    assert.equal(evidence.windows.recent.charts[0].invalid, 1);
    assert.equal(evidence.sample.complete, false);
    assert.equal(evidence.comparison.groups, null);
  }
});

test("observations retain chart times and Top Playing Now priority; the open slot and old samples are not refreshed", () => {
  const records = rowsAt(end - 2 * PERIOD, [game(1, 20)]);
  records[1] = { ...records[1], observed_at: iso(end - 2 * PERIOD + 20_000), entries: [game(1, 99)] };
  const evidence = analyzeRecordedTrends([...records, ...rowsAt(end, [game(1, 1000)])], {}, now);
  assert.equal(evidence.sample.slot, iso(end - 2 * PERIOD));
  assert.equal(evidence.sample.observedPlayers, 20);
  assert.equal(evidence.freshness.latestObservedAt, records[1].observed_at);
  assert.equal(evidence.freshness.ageSeconds, 610);
  assert.equal(evidence.freshness.latestCompletedSlotRecorded, false);
});

test("storage unavailable differs from empty history and input validation happens before reads", async () => {
  const missing = await createMarketTrendService(async () => null, () => now).analyze();
  assert.equal(missing.available, false);
  assert.ok(missing.reasons.includes("storage_unavailable"));
  assert.equal(missing.freshness.ageSeconds, null);
  assert.equal(missing.sample, null);
  const empty = await createMarketTrendService(async () => ({ query: async () => ({ rows: [] }) }), () => now).analyze();
  assert.equal(empty.available, true);
  assert.ok(!empty.reasons.includes("storage_unavailable"));
  const invalid = createMarketTrendService(async () => assert.fail("invalid request accessed database"));
  for (const input of [{ days: 0 }, { days: 8 }, { days: 1.5 }, { days: "1" }, { social: true }]) {
    await assert.rejects(invalid.analyze(input));
  }
});

test("bounded read cache shares concurrent work per database/slot, advances with slots and retries outages", async () => {
  let clock = now, reads = 0, fail = false;
  const database = { query: async (sql, values) => {
    reads++;
    assert.match(sql, /^SELECT /);
    assert.match(sql, /c\.name,'genre',c\.genre/);
    assert.match(sql, /NOT c\.sponsored/);
    assert.equal(values[5], 10);
    assert.equal(values[6], 2 * 288 * 4 + 1);
    if (fail) throw new Error("fixture database outage");
    return { rows: [] };
  } };
  const service = createMarketTrendService(async () => database, () => clock);
  await Promise.all([service.analyze(), service.analyze()]);
  assert.equal(reads, 1);
  clock += 50_000;
  await service.analyze();
  assert.equal(reads, 1);
  clock += PERIOD;
  fail = true;
  await assert.rejects(service.analyze(), /fixture database outage/);
  fail = false;
  await service.analyze();
  assert.equal(reads, 3);
});

test("SQL reads real stored dated names/genres, bounds each chart, and excludes sponsored entries", async t => {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  await engine.exec(readFileSync(new URL("../db/migrations/001_history.sql", import.meta.url), "utf8"));
  const slot = end - PERIOD;
  const runId = "00000000-0000-4000-8000-000000000001";
  await engine.query("INSERT INTO history_runs(id,slot,started_at,finished_at,status) VALUES ($1,$2,$2,$3,'complete')", [runId, iso(slot), iso(slot + 15_000)]);
  await engine.query("INSERT INTO history_chart_fetches(run_id,chart_id,observed_at,status) SELECT $1,unnest($2::text[]),$3,'complete'", [runId, charts, iso(slot + 10_000)]);
  for (let id = 1; id <= 13; id++) {
    await engine.query("INSERT INTO history_games(universe_id,root_place_id,name,first_seen,last_seen) VALUES ($1,$2,'Current renamed pet',$3,$3)", [id, id * 100, iso(slot)]);
    await engine.query("INSERT INTO history_chart_entries(run_id,chart_id,universe_id,rank,name,genre,playing,sponsored) VALUES ($1,$2,$3,$7,$4,'Adventure',$5,$6)",
      [runId, charts[0], id, `Recorded Obby ${id}`, id * 10, id === 1, id]);
  }
  let reads = 0;
  const reader = { query: async (sql, values) => { reads++; assert.match(sql, /^SELECT /); return engine.query(sql, values); } };
  const result = await createMarketTrendService(async () => reader, () => now).analyze();
  assert.equal(reads, 1);
  assert.equal(result.sample.games, TREND_METHOD.gamesPerChart);
  assert.equal(result.sample.observedPlayers, 650);
  const group = result.sample.groups[0];
  assert.equal(group.label, "Adventure");
  assert.equal(group.representatives[0].name, "Recorded Obby 11");
  assert.equal(group.representatives[0].rootPlaceId, 1100);
  assert.ok(!JSON.stringify(result).includes("Current renamed pet"));
  assert.equal(result.windows.recent.charts[1].empty, 1);
  assert.equal(result.comparison.groups, null);
});

test("live insight enrichment is read-only and falls back to the saved insight if trend reads fail", async () => {
  const content = { recommendations: [{ title: "Fixture Idea", reason: "Prototype an obstacle game with shared rescue ropes." }],
    radar: [], dataAt: iso(now), generatedAt: iso(now) };
  const saved = { day: "2026-10-03", content };
  const database = { query: async sql => { assert.match(sql, /^SELECT day::text/); return { rows: [saved] }; } };
  const evidence = analyzeRecordedTrends(full(), {}, now);
  const enriched = await readCurrentInsight(database, new Date(now), { analyze: async () => evidence });
  assert.deepEqual(enriched.insight.content, saved.content);
  assert.deepEqual(enriched.insight.trendEvidence, evidence);
  assert.equal(enriched.today, saved.day);
  const fallback = await readCurrentInsight(database, new Date(now), { analyze: async () => { throw new Error("outage"); } });
  assert.deepEqual(fallback.insight, saved);
});

function viewHooks() {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "next/link") return nextResolve("next/link.js", context);
      let target;
      if (specifier.startsWith("@/")) target = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
      else if (specifier.startsWith(".") && context.parentURL?.startsWith(new URL("../src/", import.meta.url).href)) target = new URL(specifier, context.parentURL);
      if (target && !existsSync(fileURLToPath(target))) {
        for (const extension of [".ts", ".tsx"]) {
          if (existsSync(fileURLToPath(`${target.href}${extension}`))) return nextResolve(`${target.href}${extension}`, context);
        }
      }
      return nextResolve(target?.href ?? specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && url.endsWith(".tsx")) return { format: "module", shortCircuit: true,
        source: ts.transpileModule(`import React from "react";\n${readFileSync(fileURLToPath(url), "utf8")}`, {
          compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
        }).outputText };
      return nextLoad(url, context);
    },
  });
}

test("the insight card keeps trend detail under Evidence and sources with dated coverage and no opportunity score", async () => {
  const hooks = viewHooks();
  try {
    const { RomanumInsight } = await import(new URL("../src/components/market/romanum-insight.tsx", import.meta.url).href);
    const evidence = analyzeRecordedTrends(full(), {}, now);
    const render = evidence => renderToStaticMarkup(createElement(RomanumInsight, {
      initial: { day: "2026-10-03", content: {
        recommendations: [{ title: "Fixture Idea", reason: "Prototype an obstacle game with shared rescue ropes." }],
        radar: [], dataAt: iso(now), generatedAt: iso(now),
      }, trendEvidence: evidence }, today: "2026-10-03", connected: false, fitRow: false,
    }));
    const markup = render(evidence);
    const detailsStart = markup.search(/<details\b[^>]*>\s*<summary\b[^>]*>Evidence and sources<\/summary>/);
    assert.ok(detailsStart >= 0);
    const details = markup.slice(detailsStart);
    assert.ok(!markup.slice(0, detailsStart).includes("Recorded chart activity"));
    assert.match(details, /Recorded chart activity/);
    assert.match(details, /288\/288 matching complete slots/);
    assert.match(details, /median 120, largest-game share 83\.3%/);
    assert.match(details, /240 vs 120 average observed players across the same 2 sampled games/);
    assert.match(details, /unmet demand, saturation and causes remain unknown/);
    assert.match(details, /No social activity is measured/);
    const sparse = render(analyzeRecordedTrends([], {}, now));
    assert.match(sparse, /no trend conclusion yet/);
    assert.ok(!sparse.includes("average observed players"));
  } finally { hooks.deregister(); }
});
