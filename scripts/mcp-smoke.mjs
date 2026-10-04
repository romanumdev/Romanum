import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL(process.argv[2] ?? "http://localhost:3000/mcp");
const client = new Client({ name: "romanum-smoke", version: "1" });
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`);
  assert.ok(result.structuredContent, `${name} must return structured data`);
  return result.structuredContent;
};

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 12);
  assert.ok(tools.some(tool => tool.name === "compare_game_history"));
  assert.ok(tools.some(tool => tool.name === "suggest_game_peers"));
  const { resources } = await client.listResources();
  assert.equal(resources.length, 9);
  await client.readResource({ uri: "romanum://skills/romanum-game-design" });
  await call("get_metric_definitions");
  await call("load_skill", { skill: "romanum-genre-analysis" });
  for (const id of ["romanum-game-teardown", "romanum-game-economy", "romanum-3d-workflow"]) {
    const guide = await call("load_skill", { skill: id });
    assert.equal(guide.id, id);
    assert.ok(guide.instructions.length > 500);
    assert.equal(guide.licenseUrl, "https://github.com/romanumdev/Romanum/blob/main/LICENSE");
  }
  const search = await call("search_games", { query: "Blox Fruits" });
  const research = await call("research_game_idea", { title: "Blox Fruits", terms: ["pirate adventure"] });
  assert.equal(research.status, "complete");
  assert.ok(research.games.length > 0, "idea research finds real candidate competitors");
  const chart = await call("get_roblox_charts", { chart: "top-playing-now", limit: 3 });
  assert.ok(chart.games.length > 0, "live chart contains experiences");
  const stats = await call("get_game_stats", { universeIds: chart.games.map((game) => game.universeId) });
  assert.ok(stats.games.length > 0, "live stats resolve chart IDs");
  const first = stats.games[0];
  const estimates = await call("estimate_game_earnings", { universeIds: stats.games.map((game) => game.universeId), days: 30 });
  assert.equal(estimates.kind, "estimate");
  assert.equal(estimates.estimateDays, 30);
  assert.equal(estimates.fetchedAt, stats.fetchedAt);
  assert.ok(estimates.games.every((game) => game.estimatedEarnings && game.estimatedRobuxHigh >= game.estimatedRobuxLow));
  const resolved = await call("resolve_game_link", { link: `https://www.roblox.com/games/${first.rootPlaceId}` });
  assert.equal(resolved.universeId, first.universeId);
  const history = await call("get_game_history", { universeId: first.universeId, days: 1 });
  assert.ok(Array.isArray(history.points));
  const comparisonIds = [...new Set(chart.games.map(game => game.universeId))].slice(0, 2);
  assert.equal(comparisonIds.length, 2, "comparison smoke needs two distinct public chart IDs");
  const comparison = await call("compare_game_history", { universeIds: comparisonIds, days: 1 });
  const peers = await call("suggest_game_peers", { universeId: first.universeId, days: 1 });
  assert.ok(Array.isArray(peers.peers));
  assert.equal(comparison.games.length, 2);
  assert.equal(comparison.cutoff, comparison.to);
  assert.equal(Date.parse(comparison.to) - Date.parse(comparison.from), 86400000);
  assert.ok(Array.isArray(comparison.sameWindow.games));
  assert.ok(comparison.games.every(game => game.coverage.validSamples >= 0));
  assert.ok(comparison.pairs.every(pair => pair.status === "compared" || pair.observedPlayerCounts === null));
  const analysis = await call("get_market_analysis");
  assert.ok(analysis.sampleSize > 0, "market uses real chart observations");
  const cached = await call("get_roblox_charts", { chart: "top-playing-now", limit: 3 });
  assert.equal(cached.fetchedAt, chart.fetchedAt, "cache preserves retrieval time");
  console.log(JSON.stringify({
    endpoint: endpoint.href, protocol: "legacy", tools: tools.length, resources: resources.length,
    searchMatches: search.games.length, chartGames: chart.games.length, statsGames: stats.games.length,
    icons: stats.games.filter((game) => game.iconUrl).length, earningsEstimates: estimates.games.length,
    historicalObservations: history.sampleCount, comparisonStatus: comparison.status,
    comparisonSharedSlots: comparison.coverage.allGamesPairedSlots, peerSuggestions: peers.peers.length,
    sampleSize: analysis.sampleSize, unavailableCharts: analysis.unavailableCharts,
    fetchedAt: chart.fetchedAt, source: chart.source,
  }, null, 2));
} finally {
  await client.close();
}

const modern = new Client({ name: "romanum-smoke", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
try {
  await modern.connect(new StreamableHTTPClientTransport(endpoint));
  const result = await modern.callTool({ name: "get_metric_definitions", arguments: {} });
  assert.ok(!result.isError);
  console.log("Protocol 2026-07-28: connected and called a tool.");
} finally {
  await modern.close();
}
