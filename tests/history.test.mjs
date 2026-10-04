import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { collectHistory } from "../src/lib/history/collector.ts";
import { createHistoryService } from "../src/lib/history/service.ts";
import { grantCredits, reserveCredits } from "../src/lib/credits/ledger.ts";

// Fixtures exist only in this isolated PostgreSQL test engine, never the local app database.
async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  return db;
}
const baseTime = Date.parse("2026-01-01T00:00:15Z");
const game = (id = 1, extra = {}) => ({ universeId: id, rootPlaceId: id * 100, name: `Fixture ${id}`, rank: 1, playing: 12, likes: 4, dislikes: 1, genre: "Simulation", sponsored: false, ...extra });
const loaders = (extra = {}) => ({ getRobloxChart: async () => [game()], getGameStats: async () => [game(1, { visits: 100, favorites: 5 })], ...extra });

async function restoreMigration022Fixture(db) {
  // The disposable engine alone is rewound; application databases never are.
  await db.exec("DROP TABLE analytics_experiments, analytics_notifications, analytics_watchlist_state, analytics_watchlists, mcp_tool_usage_daily, provider_final_claims, provider_attempts; DROP INDEX history_targets_game_run; DELETE FROM romanum_migrations WHERE version>=23");
}

test("migration is repeatable and a duplicate slot does not fetch or overwrite data", async (t) => {
  const db = await database(t);
  await migrateHistory(db);
  assert.deepEqual((await db.query("SELECT version FROM romanum_migrations ORDER BY version")).rows.map((row) => row.version), Array.from({ length: 26 }, (_, i) => i + 1));
  const first = await collectHistory(db, { loaders: loaders(), now: () => baseTime });
  assert.equal(first.observed, 1);
  const duplicate = await collectHistory(db, { loaders: new Proxy({}, { get() { assert.fail("duplicate slot fetched Roblox"); } }), now: () => baseTime + 1000 });
  assert.equal(duplicate.skipped, true);
  const result = await createHistoryService(async () => db, () => baseTime + 2000).history({ universeId: 1 });
  assert.equal(result.sampleCount, 1);
  assert.equal(result.points[0].observedAt, new Date(baseTime).toISOString());
  assert.equal(result.points[0].playing, 12);
  assert.equal(result.points[0].visits, 100);
  assert.equal(result.points[0].chartRanks["top-playing-now"], 1);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM history_chart_entries")).rows[0].count, 4);
});

test("migration refuses a changed applied checksum before applying new SQL", async (t) => {
  const db = await database(t);
  // Reconstruct the preceding schema only inside this disposable engine.
  await restoreMigration022Fixture(db);
  await db.query("UPDATE romanum_migrations SET checksum='changed' WHERE version=1");
  await assert.rejects(migrateHistory(db), /Applied migration has changed or is missing/);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM romanum_migrations")).rows[0].count, 22);
  assert.equal((await db.query("SELECT to_regclass('provider_attempts') AS attempts, to_regclass('provider_final_claims') AS claims")).rows[0].attempts, null);
});

test("migration 023 upgrades 022 repeatably without changing existing wallet balances, reservations, carry or receipts", async (t) => {
  const db = await database(t);
  await restoreMigration022Fixture(db);
  const ownerId = "migration-upgrade-fixture";
  await grantCredits(db, { ownerId, amount: 71, operationId: "migration-upgrade-grant" });
  await reserveCredits(db, { ownerId, amount: 9, operationId: "migration-upgrade-hold" });
  await db.query("INSERT INTO usage_carry(owner_id,carry_nano_usd) VALUES ($1,1234567)", [ownerId]);
  const snapshot = async () => ({
    account: (await db.query("SELECT * FROM credits_accounts WHERE owner_id=$1", [ownerId])).rows,
    operations: (await db.query("SELECT * FROM credits_operations WHERE owner_id=$1 ORDER BY operation_id", [ownerId])).rows,
    ledger: (await db.query("SELECT * FROM credits_ledger WHERE owner_id=$1 ORDER BY id", [ownerId])).rows,
    carry: (await db.query("SELECT * FROM usage_carry WHERE owner_id=$1", [ownerId])).rows,
    history: (await db.query("SELECT * FROM romanum_migrations WHERE version<=22 ORDER BY version")).rows,
  });
  const before = await snapshot();
  await migrateHistory(db);
  await migrateHistory(db);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await db.query("SELECT version FROM romanum_migrations ORDER BY version")).rows.map(row => row.version), Array.from({ length: 26 }, (_, i) => i + 1));
  assert.equal((await db.query("SELECT count(*)::int AS count FROM provider_attempts")).rows[0].count, 0);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM provider_final_claims")).rows[0].count, 0);
});

test("unavailable statistics and missing collection slots remain null between real observations", async (t) => {
  const db = await database(t);
  await collectHistory(db, { loaders: loaders(), now: () => baseTime });
  const failed = await collectHistory(db, { loaders: loaders({ getGameStats: async () => { throw new Error("offline"); } }), now: () => baseTime + 300_000 });
  assert.equal(failed.status, "failed");
  await collectHistory(db, { loaders: loaders({ getGameStats: async () => [game(1, { playing: 0 })] }), now: () => baseTime + 900_000 });
  const result = await createHistoryService(async () => db, () => baseTime + 910_000).history({ universeId: 1 });
  assert.deepEqual(result.points.map((point) => point.status), ["observed", "unavailable", "missed", "observed"]);
  assert.deepEqual(result.points.map((point) => point.playing), [12, null, null, 0]);
  assert.equal(result.points[3].visits, null);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.gaps, 2);
});

test("cohort absence differs from a failed fetch, and a failed chart keeps other observations", async (t) => {
  const db = await database(t);
  await collectHistory(db, { loaders: loaders(), now: () => baseTime });
  const result = await collectHistory(db, { loaders: loaders({
    getRobloxChart: async (chart) => { if (chart === "top-trending") throw new Error("offline"); return [game(2)]; },
    getGameStats: async () => [game(2)],
  }), now: () => baseTime + 300_000 });
  assert.equal(result.status, "partial");
  assert.equal(result.chartFailures, 1);
  const history = await createHistoryService(async () => db, () => baseTime + 301_000).history({ universeId: 1 });
  assert.equal(history.points[1].status, "not_sampled");
  assert.equal(history.points[1].playing, null);
  const charts = await db.query("SELECT * FROM history_chart_fetches WHERE run_id=$1 AND chart_id='top-trending'", [result.runId]);
  assert.equal(charts.rows[0].observed_at, null);
});

test("invalid counts, duplicate IDs, sponsored rows and unrequested stats cannot create observations", async (t) => {
  const db = await database(t);
  const requested = [];
  await collectHistory(db, { loaders: loaders({
    getRobloxChart: async () => [game(), game(), game(2, { sponsored: true }), game(3, { playing: -1 })],
    getGameStats: async (ids) => { requested.push(ids); return [game(1, { playing: -5 }), game(999)]; },
  }), now: () => baseTime });
  assert.deepEqual(requested, [[1]]);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM history_observations")).rows[0].count, 0);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM history_chart_entries WHERE sponsored")).rows[0].count, 4);
});

test("missing game IDs in a successful response are unavailable, not zero", async (t) => {
  const db = await database(t);
  await collectHistory(db, { loaders: loaders({ getRobloxChart: async () => [game(), game(2)] }), now: () => baseTime });
  const history = await createHistoryService(async () => db, () => baseTime + 1000).history({ universeId: 2 });
  assert.equal(history.points[0].status, "unavailable");
  assert.equal(history.points[0].playing, null);
});

test("unconfigured storage is honest and invalid ranges never reach SQL", async () => {
  const unavailable = createHistoryService(async () => null, () => baseTime);
  assert.deepEqual(await unavailable.games(), { available: false, games: [] });
  assert.equal((await unavailable.history({ universeId: 1 })).available, false);
  const service = createHistoryService(async () => { assert.fail("invalid query accessed database"); });
  for (const input of [{ universeId: "1;DROP TABLE history_games" }, { universeId: 0 }, { universeId: 1, days: 31 }, { universeId: 1, days: 0 }, { universeId: 1, days: 1.5 }]) {
    await assert.rejects(service.history(input));
  }
});

test("collector failure marks the run and SQL transactions roll back partial writes", async (t) => {
  const db = await database(t);
  const broken = { ...db, transaction: async () => { throw new Error("write failure"); } };
  await assert.rejects(collectHistory(broken, { loaders: loaders(), now: () => baseTime }));
  assert.equal((await db.query("SELECT status FROM history_runs")).rows[0].status, "failed");
  assert.equal((await db.query("SELECT count(*)::int AS count FROM history_observations")).rows[0].count, 0);
  await assert.rejects(db.transaction(async (sql) => {
    await sql.query("INSERT INTO history_games VALUES (1,100,'Fixture',NULL,now(),now())");
    throw new Error("rollback");
  }));
  assert.equal((await db.query("SELECT count(*)::int AS count FROM history_games")).rows[0].count, 0);
});
