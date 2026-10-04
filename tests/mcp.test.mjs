import test from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpEndpoint } from "../src/lib/mcp/http.ts";
import { createPublicDataService } from "../src/lib/public-data.ts";
import { createToolGate, BusyError } from "../src/lib/mcp/limits.ts";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { createMcpUsageRecorder, queryMcpUsage } from "../src/lib/mcp/usage.ts";

const URL = "http://localhost:3000/mcp";
const fixture = { universeId: 123, name: "Test fixture", playing: 4 };
const service = () => createPublicDataService({
  searchGames: async () => [fixture],
  getGameStats: async () => [fixture],
  universeIdForPlace: async () => 123,
  getRobloxChart: async () => [],
});

function request(options = {}) {
  const { headers, body, method = "POST" } = options;
  return new Request(URL, {
    method,
    headers: { host: "localhost:3000", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    ...(method === "POST" ? { body: body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) } : {}),
  });
}

async function connect(t, endpoint, mode) {
  const client = new Client({ name: "romanum-test", version: "1" }, { versionNegotiation: { mode } });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL), {
    fetch: (input, init) => {
      const req = new Request(input, init);
      req.headers.set("host", new globalThis.URL(req.url).host);
      return endpoint.fetch(req);
    },
  }));
  return client;
}

for (const mode of ["legacy", { pin: "2026-07-28" }]) {
  test(`official client discovers tools/resources and reads structured data (${JSON.stringify(mode)})`, async (t) => {
    const endpoint = createMcpEndpoint({ service: service() });
    t.after(() => endpoint.close());
    const client = await connect(t, endpoint, mode);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
    assert.ok(tools.some(tool => tool.name === "compare_game_history"));
    assert.ok(tools.some(tool => tool.name === "suggest_game_peers"));
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    assert.ok(!tools.some((tool) => tool.name === "create_chart"));
    const result = await client.callTool({ name: "search_games", arguments: { query: "Test" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.games, [fixture]);
    const estimate = await client.callTool({ name: "estimate_game_earnings", arguments: { universeIds: [123], days: 7 } });
    assert.equal(estimate.isError, undefined);
    assert.equal(estimate.structuredContent.estimateDays, 7);
    assert.equal(estimate.structuredContent.games[0].estimatedEarnings.kind, "estimate");
    assert.equal(estimate.structuredContent.games[0].estimatedEarnings.genre, "General");
    const research = await client.callTool({ name: "research_game_idea", arguments: { title: "Test concept", terms: ["Test mechanic"] } });
    assert.equal(research.isError, undefined);
    assert.equal(research.structuredContent.status, "complete");
    assert.equal(research.structuredContent.games.length, 1);
    assert.equal(research.structuredContent.games[0].matchedQueries.length, 2);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.ok(result.structuredContent.source.startsWith("https://"));
    const { resources } = await client.listResources();
    assert.equal(resources.length, 9);
    assert.ok(resources.some(resource => resource.uri === "romanum://skills/romanum-3d-workflow"));
    const metrics = await client.readResource({ uri: "romanum://metrics" });
    assert.equal(JSON.parse(metrics.contents[0].text).metrics.playing.unit, "players");
    const skill = await client.readResource({ uri: "romanum://skills/romanum-game-design" });
    assert.match(skill.contents[0].text, /name: romanum-game-design/);
    const modelGuide = await client.readResource({ uri: "romanum://skills/romanum-3d-workflow" });
    assert.match(modelGuide.contents[0].text, /name: romanum-3d-workflow/);
    const guide = await client.callTool({ name: "load_skill", arguments: { skill: "romanum-game-design" } });
    assert.ok(guide.structuredContent.instructions.length > 100);
    const invalid = await client.callTool({ name: "get_game_stats", arguments: { universeIds: [-1] } });
    assert.equal(invalid.isError, true);
    const traversal = await client.callTool({ name: "load_skill", arguments: { skill: "../../.env.local" } });
    assert.equal(traversal.isError, true);
    await assert.rejects(client.readResource({ uri: "romanum://skills/../../.env.local" }));
  });
}

test("upstream failures become safe tool errors without fabricated observations", async (t) => {
  const endpoint = createMcpEndpoint({ service: createPublicDataService({ searchGames: async () => { throw new Error("secret upstream details"); } }),
    recordToolUsage: async () => { throw new Error("private recording failure"); } });
  t.after(() => endpoint.close());
  const client = await connect(t, endpoint, "legacy");
  assert.equal((await client.callTool({ name: "get_metric_definitions", arguments: {} })).isError, undefined);
  const result = await client.callTool({ name: "search_games", arguments: { query: "x" } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.doesNotMatch(result.content[0].text, /secret/);
});

test("MCP records aggregate tool outcomes and reports counts, popularity and success rates without arguments", async t => {
  const engine = await PGlite.create(); t.after(() => engine.close());
  await engine.exec(await readFile(new globalThis.URL("../db/migrations/024_mcp_tool_usage.sql", import.meta.url), "utf8"));
  const endpoint = createMcpEndpoint({
    service: createPublicDataService({ searchGames: async () => { throw new Error("PRIVATE UPSTREAM"); } }),
    recordToolUsage: createMcpUsageRecorder(async () => engine),
  });
  t.after(() => endpoint.close());
  const client = await connect(t, endpoint, "legacy");
  for (let index = 0; index < 2; index++) await client.callTool({ name: "get_metric_definitions", arguments: {} });
  await client.callTool({ name: "load_skill", arguments: { skill: "romanum-game-design" } });
  assert.equal((await client.callTool({ name: "search_games", arguments: { query: "PRIVATE PROMPT" } })).isError, true);
  const usage = await queryMcpUsage(engine, new Date().toISOString());
  assert.equal(usage.available, true);
  assert.equal(usage.totalCalls, 4); assert.equal(usage.successfulCalls, 3); assert.equal(usage.failedCalls, 1);
  assert.equal(usage.successRate, 0.75);
  assert.equal(usage.popularTools[0].name, "get_metric_definitions"); assert.equal(usage.popularTools[0].totalCalls, 2);
  const { rows } = await engine.query("SELECT * FROM mcp_tool_usage_daily");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["day", "failed_calls", "successful_calls", "tool_name"]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|query|arguments|prompt|owner|client/i);
});

test("HTTP rejects hostile origins/hosts and permits configured browser preflight", async (t) => {
  const endpoint = createMcpEndpoint({ allowedOrigins: ["https://agent.example"] });
  t.after(() => endpoint.close());
  for (const headers of [{ host: "evil.example" }, { origin: "https://evil.example" }, { origin: "null" }]) {
    assert.equal((await endpoint.fetch(request({ headers }))).status, 403);
  }
  const preflight = await endpoint.fetch(request({ method: "OPTIONS", headers: { origin: "https://agent.example" } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://agent.example");
  assert.equal(preflight.headers.get("cache-control"), "no-store");
  assert.equal((await endpoint.fetch(request({ method: "GET" }))).status, 405);
  assert.throws(() => createMcpEndpoint({ publicUrl: "http://public.example/mcp" }));
});

test("public host allowlist works behind a proxy without trusting the request URL", async (t) => {
  const endpoint = createMcpEndpoint({ publicUrl: "https://romanum.example/mcp" });
  t.after(() => endpoint.close());
  assert.equal((await endpoint.fetch(request())).status, 403);
  const response = await endpoint.fetch(request({ method: "OPTIONS", headers: { host: "romanum.example", origin: "https://romanum.example" } }));
  assert.equal(response.status, 204);
});

test("body limits apply even without Content-Length", async (t) => {
  const endpoint = createMcpEndpoint();
  t.after(() => endpoint.close());
  assert.equal((await endpoint.fetch(request({ body: "x".repeat(16 * 1024 + 1) }))).status, 413);
});

test("global quotas ignore attacker-selected forwarding headers and reset", async (t) => {
  let now = 0;
  const endpoint = createMcpEndpoint({ requestLimit: 2, now: () => now });
  t.after(() => endpoint.close());
  await endpoint.fetch(request({ headers: { "x-forwarded-for": "1.1.1.1" } }));
  await endpoint.fetch(request({ headers: { "x-forwarded-for": "2.2.2.2" } }));
  const denied = await endpoint.fetch(request({ headers: { "x-forwarded-for": "3.3.3.3" } }));
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
  now = 60_000;
  assert.notEqual((await endpoint.fetch(request())).status, 429);
});

test("tool concurrency is bounded and slots are released after failures", async () => {
  const gate = createToolGate(1);
  let finish;
  const pending = gate(() => new Promise((resolve) => { finish = resolve; }));
  await assert.rejects(gate(async () => 2), BusyError);
  finish(1);
  assert.equal(await pending, 1);
  await assert.rejects(gate(async () => { throw new Error("upstream"); }));
  assert.equal(await gate(async () => 3), 3);
});
