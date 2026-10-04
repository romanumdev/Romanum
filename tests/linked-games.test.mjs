import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { openSecret, sealSecret } from "../src/lib/secrets.ts";
import { introspectKey, OpenCloudError, queryDailyMetric } from "../src/lib/linked-games/open-cloud.ts";
import { checkGameKey, plausibleApiKey } from "../src/lib/linked-games/link.ts";
import {
  deleteLinkedGame,
  disconnectGame,
  listLinkedGames,
  metricsSharedForImprovement,
  readGameMetrics,
  readLinkedGame,
  saveLinkedGame,
  setCollect,
  setShare,
} from "../src/lib/linked-games/store.ts";
import { asFractions, formatMetric, SYNCED_METRICS } from "../src/lib/linked-games/metrics.ts";
import { syncDueGames, syncLinkedGame } from "../src/lib/linked-games/sync.ts";

async function database(t) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  for (const file of ["012_accounts.sql", "013_linked_games.sql", "020_private_analytics_ai.sql", "027_linked_game_oauth.sql"]) await db.exec(await readFile(path.join(process.cwd(), "db", "migrations", file), "utf8"));
  return db;
}

async function account(db, robloxUserId) {
  const id = randomUUID();
  await db.query("INSERT INTO accounts(id, roblox_user_id, owner_id, username, display_name) VALUES ($1,$2,$3,'user','User')", [id, robloxUserId, `account:${id}`]);
  return id;
}

const SECRETS = randomBytes(32);
const API_KEY = "rbx-open-cloud-key-0123456789abcdefWXYZ";
const NOW = new Date("2026-09-27T06:00:00Z");
const noSleep = async () => {};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const done = (points) => json({ path: "v1/universes/1/operations/metrics/op", done: true, metadata: {}, response: { values: [{ breakdowns: [], dataPoints: points } ] } });

/** Roblox's Analytics Query API: each metric's value for each day asked for. */
function analytics({ status = 200, value = (metric, day) => 100 + day.getUTCDate(), onQuery } = {}) {
  const queries = [];
  const fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    queries.push({ url: String(url), headers: init.headers, body });
    await onQuery?.(body);
    if (status !== 200) return json({}, status);
    const points = [];
    for (let day = new Date(body.startTime); day < new Date(body.endTime); day = new Date(day.getTime() + 86_400_000)) {
      points.push({ time: day.toISOString(), value: value(body.metric, day) });
    }
    return done(points);
  };
  return { queries, fetch };
}

const link = (db, accountId, universeId = 3828411582) => saveLinkedGame(db, { accountId, universeId, apiKey: API_KEY, keyExpiresAt: null }, SECRETS);

test("stored keys are sealed to their record: altered, moved or foreign-key secrets don't open", () => {
  const sealed = sealSecret(API_KEY, "linked-game-key:a", SECRETS);
  assert.equal(openSecret(sealed, "linked-game-key:a", SECRETS), API_KEY);
  assert.ok(!Buffer.from(sealed.ciphertext).toString("utf8").includes("open-cloud"));
  assert.throws(() => openSecret(sealed, "linked-game-key:b", SECRETS));
  assert.throws(() => openSecret(sealed, "linked-game-key:a", randomBytes(32)));
  const altered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext).map((byte, i) => (i === 0 ? byte ^ 1 : byte)) };
  assert.throws(() => openSecret(altered, "linked-game-key:a", SECRETS));
  assert.throws(() => openSecret({ ...sealed, keyVersion: 2 }, "linked-game-key:a", SECRETS), /no longer has/);
});

test("the Analytics Query API client sends the key, follows long-running queries and names each failure", async () => {
  const range = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-09-03T00:00:00Z") };
  const { queries, fetch } = analytics();
  assert.deepEqual(await queryDailyMetric(API_KEY, 42, "DailyActiveUsers", range, { fetch }), [
    { day: "2026-09-01", value: 101, status: null },
    { day: "2026-09-02", value: 102, status: null },
  ]);
  assert.equal(queries[0].url, "https://apis.roblox.com/analytics-query-api/v1/universes/42/metrics");
  assert.equal(queries[0].headers["x-api-key"], API_KEY);
  assert.deepEqual(queries[0].body, { metric: "DailyActiveUsers", granularity: "OneDay", startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-09-03T00:00:00.000Z" });

  // 202 and a path to poll, then the answer.
  const polled = [];
  const pending = async (url) => {
    polled.push(String(url));
    return polled.length === 1
      ? json({ path: "v1/universes/42/operations/metrics/abc123", done: false, metadata: {} }, 202)
      : done([{ time: "2026-09-01T00:00:00Z", value: 7, status: "Projected" }, { time: "2026-09-02T00:00:00Z", value: null }]);
  };
  assert.deepEqual(await queryDailyMetric(API_KEY, 42, "DailyRevenue", range, { fetch: pending, sleep: noSleep }), [{ day: "2026-09-01", value: 7, status: "Projected" }]);
  assert.equal(polled[1], "https://apis.roblox.com/analytics-query-api/v1/universes/42/operations/metrics/abc123");

  // A poll path that isn't an operation is never requested.
  const hostile = async () => json({ path: "../../../evil", done: false }, 202);
  await assert.rejects(queryDailyMetric(API_KEY, 42, "Visits", range, { fetch: hostile, sleep: noSleep }), (error) => error.kind === "unavailable");

  const kind = async (response) => (await queryDailyMetric(API_KEY, 42, "Visits", range, { fetch: async () => response, sleep: noSleep }).catch((error) => error)).kind;
  assert.equal(await kind(json({}, 401)), "key_rejected");
  assert.equal(await kind(json({}, 403)), "key_rejected");
  assert.equal(await kind(json({}, 429)), "rate_limited");
  assert.equal(await kind(json({ done: true, error: { code: 2001, message: "bad" } }, 400)), "bad_request");
  assert.equal(await kind(json({ path: "p", done: true, error: { code: 3000 } })), "rate_limited");
  assert.equal(await kind(json({}, 503)), "unavailable");
});

test("a key is linked only once Roblox shows it's enabled, unexpired and able to read that game's analytics", async () => {
  assert.equal(plausibleApiKey(API_KEY), true);
  for (const bad of ["short", "has spaces in the key here x", "x".repeat(5000)]) assert.equal(plausibleApiKey(bad), false);

  const roblox = (introspection, analyticsStatus = 200) => async (url, init) =>
    String(url).endsWith("/api-keys/v1/introspect")
      ? introspection === null ? json({}, 500) : json(introspection)
      : analytics({ status: analyticsStatus }).fetch(url, init);
  const scope = (universeIds) => ({ name: "universe.analytics", operations: ["read"], universeIds });

  assert.deepEqual(await checkGameKey(API_KEY, 42, { fetch: roblox({ enabled: true, expired: false, expirationTimeUtc: "2027-01-01T00:00:00Z", scopes: [scope(["42"])] }), now: NOW }), { ok: true, expiresAt: "2027-01-01T00:00:00.000Z" });
  assert.equal((await checkGameKey(API_KEY, 42, { fetch: roblox({ enabled: true, scopes: [scope(["*"])] }), now: NOW })).ok, true);
  assert.equal((await checkGameKey(API_KEY, 42, { fetch: roblox(null), now: NOW })).ok, true, "introspection is optional; the test query decides");
  assert.match((await checkGameKey(API_KEY, 42, { fetch: roblox({ enabled: false }), now: NOW })).message, /disabled/);
  assert.match((await checkGameKey(API_KEY, 42, { fetch: roblox({ enabled: true, expired: true }), now: NOW })).message, /expired/);
  assert.match((await checkGameKey(API_KEY, 42, { fetch: roblox({ enabled: true, scopes: [scope(["7"])] }), now: NOW })).message, /can't read this game/);
  assert.match((await checkGameKey(API_KEY, 42, { fetch: roblox(null, 401), now: NOW })).message, /rejected this key/);
  assert.equal((await introspectKey(API_KEY, { fetch: async () => { throw new Error("offline"); } })), null);
});

test("linked games belong to their account: the key never comes back and other accounts can't reach them", async (t) => {
  const db = await database(t);
  const owner = await account(db, 1);
  const stranger = await account(db, 2);
  const game = await link(db, owner);
  assert.equal(game.keyHint, "WXYZ");
  assert.equal(game.collect, true);
  assert.equal(game.share, false, "Help improve Romanum is off by default");
  assert.equal(game.status, "active");
  assert.ok(!JSON.stringify(await listLinkedGames(db, owner)).includes(API_KEY));
  assert.ok(!JSON.stringify((await db.query("SELECT * FROM linked_game_keys")).rows).includes("open-cloud-key"), "the key is stored sealed");

  assert.deepEqual(await listLinkedGames(db, stranger), []);
  assert.equal(await readLinkedGame(db, stranger, game.id), null);
  assert.equal(await setCollect(db, stranger, game.id, false), null);
  assert.equal(await setShare(db, stranger, game.id, true), null);
  assert.equal(await disconnectGame(db, stranger, game.id), null);
  assert.equal(await deleteLinkedGame(db, stranger, game.id), false);
  assert.equal((await readLinkedGame(db, owner, game.id)).collect, true, "the stranger changed nothing");

  await syncLinkedGame(db, game.id, { fetch: analytics().fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS });
  assert.deepEqual(await readGameMetrics(db, stranger, game.id), {});
  assert.ok(Object.keys(await readGameMetrics(db, owner, game.id)).length > 0);
});

test("a sync backfills four weeks of each metric with the stored key, then refreshes recent days", async (t) => {
  const db = await database(t);
  const game = await link(db, await account(db, 1));
  const first = analytics();
  assert.deepEqual(await syncLinkedGame(db, game.id, { fetch: first.fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS }), { outcome: "synced", stored: SYNCED_METRICS.length * 28 });
  assert.deepEqual(first.queries.map((query) => query.body.metric), SYNCED_METRICS.map(({ metric }) => metric));
  assert.ok(first.queries.every((query) => query.headers["x-api-key"] === API_KEY && query.body.startTime === "2026-08-30T00:00:00.000Z" && query.body.endTime === "2026-09-27T00:00:00.000Z"));

  const metrics = await readGameMetrics(db, (await db.query("SELECT account_id FROM linked_games")).rows[0].account_id, game.id);
  assert.equal(metrics.DailyActiveUsers.length, 28);
  assert.deepEqual(metrics.DailyActiveUsers.at(-1), { day: "2026-09-26", value: 126, status: null });

  // Another sync within ten minutes is already covered.
  assert.equal((await syncLinkedGame(db, game.id, { fetch: first.fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS })).outcome, "skipped");
  await db.query("UPDATE linked_games SET sync_started_at = now() - interval '11 minutes', synced_at = now() - interval '7 hours'");
  const refresh = analytics({ value: () => 5 });
  assert.equal(await syncDueGames(db, { fetch: refresh.fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS }), 1);
  assert.equal(refresh.queries[0].body.startTime, "2026-09-17T00:00:00.000Z", "later syncs refetch the last ten days");
  assert.equal((await db.query("SELECT value FROM linked_game_metrics WHERE metric='DailyActiveUsers' AND day='2026-09-26'")).rows[0].value, 5);
  assert.equal((await db.query("SELECT value FROM linked_game_metrics WHERE metric='DailyActiveUsers' AND day='2026-09-01'")).rows[0].value, 101, "older days keep their values");
  assert.equal(await syncDueGames(db, { fetch: refresh.fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS }), 0, "nothing else is due");
});

test("turning collection off, replacing the key or deleting the game during a sync stops it writing", async (t) => {
  for (const withdraw of [
    (db, owner, game) => setCollect(db, owner, game.id, false),
    (db, owner) => link(db, owner),
    (db, owner, game) => disconnectGame(db, owner, game.id),
    (db, owner, game) => deleteLinkedGame(db, owner, game.id),
  ]) {
    const db = await database(t);
    const owner = await account(db, 1);
    const game = await link(db, owner);
    let started;
    let release;
    const inFlight = new Promise((resolve) => (started = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    const { fetch } = analytics({ onQuery: async () => { started(); await gate; } });
    const sync = syncLinkedGame(db, game.id, { fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS });
    await inFlight;
    await withdraw(db, owner, game);
    release();
    assert.deepEqual(await sync, { outcome: "discarded", stored: 0 });
    assert.equal((await db.query("SELECT count(*)::int AS count FROM linked_game_metrics")).rows[0].count, 0);
  }
});

test("collection off stops syncing; disconnecting deletes the key and keeps the metrics; deleting keeps only consent records", async (t) => {
  const db = await database(t);
  const owner = await account(db, 1);
  const game = await link(db, owner);
  await syncLinkedGame(db, game.id, { fetch: analytics().fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS });

  await setCollect(db, owner, game.id, false);
  await db.query("UPDATE linked_games SET synced_at = now() - interval '7 hours'");
  const idle = analytics();
  assert.equal((await syncLinkedGame(db, game.id, { fetch: idle.fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS })).outcome, "skipped");
  assert.equal(await syncDueGames(db, { fetch: idle.fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS }), 0);
  assert.equal(idle.queries.length, 0, "no query is made for a game that isn't collecting");

  const disconnected = await disconnectGame(db, owner, game.id);
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.keyHint, null);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM linked_game_keys")).rows[0].count, 0);
  assert.ok((await readGameMetrics(db, owner, game.id)).DailyActiveUsers.length > 0, "metrics stay until deleted");

  // Linking the game again with a new key reconnects it and keeps its choices.
  const relinked = await link(db, owner);
  assert.equal(relinked.id, game.id);
  assert.equal(relinked.status, "active");
  assert.equal(relinked.collect, false);

  assert.equal(await deleteLinkedGame(db, owner, game.id), true);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM linked_game_metrics")).rows[0].count, 0);
  assert.deepEqual(
    (await db.query("SELECT setting, enabled, notice FROM linked_game_consents ORDER BY id")).rows,
    [{ setting: "collect", enabled: true, notice: "2026-09-30" }, { setting: "collect", enabled: false, notice: "2026-09-30" }],
  );
});

test("a rejected key pauses the game until it's linked again", async (t) => {
  const db = await database(t);
  const owner = await account(db, 1);
  const game = await link(db, owner);
  assert.equal((await syncLinkedGame(db, game.id, { fetch: analytics({ status: 401 }).fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS })).outcome, "key_rejected");
  const rejected = await readLinkedGame(db, owner, game.id);
  assert.equal(rejected.status, "key_rejected");
  assert.match(rejected.syncError, /rejected/);
  assert.equal((await link(db, owner)).status, "active");

  // A secrets key that can't open the stored key asks for the game to be linked again rather than failing silently.
  await db.query("UPDATE linked_games SET sync_started_at = NULL");
  assert.equal((await syncLinkedGame(db, game.id, { fetch: analytics().fetch, sleep: noSleep, now: NOW, secretsKey: randomBytes(32) })).outcome, "key_rejected");
  assert.match((await readLinkedGame(db, owner, game.id)).syncError, /Reconnect this game through Roblox/);
});

test("Help improve Romanum shares nothing by default, and only days from when it was turned on", async (t) => {
  const db = await database(t);
  const owner = await account(db, 1);
  const game = await link(db, owner);
  await syncLinkedGame(db, game.id, { fetch: analytics().fetch, sleep: noSleep, now: NOW, secretsKey: SECRETS });
  assert.deepEqual(await metricsSharedForImprovement(db), [], "off by default");

  await setShare(db, owner, game.id, true);
  await db.query("UPDATE linked_games SET shared_since = '2026-09-25T12:00:00Z'");
  const shared = await metricsSharedForImprovement(db);
  assert.deepEqual([...new Set(shared.map((row) => row.day))], ["2026-09-25", "2026-09-26"], "earlier history isn't shared");
  assert.ok(shared.every((row) => row.universeId === 3828411582));

  await setShare(db, owner, game.id, false);
  assert.deepEqual(await metricsSharedForImprovement(db), [], "turning it off withdraws everything at once");
  assert.equal((await readLinkedGame(db, owner, game.id)).share, false);
  assert.deepEqual(
    (await db.query("SELECT setting, enabled FROM linked_game_consents WHERE setting='share' ORDER BY id")).rows,
    [{ setting: "share", enabled: true }, { setting: "share", enabled: false }],
  );
  // Setting the same value again records nothing new.
  await setShare(db, owner, game.id, false);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM linked_game_consents WHERE setting='share'")).rows[0].count, 2);
});

test("metrics display in their units, and rates read as fractions whichever scale Roblox sends", () => {
  assert.deepEqual(asFractions([0.12, null, 0.3]), [0.12, null, 0.3]);
  assert.deepEqual(asFractions([12, null, 30]), [0.12, null, 0.3]);
  assert.equal(formatMetric(0.1234, "rate"), "12.3%");
  assert.equal(formatMetric(12.345, "minutes"), "12.3 min");
  assert.equal(formatMetric(15300, "robux"), "R$15.3K");
  assert.equal(formatMetric(1520000, "count"), "1.5M");
  assert.equal(formatMetric(null, "count"), "–");
  assert.equal(new Set(SYNCED_METRICS.map(({ metric }) => metric)).size, SYNCED_METRICS.length);
});

test("OpenCloudError keeps its kind for callers", () => {
  const error = new OpenCloudError("rate_limited", "slow down");
  assert.equal(error.kind, "rate_limited");
  assert.equal(error.name, "OpenCloudError");
});
