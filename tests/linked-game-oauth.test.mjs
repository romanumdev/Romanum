import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { openSecret } from "../src/lib/secrets.ts";
import { newSignInAttempt, ROBLOX_OAUTH } from "../src/lib/accounts/roblox-oauth.ts";
import { ANALYTICS_SCOPE, authorizationUrl, exchangeAnalyticsAuthorization, saveGameOAuthGrant, openGameOAuthCredential } from "../src/lib/linked-games/oauth.ts";
import { analyticsOAuthEnabled, connectionUniverseId, newConnectionAttempt, connectionTarget, completeAnalyticsConnection } from "../src/lib/linked-games/connection.ts";
import * as store from "../src/lib/linked-games/store.ts";
import { queryDailyMetric } from "../src/lib/linked-games/open-cloud.ts";

const CLIENT = { clientId: "fixture-client", clientSecret: "fixture-secret" };
const KEY = randomBytes(32);
const LEGACY_KEY = "fixture-legacy-api-key-0123456789";
const RESOURCE_URL = "https://apis.roblox.com/oauth/v1/token/resources";
const json = (body, status = 200) => Response.json(body, { status });
const grant = (subject = "42", universeId = 100) => ({ access_token: "fixture-access", refresh_token: "fixture-refresh", scopes: ["openid", "profile", ANALYTICS_SCOPE], expiresAt: new Date(Date.now() + 3600_000).toISOString(), subject, universeId, resourceOwners: [{ id: "42", type: "User" }] });
const resources = (ids = ["100"], owner = { id: "42", type: "User" }) => ({ resource_infos: [{ owner, resources: { universe: { ids } } }] });
const oauthRow = async (db, gameId) => (await db.query("SELECT * FROM linked_game_oauth WHERE game_id=$1", [gameId])).rows[0];
const plaintext = (row, accountId, gameId, key = KEY) => JSON.parse(openSecret({ keyVersion: row.key_version, iv: row.iv, ciphertext: row.ciphertext, tag: row.tag }, `linked-game-oauth:${accountId}:${gameId}`, key));

async function fixture(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const adapter = client => ({ query: (sql, values) => client.query(sql, values), exec: async sql => { await client.exec(sql); } });
  const db = { ...adapter(engine), transaction: fn => engine.transaction(client => fn(adapter(client))), close: () => engine.close() };
  for (const file of ["012_accounts.sql", "013_linked_games.sql", "020_private_analytics_ai.sql", "027_linked_game_oauth.sql"]) await db.exec(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), "utf8"));
  async function account(userId) {
    const id = randomUUID();
    await db.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name) VALUES($1,$2,$3,'Fixture','Fixture')", [id, userId, `account:${id}`]);
    return id;
  }
  const accountId = await account(42), foreignAccountId = await account(43);
  const game = await store.saveLinkedGame(db, { accountId, universeId: 100, apiKey: LEGACY_KEY, keyExpiresAt: null }, KEY);
  const secondGame = await store.saveLinkedGame(db, { accountId, universeId: 101, apiKey: LEGACY_KEY, keyExpiresAt: null }, KEY);
  return { db, accountId, foreignAccountId, game, secondGame };
}

function authorizationMock(input, changes = {}) {
  const calls = [];
  const now = Date.now();
  const claims = { iss: ROBLOX_OAUTH.issuer, aud: CLIENT.clientId, exp: Math.floor(now / 1000) + 3600, nonce: input.nonce, sub: "42", ...changes.claims };
  const idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === ROBLOX_OAUTH.token) return json({ access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope: `openid profile ${ANALYTICS_SCOPE}`, id_token: idToken, ...changes.tokens });
    if (String(url) === ROBLOX_OAUTH.userinfo) return json({ sub: claims.sub, name: "Fixture", preferred_username: "fixture", ...changes.userinfo });
    if (String(url) === RESOURCE_URL) return json(changes.resources ?? resources());
    assert.fail(`Unexpected mocked URL: ${url}`);
  };
  return { fetch, calls, now };
}

test("analytics authorization requests exact scope and validates identity plus explicit universe grants", async () => {
  const attempt = newSignInAttempt("/profile");
  const redirectUri = "https://romanum.test/auth/roblox/callback";
  const url = new URL(authorizationUrl(CLIENT, attempt, redirectUri));
  assert.equal(url.searchParams.get("scope"), `openid profile ${ANALYTICS_SCOPE}`);
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), attempt.state);
  const input = { code: "fixture-code", verifier: attempt.verifier, nonce: attempt.nonce, redirectUri };
  const mock = authorizationMock(input, { resources: resources(["100"], { id: "88", type: "Group" }) });
  const authorized = await exchangeAnalyticsAuthorization(CLIENT, input, { robloxUserId: 42, universeId: 100 }, mock);
  assert.equal(authorized.subject, "42"); assert.equal(authorized.universeId, 100);
  assert.deepEqual(authorized.resourceOwners, [{ id: "88", type: "Group" }]);
  assert.deepEqual(mock.calls.map(call => call.url), [ROBLOX_OAUTH.token, ROBLOX_OAUTH.userinfo, RESOURCE_URL]);
  assert.equal(new Headers(mock.calls[1].init.headers).get("authorization"), "Bearer fixture-access");
  assert.equal(new URLSearchParams(mock.calls[0].init.body).get("code_verifier"), attempt.verifier);
  for (const ids of [["*"], ["U/*"], ["universes/*"], ["universes/100"], ["101"], []]) {
    await assert.rejects(exchangeAnalyticsAuthorization(CLIENT, input, { robloxUserId: 42, universeId: 100 }, authorizationMock(input, { resources: resources(ids) })), error => error.kind === "reconnect_required");
  }
  for (const changes of [{ tokens: { scope: "openid profile" } }, { tokens: { scope: "openid profile universe.analytics:write" } }]) {
    await assert.rejects(exchangeAnalyticsAuthorization(CLIENT, input, { robloxUserId: 42, universeId: 100 }, authorizationMock(input, changes)), error => error.kind === "reconnect_required");
  }
  const wrongIdentity = authorizationMock(input);
  await assert.rejects(exchangeAnalyticsAuthorization(CLIENT, input, { robloxUserId: 43, universeId: 100 }, wrongIdentity), error => error.kind === "invalid_grant");
  assert.equal(wrongIdentity.calls.length, 2, "wrong signed-in identity cannot proceed to resource authorization");
  for (const changes of [{ claims: { nonce: "wrong" } }, { claims: { aud: "other-app" } }, { userinfo: { sub: "43" } }]) await assert.rejects(exchangeAnalyticsAuthorization(CLIENT, input, { robloxUserId: 42, universeId: 100 }, authorizationMock(input, changes)));
});

test("connection input excludes API keys and binds a separate attempt to the account and universe", async () => {
  assert.equal(analyticsOAuthEnabled({}), false);
  assert.equal(analyticsOAuthEnabled({ ROBLOX_ANALYTICS_OAUTH_ENABLED: "true" }), false);
  assert.equal(analyticsOAuthEnabled({ ROBLOX_ANALYTICS_OAUTH_ENABLED: "true", ROBLOX_CLIENT_ID: CLIENT.clientId, ROBLOX_CLIENT_SECRET: CLIENT.clientSecret }), true);
  assert.equal(connectionUniverseId({ universeId: "100" }), 100);
  for (const body of [{ universeId: "100", apiKey: LEGACY_KEY }, { universeId: 100 }, { universeId: "0" }, { universeId: "9007199254740992" }, { universeId: "1e2" }, { universeId: "-1" }, { universeId: "1.5" }]) assert.equal(connectionUniverseId(body), null);
  const accountId = randomUUID();
  const attempt = newConnectionAttempt(accountId, 100);
  assert.deepEqual(connectionTarget(attempt), { accountId, universeId: 100 });
  assert.equal(connectionTarget(newSignInAttempt("/profile")), null);
  assert.equal(connectionTarget({ ...attempt, next: `${attempt.next}&other=1` }), null);
  let reads = 0;
  const db = { query: async () => { reads++; assert.fail("invalid attempt must not read private data"); } };
  const callback = `https://romanum.test/auth/roblox/callback?code=fixture&state=${attempt.state}`;
  assert.match(await completeAnalyticsConnection(callback, attempt, { id: randomUUID(), robloxUserId: 42 }, db, KEY, { client: CLIENT, fetch: async () => assert.fail("wrong account must not exchange tokens"), redirectUri: "https://romanum.test/callback" }), /connection=wrong_account/);
  assert.match(await completeAnalyticsConnection(callback.replace(attempt.state, "wrong-state"), attempt, { id: accountId, robloxUserId: 42 }, db, KEY, { redirectUri: "https://romanum.test/auth/roblox/callback" }), /connection=failed/);
  assert.equal(reads, 0);
});

test("OAuth grants are encrypted per account/game and reconnect storage preserves legacy sealed keys", async t => {
  const { db, accountId, foreignAccountId, game, secondGame } = await fixture(t);
  const legacy = (await db.query("SELECT * FROM linked_game_keys WHERE game_id=$1", [game.id])).rows[0];
  await store.setCollect(db, accountId, game.id, false);
  const reconnected = await store.saveOAuthLinkedGame(db, { accountId, universeId: 100, grant: grant() }, KEY);
  assert.equal(reconnected.id, game.id); assert.equal(reconnected.collect, false);
  assert.equal(reconnected.authorization, "oauth"); assert.equal(reconnected.keyHint, null);
  const stored = await oauthRow(db, game.id);
  assert.equal(plaintext(stored, accountId, game.id).access_token, "fixture-access");
  assert.ok(!Buffer.from(stored.ciphertext).toString("utf8").includes("fixture-access"));
  assert.throws(() => plaintext(stored, foreignAccountId, game.id));
  assert.throws(() => plaintext(stored, accountId, secondGame.id));
  await assert.rejects(saveGameOAuthGrant(db, foreignAccountId, game.id, grant(), KEY), error => error.kind === "invalid_grant");
  await assert.rejects(saveGameOAuthGrant(db, accountId, secondGame.id, grant(), KEY), error => error.kind === "invalid_grant");
  await assert.rejects(saveGameOAuthGrant(db, accountId, game.id, grant("43"), KEY), error => error.kind === "invalid_grant");
  assert.deepEqual((await db.query("SELECT * FROM linked_game_keys WHERE game_id=$1", [game.id])).rows[0], legacy);
  assert.equal(await openGameOAuthCredential(db, accountId, secondGame.id, KEY, { client: CLIENT, fetch: async () => assert.fail("absent OAuth must not contact Roblox") }), null);
  assert.equal(await store.openGameCredential(db, accountId, secondGame.id, KEY, { client: CLIENT, fetch: async () => assert.fail("legacy credential must not make OAuth calls") }), LEGACY_KEY);
  assert.equal(await store.openGameCredential(db, foreignAccountId, game.id, KEY, { client: CLIENT, fetch: async () => assert.fail("foreign account must not authorize") }), null);
  await assert.rejects(store.openGameCredential(db, accountId, game.id, KEY, { client: CLIENT, fetch: async () => json({}, 503) }), error => error.kind === "unavailable");
  await db.query("UPDATE linked_game_oauth SET ciphertext=$2 WHERE game_id=$1", [game.id, Buffer.from("altered encrypted data")]);
  await assert.rejects(openGameOAuthCredential(db, accountId, game.id, KEY, { client: CLIENT, fetch: async () => assert.fail("corrupted OAuth must not fall back or contact Roblox") }), error => error.kind === "reconnect_required");
  assert.equal((await oauthRow(db, game.id)).reconnect_required, true);
  await assert.rejects(store.openGameCredential(db, accountId, game.id, KEY, { client: CLIENT, fetch: async () => assert.fail("reconnect marker must not call Roblox or reuse legacy key") }), error => error.kind === "key_rejected");
  assert.deepEqual((await db.query("SELECT * FROM linked_game_keys WHERE game_id=$1", [game.id])).rows[0], legacy);
});

test("the separate callback connects the requested game without replacing settings, data or legacy credentials", async t => {
  const { db, accountId, game } = await fixture(t);
  await store.setCollect(db, accountId, game.id, false);
  await store.setShare(db, accountId, game.id, true);
  await store.setAiAnalysis(db, accountId, game.id, true);
  await db.query("INSERT INTO linked_game_metrics(game_id,metric,day,value) VALUES($1,'DailyActiveUsers','2026-09-01',23)", [game.id]);
  const before = await store.readLinkedGame(db, accountId, game.id);
  const legacy = (await db.query("SELECT * FROM linked_game_keys WHERE game_id=$1", [game.id])).rows[0];
  const attempt = newConnectionAttempt(accountId, 100);
  const redirectUri = "https://romanum.test/auth/roblox/callback";
  const callback = `${redirectUri}?code=fixture-code&state=${attempt.state}`;
  const mock = authorizationMock({ nonce: attempt.nonce });
  const options = { ...mock, client: CLIENT, redirectUri };
  assert.match(await completeAnalyticsConnection(callback, attempt, { id: accountId, robloxUserId: 42 }, db, KEY, options), /connection=connected/);
  const after = await store.readLinkedGame(db, accountId, game.id);
  assert.equal(after.id, before.id);
  for (const choice of ["collect", "share", "aiAnalysis"]) assert.equal(after[choice], before[choice]);
  assert.equal(after.authorization, "oauth");
  assert.equal(after.keyExpiresAt, null, "short-lived OAuth expiry does not mean a refreshable connection has expired");
  assert.equal((await db.query("SELECT value FROM linked_game_metrics WHERE game_id=$1", [game.id])).rows[0].value, 23);
  assert.deepEqual((await db.query("SELECT * FROM linked_game_keys WHERE game_id=$1", [game.id])).rows[0], legacy);
  const saved = await oauthRow(db, game.id);
  assert.match(await completeAnalyticsConnection(callback, attempt, { id: accountId, robloxUserId: 42 }, db, KEY, { ...authorizationMock({ nonce: attempt.nonce }, { resources: resources(["101"]) }), client: CLIENT, redirectUri }), /connection=not_authorized/);
  assert.deepEqual((await oauthRow(db, game.id)).ciphertext, saved.ciphertext, "failed reconnect preserves the existing grant");
  await db.query("UPDATE linked_game_oauth SET expires_at=now()-interval '1 minute' WHERE game_id=$1", [game.id]);
  assert.equal((await store.readLinkedGame(db, accountId, game.id)).keyExpiresAt, null);
  await db.query("UPDATE linked_game_oauth SET reconnect_required=true WHERE game_id=$1", [game.id]);
  assert.equal((await store.readLinkedGame(db, accountId, game.id)).status, "key_rejected");
});

test("expired tokens rotate once across concurrent reads and retain the rotated refresh token", async t => {
  const { db, accountId, game } = await fixture(t);
  await saveGameOAuthGrant(db, accountId, game.id, grant(), KEY);
  const before = await oauthRow(db, game.id);
  const now = Date.parse(grant().expiresAt) + 1000;
  let refreshes = 0, checks = 0;
  const fetch = async (url, init) => {
    const body = new URLSearchParams(init.body);
    if (String(url) === ROBLOX_OAUTH.token) {
      refreshes++;
      assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.get("refresh_token"), "fixture-refresh");
      return json({ access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600, scope: `openid profile ${ANALYTICS_SCOPE}` });
    }
    assert.equal(String(url), RESOURCE_URL); checks++; assert.equal(body.get("token"), "rotated-access"); return json(resources());
  };
  const result = await Promise.all([1, 2].map(() => openGameOAuthCredential(db, accountId, game.id, KEY, { client: CLIENT, fetch, now })));
  assert.deepEqual(result, [{ accessToken: "rotated-access" }, { accessToken: "rotated-access" }]);
  assert.equal(refreshes, 1); assert.equal(checks, 2);
  const rotated = await oauthRow(db, game.id);
  assert.notDeepEqual(rotated.ciphertext, before.ciphertext);
  assert.equal(plaintext(rotated, accountId, game.id).refresh_token, "rotated-refresh");
  assert.equal(rotated.reconnect_required, false);
});

test("ambiguous refresh is never retried and preserves ciphertext behind a committed reconnect marker", async t => {
  const { db, accountId, game } = await fixture(t);
  const value = grant(); await saveGameOAuthGrant(db, accountId, game.id, value, KEY);
  const before = await oauthRow(db, game.id); let calls = 0;
  const options = { client: CLIENT, now: Date.parse(value.expiresAt) + 1, fetch: async () => { calls++; throw new Error("ambiguous network interruption containing private diagnostics"); } };
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(openGameOAuthCredential(db, accountId, game.id, KEY, options), error => error.kind === "reconnect_required" && !error.message.includes("private diagnostics"));
  const after = await oauthRow(db, game.id);
  assert.equal(calls, 1); assert.equal(after.reconnect_required, true);
  assert.deepEqual(after.ciphertext, before.ciphertext); assert.deepEqual(after.iv, before.iv); assert.deepEqual(after.tag, before.tag);
});

test("successful refresh rotation survives unavailable resource checks and rejected grants preserve rotated ciphertext", async t => {
  const { db, accountId, game } = await fixture(t);
  const value = grant(); await saveGameOAuthGrant(db, accountId, game.id, value, KEY);
  let refreshes = 0;
  const now = Date.parse(value.expiresAt) + 1;
  const fetch = async url => {
    if (String(url) === ROBLOX_OAUTH.token) { refreshes++; return json({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600, scope: ANALYTICS_SCOPE }); }
    return json({}, 503);
  };
  await assert.rejects(openGameOAuthCredential(db, accountId, game.id, KEY, { client: CLIENT, fetch, now }), error => error.kind === "unavailable");
  const rotated = await oauthRow(db, game.id);
  assert.equal(plaintext(rotated, accountId, game.id).refresh_token, "new-refresh"); assert.equal(rotated.reconnect_required, false);
  await assert.rejects(openGameOAuthCredential(db, accountId, game.id, KEY, { client: CLIENT, now, fetch: async url => { assert.equal(String(url), RESOURCE_URL); return json(resources(["101"])); } }), error => error.kind === "reconnect_required");
  const rejected = await oauthRow(db, game.id);
  assert.equal(refreshes, 1); assert.equal(rejected.reconnect_required, true); assert.deepEqual(rejected.ciphertext, rotated.ciphertext);
});

test("OAuth analytics queries and operation polls both send Bearer authorization without an API-key header", async () => {
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return requests.length === 1
      ? json({ path: "v1/universes/100/operations/metrics/fixture", done: false }, 202)
      : json({ done: true, response: { values: [{ breakdowns: [], dataPoints: [{ time: "2026-09-01T00:00:00Z", value: 23 }] }] } });
  };
  assert.deepEqual(await queryDailyMetric({ accessToken: "fixture-bearer" }, 100, "DailyActiveUsers", { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-09-02T00:00:00Z") }, { fetch, sleep: async () => {} }), [{ day: "2026-09-01", value: 23, status: null }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[1].url, "https://apis.roblox.com/analytics-query-api/v1/universes/100/operations/metrics/fixture");
  for (const { init } of requests) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-bearer");
    assert.equal(headers.has("x-api-key"), false);
  }
});
