import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Substitute only storage; actual route validation, comparison and history SELECTs run.
    if (specifier === "../history/database.ts" || (specifier === "./database.ts" && context.parentURL?.endsWith("/history/service.ts"))) {
      return { url: `data:text/javascript,${encodeURIComponent("export async function historyDatabase(){globalThis.__comparisonStorageReads++; if(globalThis.__comparisonFailure) throw new Error(globalThis.__comparisonFailure); return globalThis.__comparisonDatabase ?? null;}")}`, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const base = path.resolve(root, specifier.slice(2));
      const candidate = [base, `${base}.ts`].find(file => existsSync(file) && statSync(file).isFile());
      if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { GET, runtime, dynamic } = await import("../src/app/api/history/compare/route.ts");
const { GET: GETPeers } = await import("../src/app/api/history/peers/route.ts");
hooks.deregister();

const period = 300_000;
const base = Math.floor(Date.now() / period) * period - 60 * 60_000;
function fixtureDatabase() {
  const reads = [];
  return {
    reads,
    async query(text, values) {
      reads.push({ text, values });
      assert.match(text, /^SELECT /);
      if (text.startsWith("SELECT * FROM history_games")) return { rows: [{ universe_id: String(values[0]), root_place_id: "100", name: "Public fixture", icon_url: null }] };
      if (text.startsWith("SELECT min(slot)")) return { rows: [{ first: new Date(base).toISOString() }] };
      assert.match(text, /^SELECT r\.slot/);
      return { rows: [0, 1, 2].map(index => ({
        slot: new Date(base + index * period).toISOString(), run_status: "complete",
        observed_at: new Date(base + index * period + values[0] * 1000).toISOString(),
        playing: values[0] === 1 ? 0 : 20, visits: null, favorites: null, likes: null, dislikes: null,
        target_status: "observed", chart_ranks: {},
      })) };
    },
    exec() { assert.fail("HTTP comparison attempted a write."); },
    transaction() { assert.fail("HTTP comparison attempted a transaction."); },
    close() { assert.fail("HTTP comparison attempted to close shared storage."); },
  };
}
const request = query => new Request(`http://localhost:3000/api/history/compare${query}`, { headers: { cookie: "ignored-private-session=fixture", "x-owner-id": "ignored" } });
const assertNoStore = response => assert.equal(response.headers.get("cache-control"), "no-store");

test("actual anonymous GET returns bounded public comparisons with one common cutoff", async t => {
  t.after(() => { delete globalThis.__comparisonDatabase; delete globalThis.__comparisonStorageReads; });
  globalThis.__comparisonDatabase = fixtureDatabase();
  globalThis.__comparisonStorageReads = 0;
  const response = await GET(request("?universeIds=1,2,3,4,5&days=30"));
  assert.equal(runtime, "nodejs");
  assert.equal(dynamic, "force-dynamic");
  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(response.headers.get("set-cookie"), null);
  const result = await response.json();
  assert.equal(result.status, "compared");
  assert.equal(result.pairs.length, 10);
  assert.equal(result.games.length, 5);
  assert.equal(result.coverage.allGamesPairedSlots, 3);
  assert.equal(result.pairs[0].observedPlayerCounts.leftMean, 0);
  assert.equal(result.pairs[0].observedPlayerCounts.meanDifference, -20);
  assert.equal(globalThis.__comparisonStorageReads, 1);
  const reads = globalThis.__comparisonDatabase.reads.filter(read => read.text.startsWith("SELECT r.slot"));
  assert.ok(reads.every(read => read.values[1] === result.from && read.values[2] === result.to));
  assert.equal(Date.parse(result.to) - Date.parse(result.from), 30 * 86_400_000);
  assert.equal(result.cutoff, result.to);
  assert.doesNotMatch(JSON.stringify(result), /ignored-private-session|ignored-private-owner|account_sessions|linked_game/);
  assert.equal(result.source, "https://games.roblox.com/v1/games");
});

test("HTTP rejects malformed, duplicated, private-scope and unbounded parameters before storage", async t => {
  t.after(() => { delete globalThis.__comparisonDatabase; delete globalThis.__comparisonStorageReads; });
  globalThis.__comparisonDatabase = fixtureDatabase();
  globalThis.__comparisonStorageReads = 0;
  for (const query of [
    "", "?universeIds=1", "?universeIds=1,1", "?universeIds=1,2,3,4,5,6", "?universeIds=0,2",
    "?universeIds=-1,2", "?universeIds=1.5,2", "?universeIds=1e2,2", "?universeIds=01,2",
    "?universeIds=1,,2", "?universeIds=1,%202", "?universeIds=9007199254740992,2",
    "?universeIds=1,2&days=0", "?universeIds=1,2&days=31", "?universeIds=1,2&days=1.5",
    "?universeIds=1,2&days=", "?universeIds=1,2&days=01", "?universeIds=1,2&days=1e1",
    "?universeIds=1,2&days=1&days=30", "?universeIds=1,2&universeIds=3,4",
    "?universeIds=1,2&cutoff=2026-01-01", "?universeIds=1,2&ownerId=private",
    "?universeIds=1%3BDROP%20TABLE%20history_games,2",
  ]) {
    const response = await GET(request(query));
    assert.equal(response.status, 400, query);
    assertNoStore(response);
    assert.deepEqual(await response.json(), { error: "Choose two to five distinct public game IDs and a period of one to thirty days." });
  }
  assert.equal(globalThis.__comparisonStorageReads, 0);
  assert.equal(globalThis.__comparisonDatabase.reads.length, 0);
});

test("HTTP default period is one day and safe integer IDs are accepted", async t => {
  t.after(() => { delete globalThis.__comparisonDatabase; delete globalThis.__comparisonStorageReads; });
  globalThis.__comparisonDatabase = null;
  globalThis.__comparisonStorageReads = 0;
  const response = await GET(request("?universeIds=1,9007199254740991"));
  assert.equal(response.status, 200);
  assertNoStore(response);
  const result = await response.json();
  assert.equal(Date.parse(result.to) - Date.parse(result.from), 86_400_000);
  assert.equal(result.available, false);
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.pairs[0].observedPlayerCounts, null);
  assert.equal(result.pairs[0].coverage.overlapFraction, null);
});

test("HTTP hides storage failures, SQL, connection strings and internal exception details", async t => {
  t.after(() => { delete globalThis.__comparisonDatabase; delete globalThis.__comparisonStorageReads; delete globalThis.__comparisonFailure; });
  globalThis.__comparisonStorageReads = 0;
  globalThis.__comparisonFailure = "postgres://fixture-user:fixture-secret@internal.invalid/test SELECT private_accounts";
  const failed = await GET(request("?universeIds=1,2"));
  assert.equal(failed.status, 503);
  assertNoStore(failed);
  assert.deepEqual(await failed.json(), { error: "Couldn't compare recorded history. Try again." });
  delete globalThis.__comparisonFailure;
  globalThis.__comparisonDatabase = { query: async () => { throw new Error("SQL SELECT secret_column FROM internal_table"); } };
  const queryFailed = await GET(request("?universeIds=1,2"));
  assert.equal(queryFailed.status, 503);
  assert.deepEqual(await queryFailed.json(), { error: "Couldn't compare recorded history. Try again." });
});


test("public peer HTTP enforces bounds before storage and sanitizes unavailable storage", async t => {
  t.after(() => { delete globalThis.__comparisonStorageReads; delete globalThis.__comparisonFailure; });
  globalThis.__comparisonStorageReads = 0;
  for (const query of ["", "?universeId=0", "?universeId=1&days=31", "?universeId=1&ownerId=private", "?universeId=1&universeId=2", "?universeId=9007199254740992"]) {
    const response = await GETPeers(new Request(`http://localhost/api/history/peers${query}`));
    assert.equal(response.status, 400); assertNoStore(response);
  }
  assert.equal(globalThis.__comparisonStorageReads, 0);
  const offline = await GETPeers(new Request("http://localhost/api/history/peers?universeId=1"));
  assert.equal(offline.status, 200); assertNoStore(offline);
  assert.equal((await offline.json()).available, false);
  globalThis.__comparisonFailure = "postgresql://secret:password@internal/db SELECT private";
  const failed = await GETPeers(new Request("http://localhost/api/history/peers?universeId=1"));
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /secret|password|postgresql|SELECT/);
});
