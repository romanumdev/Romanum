import test from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpEndpoint } from "../src/lib/mcp/http.ts";

const publicUrls = [
  "https://romanum.dev/mcp",
  "https://romanumdev.netlify.app/mcp",
  "https://main--romanumdev.netlify.app/mcp",
];
const initialize = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "host-fixture", version: "1" } },
});

function request(url, headers = {}, method = "POST") {
  return new Request(url, {
    method,
    headers: { host: new URL(url).host, accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body: initialize } : {}),
  });
}

test("missing public configuration reproduces the deployed rejection on every public URL", async (t) => {
  const endpoint = createMcpEndpoint();
  t.after(() => endpoint.close());
  for (const url of publicUrls) {
    const response = await endpoint.fetch(request(url));
    assert.equal(response.status, 403, url);
    assert.equal(await response.text(), "Host not allowed.");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

for (const url of publicUrls) {
  for (const mode of ["legacy", { pin: "2026-07-28" }]) {
    test(`explicitly configured public host supports protocol discovery: ${url} ${JSON.stringify(mode)}`, async (t) => {
      // Each endpoint trusts exactly one host. This does not authorize all three on production.
      const endpoint = createMcpEndpoint({ publicUrl: url });
      t.after(() => endpoint.close());
      const exchanges = [];
      const client = new Client({ name: "public-host-fixture", version: "1" }, { versionNegotiation: { mode } });
      t.after(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(url), {
        fetch: async (input, init) => {
          const req = new Request(input, init);
          req.headers.set("host", new URL(req.url).host);
          req.headers.set("origin", new URL(url).origin);
          const message = req.method === "POST" ? await req.clone().json() : undefined;
          const response = await endpoint.fetch(req);
          exchanges.push({ httpMethod: req.method, rpcMethod: message?.method, status: response.status });
          assert.equal(response.headers.get("access-control-allow-origin"), new URL(url).origin);
          return response;
        },
      }));
      const { tools } = await client.listTools();
      assert.equal(tools.length, 12);
      assert.ok(tools.some(tool => tool.name === "compare_game_history"));
      assert.ok(tools.some(tool => tool.name === "suggest_game_peers"));
      assert.ok(tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
      const result = await client.callTool({ name: "get_metric_definitions", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.metrics.playing.unit, "players");
      assert.ok(exchanges.some(exchange => exchange.rpcMethod === "tools/list" && exchange.status === 200));
      assert.ok(exchanges.some(exchange => exchange.rpcMethod === (mode === "legacy" ? "initialize" : "server/discover") && exchange.status === 200));
      // The legacy client also probes an optional GET stream; this stateless endpoint returns 405.
      assert.ok(exchanges.every(exchange => exchange.httpMethod === "GET" ? exchange.status === 405 : exchange.status >= 200 && exchange.status < 300));
    });
  }
}

test("canonical host policy rejects aliases, unknown hosts and forwarding-header spoofing", async (t) => {
  const endpoint = createMcpEndpoint({ publicUrl: publicUrls[0] });
  t.after(() => endpoint.close());
  for (const host of ["evil.example", "localhost:3000", "romanumdev.netlify.app", "main--romanumdev.netlify.app"]) {
    const response = await endpoint.fetch(request(publicUrls[0], {
      host, "x-forwarded-host": "romanum.dev", forwarded: "host=romanum.dev;proto=https",
    }));
    assert.equal(response.status, 403, host);
    assert.equal(await response.text(), "Host not allowed.");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const missingHost = request(publicUrls[0]);
  missingHost.headers.delete("host");
  assert.equal((await endpoint.fetch(missingHost)).status, 403);
  // The internal Request URL is not used to authorize a host behind a proxy.
  assert.equal((await endpoint.fetch(request("http://internal:3000/mcp", { host: "romanum.dev" }, "OPTIONS"))).status, 204);
});

test("canonical public host retains strict origin, method and body limits", async (t) => {
  const endpoint = createMcpEndpoint({ publicUrl: publicUrls[0], allowedOrigins: ["https://agent.example"] });
  t.after(() => endpoint.close());
  for (const origin of ["https://evil.example", "null", "https://romanumdev.netlify.app"]) {
    const response = await endpoint.fetch(request(publicUrls[0], { origin }));
    assert.equal(response.status, 403, origin);
    assert.equal(await response.text(), "Origin not allowed.");
  }
  for (const origin of ["https://romanum.dev", "https://agent.example"]) {
    const response = await endpoint.fetch(request(publicUrls[0], { origin }, "OPTIONS"));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
  assert.equal((await endpoint.fetch(request(publicUrls[0], {}, "GET"))).status, 405);
  const oversized = new Request(publicUrls[0], {
    method: "POST", headers: { host: "romanum.dev", accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: "x".repeat(16 * 1024 + 1),
  });
  assert.equal((await endpoint.fetch(oversized)).status, 413);
});
