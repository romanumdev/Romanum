import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { analyzeMarket } from "../src/lib/market-analysis.ts";
import { evidenceRecommendations, recommendationMarket, renderDesignProposal } from "../src/lib/insights/evidence.ts";

const assembledAt = "2026-10-02T10:00:00.000Z";
const fetchedAt = "2026-10-02T09:59:00.000Z";
const expiresAt = "2026-10-02T10:01:00.000Z";
const charts = ["top-playing-now", "top-trending", "up-and-coming", "top-earning"];
const game = (universeId, extra = {}) => ({
  universeId, rootPlaceId: universeId + 100, name: `Fixture Obby ${universeId}`,
  rank: 1, playing: 50, genre: "Adventure", sponsored: false, ...extra,
});
function market(rows = [[game(1)], [], null, [game(2)]], observations) {
  const samples = charts.map((chart, i) => ({ chart, games: rows[i] }));
  return {
    samples, analysis: analyzeMarket(samples, assembledAt),
    observations: observations ?? samples.flatMap((sample) => sample.games === null ? [] : [{ chart: sample.chart, fetchedAt, expiresAt }]),
  };
}
const draft = (extra = {}) => ({
  title: "Lava Team Rescue", proposal: { coreAction: "rescue teammates on an obstacle course", variation: "shared rescue ropes" },
  researchTerms: ["team obstacle rescue", "rescue ropes"],
  evidenceRefs: [{ chart: "top-playing-now", universeId: 1 }], ...extra,
});
const proposal = (...ideas) => async () => ({ recommendations: ideas });
const searchGame = (id, extra = {}) => ({
  universeId: id, rootPlaceId: id + 100, name: `Candidate ${id}`,
  playing: 5, likes: 2, dislikes: 0, sponsored: false, ...extra,
});
const emptySearch = { search: async () => ({ fetchedAt, games: [] }) };
const neverSearch = { search: async () => assert.fail("invalid evidence must not search") };

test("digest retains distinct retrieval times, game IDs, empty and unavailable charts; assembly is separate", () => {
  const earlier = "2026-10-02T09:45:00.000Z";
  const prepared = recommendationMarket(market(undefined, [
    { chart: charts[0], fetchedAt, expiresAt },
    { chart: charts[1], fetchedAt, expiresAt },
    { chart: charts[3], fetchedAt: earlier, expiresAt: "2026-10-02T09:47:00.000Z" },
  ]));
  assert.equal(prepared.dataAt, earlier);
  assert.notEqual(prepared.dataAt, assembledAt);
  assert.equal(prepared.digest.assembledAt, assembledAt);
  assert.deepEqual(prepared.digest.charts.map((chart) => [chart.chart, chart.status, chart.stale]), [
    [charts[0], "available", false], [charts[1], "empty", false],
    [charts[2], "unavailable", false], [charts[3], "available", true],
  ]);
  assert.deepEqual(prepared.digest.observations.map((item) => [item.universeId, item.rootPlaceId, item.fetchedAt]), [
    [1, 101, fetchedAt], [2, 102, earlier],
  ]);
  assert.equal(prepared.digest.charts[2].fetchedAt, null);
  assert.ok(!("fetchedAt" in prepared.digest), "assembly must not be relabelled as retrieval");
});

test("verified evidence copies retrieved values, preserves per-chart observations and researches before finalizing", async () => {
  const calls = [];
  const input = market([[game(1)], [game(1, { playing: 12 })], null, []]);
  const result = await evidenceRecommendations(input, async (digest) => {
    calls.push("model");
    assert.equal(digest.observations.length, 2);
    return { recommendations: [draft({ evidenceRefs: [
      { chart: charts[0], universeId: 1 }, { chart: charts[1], universeId: 1 }, { chart: charts[0], universeId: 1 },
    ] })] };
  }, { search: async (query) => {
    calls.push(query);
    return { fetchedAt, games: [searchGame(9, { sponsored: true }), searchGame(9)] };
  } });
  assert.deepEqual(calls, ["model", "Lava Team Rescue", "team obstacle rescue", "rescue ropes"]);
  const idea = result.recommendations[0];
  assert.deepEqual(idea.evidence.map((item) => [item.chart, item.playing]), [[charts[0], 50], [charts[1], 12]]);
  assert.equal(idea.reason, renderDesignProposal(draft().proposal));
  assert.deepEqual(idea.proposal, draft().proposal);
  assert.equal(idea.research.status, "complete");
  assert.equal(idea.research.games.length, 1);
  assert.equal(idea.research.games[0].fetchedAt, fetchedAt);
  assert.deepEqual(idea.research.games[0].matchedQueries, calls.slice(1));
  assert.ok(!("iconUrl" in idea.research.games[0]), "only bounded public evidence fields are stored");
  assert.ok(!("novel" in idea.research));
});

test("invented, cross-chart, unavailable, sponsored and out-of-digest references fail before research", async () => {
  const input = market([
    [game(1), game(90, { sponsored: true }), ...Array.from({ length: 10 }, (_, i) => game(i + 2))],
    [], null, [],
  ]);
  assert.equal(recommendationMarket(input).digest.observations.length, 10);
  for (const ref of [
    { chart: charts[0], universeId: 999 }, { chart: charts[1], universeId: 1 },
    { chart: charts[2], universeId: 1 }, { chart: charts[0], universeId: 90 },
    { chart: charts[0], universeId: 11 },
  ]) {
    await assert.rejects(evidenceRecommendations(input, proposal(draft({ evidenceRefs: [ref] })), neverSearch), /not retrieved/);
  }
  await assert.rejects(evidenceRecommendations(input, proposal(draft(), draft({
    title: "Invalid Other Idea", evidenceRefs: [{ chart: charts[0], universeId: 999 }],
  })), neverSearch), /not retrieved/, "all drafts must be checked before searching even the valid one");
  for (const extra of [{ rootPlaceId: 666 }, { url: "https://invented.example" }, { fetchedAt: assembledAt }]) {
    await assert.rejects(evidenceRecommendations(input, proposal(draft({
      evidenceRefs: [{ chart: charts[0], universeId: 1, ...extra }],
    })), neverSearch));
  }
});

test("unsupported rise, open-genre, competitor and novelty claims are rejected", async () => {
  for (const hypothesis of [
    "Obbies are rising, so test a cooperative rescue course.",
    "An open genre makes this rescue game worth testing.",
    "Few competitors pair these mechanics with rescue ropes.",
    "This original concept guarantees a unique game.",
    "Trending games prove demand for this obstacle course.",
  ]) {
    await assert.rejects(evidenceRecommendations(market(), proposal(draft({ proposal: { ...draft().proposal, coreAction: hypothesis } })), neverSearch), /Unsupported claim/);
  }
  const design = await evidenceRecommendations(market(), proposal(draft({
    proposal: { coreAction: "grow gardens on rising platforms", variation: "a first-place race" },
  })), emptySearch);
  assert.equal(design.recommendations.length, 1, "growth and rising platforms can describe proposed mechanics");
});

test("model-written factual reasons and quantified metric claims are rejected before research", async () => {
  const fabricated = "These experiences have a 99% click-through rate, so test rescue ropes.";
  for (const extra of [{ hypothesis: fabricated }, { reason: fabricated }, { measuredCtr: 0.99 }]) {
    await assert.rejects(evidenceRecommendations(market(), proposal(draft(extra)), neverSearch));
  }
  for (const title of ["99% CTR Obby", "99 percent CTR", "Guaranteed Rescue"]) {
    await assert.rejects(evidenceRecommendations(market(), proposal(draft({ title })), neverSearch));
  }
  for (const claim of [
    "have a 99% click-through rate", "99 percent CTR", "achieve 99 per cent click-through",
    "earn 10000 Robux daily", "retain 90 percent of players", "reach 2000 CCU",
    "have 2 million visits", "99% of users click thumbnails", "session length of 20 minutes", "99\uff05 \uff23\uff34\uff32",
  ]) {
    for (const field of ["coreAction", "variation"]) {
      await assert.rejects(evidenceRecommendations(market(), proposal(draft({
        proposal: { ...draft().proposal, [field]: claim },
      })), neverSearch), /Unsupported claim/);
    }
  }
  const valid = await evidenceRecommendations(market(), proposal(draft({
    title: "+1 Rope Rescuers",
    proposal: { coreAction: "choose between 2 rescue routes", variation: "shared rescue ropes" },
  })), emptySearch);
  assert.equal(valid.recommendations[0].reason, "Prototype a game where players choose between 2 rescue routes, using shared rescue ropes.");
  assert.equal(valid.recommendations[0].evidence[0].playing, 50, "measured values come from the verified observation only");
  const trading = await evidenceRecommendations(market(), proposal(draft({
    proposal: { coreAction: "trade at a player market", variation: "a travelling magic show" },
  })), emptySearch);
  assert.equal(trading.recommendations.length, 1, "design settings are not rejected merely for words also used in analytics");
});

test("missing and empty evidence cannot finalize a structured design proposal", async () => {
  const missing = draft();
  delete missing.evidenceRefs;
  await assert.rejects(evidenceRecommendations(market(), proposal(missing), neverSearch));
  await assert.rejects(evidenceRecommendations(market(), proposal(draft({ evidenceRefs: [] })), neverSearch));
});

test("all unavailable, all empty and undated charts refuse generation before any model or search", async () => {
  for (const input of [market([null, null, null, null]), market([[], [], [], []]), market(undefined, [])]) {
    await assert.rejects(evidenceRecommendations(input, async () => assert.fail("no data must not call a model"), neverSearch), /No usable market/);
  }
  const mixed = await evidenceRecommendations(market([[game(1)], null, [], null]), proposal(draft()), emptySearch);
  assert.equal(mixed.recommendations.length, 1);
  assert.deepEqual(mixed.marketEvidence.charts.map((chart) => chart.status), ["available", "unavailable", "empty", "unavailable"]);
});

test("empty searches remain distinct from outages without exposing error details or claiming novelty", async () => {
  const partial = await evidenceRecommendations(market(), proposal(draft()), {
    search: async (query) => {
      if (query === "rescue ropes") throw new Error("private upstream diagnostics");
      return { fetchedAt, games: [] };
    },
  });
  const research = partial.recommendations[0].research;
  assert.equal(research.status, "partial");
  assert.deepEqual(research.searches.map((search) => [search.status, search.fetchedAt, search.resultCount]), [
    ["complete", fetchedAt, 0], ["complete", fetchedAt, 0], ["unavailable", null, null],
  ]);
  assert.equal(research.games.length, 0);
  assert.ok(!JSON.stringify(partial).includes("private"));
  const outage = await evidenceRecommendations(market(), proposal(draft()), {
    search: async () => { throw new Error("private upstream diagnostics"); },
  });
  assert.equal(outage.recommendations[0].research.status, "unavailable");
  assert.ok(outage.recommendations[0].research.searches.every((search) => search.resultCount === null && search.fetchedAt === null));
});

test("research is bounded to three ideas, three searches each and ten candidates per search", async () => {
  let searches = 0;
  const ideas = [1, 2, 3].map((i) => draft({ title: `Rescue Team ${i}` }));
  const bounded = await evidenceRecommendations(market(), proposal(...ideas), {
    search: async () => {
      const batch = ++searches;
      return { fetchedAt, games: Array.from({ length: 40 }, (_, i) => searchGame(batch * 100 + i)) };
    },
  });
  assert.equal(searches, 9);
  assert.ok(bounded.recommendations.every((idea) => idea.research.games.length === 30));
  await assert.rejects(evidenceRecommendations(market(), proposal(...ideas, draft()), neverSearch));
  await assert.rejects(evidenceRecommendations(market(), proposal(draft({ researchTerms: ["a", "b", "c"] })), neverSearch));
});

test("expired observations keep their original times and are explicitly marked; invalid rows are excluded", async () => {
  const staleAt = "2026-09-30T09:00:00.000Z";
  const input = market([[game(1), game(-1), game(7, { rootPlaceId: 0 }), game(8, { playing: -1 })], null, null, null], [
    { chart: charts[0], fetchedAt: staleAt, expiresAt: "2026-09-30T09:02:00.000Z" },
  ]);
  const result = await evidenceRecommendations(input, proposal(draft()), emptySearch);
  assert.equal(result.dataAt, staleAt);
  assert.equal(result.marketEvidence.charts[0].stale, true);
  assert.equal(result.marketEvidence.charts[0].sampledGames, 1);
  assert.equal(result.recommendations[0].evidence[0].fetchedAt, staleAt);
});

test("generation cancellation stops waiting for stalled searches and prevents further research", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = evidenceRecommendations(market(), proposal(draft(), draft({ title: "Second Rescue Idea" })), {
    search: async () => { calls++; queueMicrotask(() => controller.abort(new Error("deadline"))); return new Promise(() => {}); },
  }, controller.signal);
  await assert.rejects(pending, /deadline/);
  assert.equal(calls, 3, "only the first bounded research attempt starts");
  await assert.rejects(evidenceRecommendations(market(), async () => assert.fail("aborted before model"), neverSearch, controller.signal), /deadline/);
});

test("the rendered card leads with prototypes, keeps evidence inspectable and states material gaps once", async () => {
  // Node strips .ts but not TSX. Transpile only the actual view modules, with no test copies or network.
  const hooks = registerHooks({
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
      if (url.startsWith("file:") && url.endsWith(".tsx")) {
        return { format: "module", shortCircuit: true, source: ts.transpileModule(`import React from "react";\n${readFileSync(fileURLToPath(url), "utf8")}`, {
          compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
        }).outputText };
      }
      return nextLoad(url, context);
    },
  });
  try {
    const { RomanumInsight } = await import(new URL("../src/components/market/romanum-insight.tsx", import.meta.url).href);
    const result = await evidenceRecommendations(market([[game(1, { name: "<script>fixture</script>" })], [], null, []]), proposal(draft()), {
      search: async (query) => {
        if (query === "rescue ropes") throw new Error("fixture outage");
        return { fetchedAt, games: [searchGame(9, { sponsored: true })] };
      },
    });
    const content = { ...result, radar: [], generatedAt: "2026-10-02T10:00:01.000Z" };
    const render = (record) => renderToStaticMarkup(createElement(RomanumInsight, {
      initial: { day: "2026-10-02", content: record }, today: "2026-10-02", connected: false, fitRow: true,
    }));
    const markup = render(content);
    assert.match(markup, /Ideas to prototype/);
    assert.match(markup, /AI-generated design proposals need playtesting/);
    const evidenceDetails = /<details\b[^>]*>\s*<summary\b[^>]*>Evidence and sources<\/summary>/g;
    const detailsStart = markup.search(evidenceDetails);
    assert.ok(detailsStart > markup.indexOf(content.recommendations[0].reason));
    assert.equal(markup.match(evidenceDetails)?.length, 1);
    assert.match(markup, /Track this development task/);
    assert.ok(!/<details[^>]*\bopen(?:[\s=>])/.test(markup));
    assert.match(markup.slice(detailsStart), /Evidence and sources/);
    const visibleLead = markup.slice(0, detailsStart)
      .replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/g, "")
      .replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
    assert.ok(!/coverage|unavailable|need playtesting|Empty results do not prove novelty/.test(visibleLead));
    assert.ok(!markup.includes("Generated design hypothesis:"));
    assert.match(markup, /Chart observations/);
    assert.match(markup, /href="https:\/\/www\.roblox\.com\/games\/101"/);
    assert.match(markup, /href="https:\/\/www\.roblox\.com\/games\/109"/);
    assert.match(markup, new RegExp(`Retrieved <time dateTime="${fetchedAt}"`));
    assert.match(markup, new RegExp(`Assembled <time dateTime="${assembledAt}"`));
    assert.match(markup, /partial coverage/);
    assert.match(markup, /unavailable; results unknown/);
    assert.match(markup, /unavailable; coverage unknown/);
    assert.match(markup, /no usable games in sample/);
    assert.match(markup, /Empty results do not prove novelty/);
    assert.match(markup, /Sponsored/);
    assert.ok(!markup.includes("<script>fixture</script>"));
    const old = render({ recommendations: [
      { title: "Old Idea", reason: "An older suggestion without structured evidence." },
      { title: "Another Old Idea", reason: "Another older suggestion without structured evidence." },
    ], radar: [], dataAt: assembledAt, generatedAt: assembledAt });
    assert.match(old, /evidence links and retrieval times were not recorded/);
    assert.equal(old.match(/Earlier suggestions are unverified\./g)?.length, 1);
    assert.ok(old.indexOf("Earlier suggestions are unverified.") < old.search(evidenceDetails));
    assert.ok(!old.includes("Retrieved <time"));

    const outageResearch = { status: "unavailable", games: [], searches: content.recommendations[0].research.searches.map((search) => ({
      ...search, status: "unavailable", fetchedAt: null, resultCount: null,
    })) };
    const outage = render({ ...content, recommendations: content.recommendations.flatMap((idea) => [
      { ...idea, research: outageResearch }, { ...idea, title: "Second Rescue", research: outageResearch },
    ]) });
    assert.equal(outage.match(/Competitor search could not run;/g)?.length, 1);
    assert.ok(outage.indexOf("Competitor search could not run;") < outage.search(evidenceDetails));
    assert.match(outage.slice(outage.search(evidenceDetails)), /unavailable; results unknown/);

    const stale = render({ ...content, marketEvidence: { ...content.marketEvidence, charts: content.marketEvidence.charts.map((chart) => (
      chart.status === "unavailable" ? chart : { ...chart, stale: true, expiresAt: assembledAt }
    )) } });
    assert.equal(stale.match(/Some chart observations were stale when assembled;/g)?.length, 1);
    assert.ok(stale.indexOf("Some chart observations were stale when assembled;") < stale.search(evidenceDetails));
    assert.match(stale.slice(stale.search(evidenceDetails)), /expired when assembled/);
  } finally { hooks.deregister(); }
});
