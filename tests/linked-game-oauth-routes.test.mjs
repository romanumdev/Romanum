import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Actual route dispatch, signed attempts, scopes and connection checks; only
// Next request context, configuration and token/storage boundaries are mocked.
const SLOT = "__romanumAnalyticsRouteFixture";
const stateRef = `globalThis.${SLOT}`;
const sourceRoot = new URL("../src/", import.meta.url).href;
const KEY = randomBytes(32);
let state;
function reset({ enabled = true, signedIn = true } = {}) {
  const values = new Map();
  state = {
    env: { ROBLOX_CLIENT_ID: "fixture-client", ROBLOX_CLIENT_SECRET: "fixture-secret", ...(enabled ? { ROBLOX_ANALYTICS_OAUTH_ENABLED: "true" } : {}) },
    account: signedIn ? { id: randomUUID(), robloxUserId: 42, ownerId: "fixture-owner" } : null,
    counters: { account: 0, database: 0, verification: 0, secrets: 0, signIn: 0, analyticsExchange: 0, saveGame: 0, signInAccount: 0, startSession: 0, guest: 0, forgetGuest: 0, after: 0 },
    values, writes: [], key: KEY, database: { fixture: true }, verifiedActions: [],
  };
  state.cookies = {
    get: name => values.has(name) ? { value: values.get(name) } : undefined,
    set: (name, value, options) => { state.writes.push({ name, value, options }); if (options?.maxAge === 0) values.delete(name); else values.set(name, value); },
  };
  globalThis[SLOT] = state;
  return state;
}
reset();
const mocks = {
  "next/headers": `export const cookies = async () => ${stateRef}.cookies;`,
  "next/navigation": "export function redirect(destination) { const error = new Error('Fixture redirect'); error.destination = destination; throw error; }",
  "next/server": `export const after = () => { ${stateRef}.counters.after++; };`,
  "lib/accounts/session.ts": `export const SESSION_COOKIE='romanum_session'; export const readAccount=async()=>{${stateRef}.counters.account++;return ${stateRef}.account;};`,
  "lib/history/database.ts": `export const historyDatabase=async()=>{${stateRef}.counters.database++;return ${stateRef}.database;};`,
  "lib/guest.ts": `export const isCrossSite=request=>request.headers.get('sec-fetch-site')==='cross-site';export const readGuest=async()=>{${stateRef}.counters.guest++;return null;};export const forgetGuest=async()=>{${stateRef}.counters.forgetGuest++;};`,
  "lib/turnstile.ts": `export const requestOrigin=request=>new URL(request.url).origin;export const verifyTurnstile=async(request,action)=>{${stateRef}.counters.verification++;${stateRef}.verifiedActions.push(action);};export const verificationResponse=()=>null;`,
  "lib/accounts/store.ts": `export const signInAccount=async(db,profile,guest)=>{${stateRef}.counters.signInAccount++;${stateRef}.profile=profile;${stateRef}.adoptedGuest=guest;return {account:{id:'fixture-new-account'},adoptedGuest:false};};export const startSession=async()=>{${stateRef}.counters.startSession++;return {token:'fixture-new-session',expiresAt:new Date('2035-01-01T00:00:00Z')};};`,
  "lib/linked-games/store.ts": `export const saveGameOAuthGrant=async()=>{throw new Error('Unexpected direct OAuth storage');};export const saveOAuthLinkedGame=async(db,input,key)=>{${stateRef}.counters.saveGame++;${stateRef}.savedGame={db,input,key};return {id:'fixture-linked-game'};};`,
  "lib/linked-games/sync.ts": "export const syncDueGames=async()=>{throw new Error('Unexpected sync');};",
  "lib/linked-games/view.ts": "export const linkedGameViews=async()=>{throw new Error('Unexpected game read');};",
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in mocks && specifier.startsWith("next/")) return { url: `fixture:${specifier}`, shortCircuit: true };
    let target;
    if (specifier.startsWith("@/")) target = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
    else if (specifier.startsWith(".") && context.parentURL?.startsWith(sourceRoot)) target = new URL(specifier, context.parentURL);
    if (target && !existsSync(fileURLToPath(target))) {
      for (const extension of [".ts", ".tsx"]) if (existsSync(fileURLToPath(`${target.href}${extension}`))) return nextResolve(`${target.href}${extension}`, context);
    }
    return nextResolve(target?.href ?? specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("fixture:")) return { format: "module", shortCircuit: true, source: mocks[url.slice(8)] };
    if (url.startsWith(sourceRoot) && url.endsWith(".ts")) {
      const relative = url.slice(sourceRoot.length);
      if (relative in mocks) return { format: "module", shortCircuit: true, source: mocks[relative] };
      let source = readFileSync(fileURLToPath(url), "utf8");
      if (relative === "lib/accounts/roblox-oauth.ts") {
        source = source.replaceAll("process.env", `${stateRef}.env`).replace("export async function completeSignIn(", "async function originalCompleteSignIn(");
        source += `\nexport const completeSignIn=async(client,input)=>{${stateRef}.counters.signIn++;${stateRef}.signInInput={client,input};return {userId:42,username:'fixture',displayName:'Fixture',pictureUrl:null};};`;
      }
      if (relative === "lib/linked-games/connection.ts") source = source.replaceAll("process.env", `${stateRef}.env`);
      if (relative === "lib/secrets.ts") {
        source = source.replace("export function secretsKey(", "function originalSecretsKey(");
        source += `\nexport const secretsKey=async()=>{${stateRef}.counters.secrets++;return ${stateRef}.key;};`;
      }
      if (relative === "lib/linked-games/oauth.ts") {
        source = source.replace("export async function exchangeAnalyticsAuthorization(", "async function originalExchangeAnalyticsAuthorization(");
        source += `\nexport const exchangeAnalyticsAuthorization=async(client,input,target)=>{${stateRef}.counters.analyticsExchange++;${stateRef}.analyticsInput={client,input,target};return {access_token:'fixture-access',refresh_token:'fixture-refresh',scopes:['universe.analytics:read'],expiresAt:'2035-01-01T00:00:00Z',subject:String(target.robloxUserId),universeId:target.universeId,resourceOwners:[{id:'42',type:'User'}]};};`;
      }
      return { format: "module", shortCircuit: true, source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    }
    return nextLoad(url, context);
  },
});
const analyticsStart = await import("../src/app/auth/roblox/analytics/route.ts");
const ordinaryStart = await import("../src/app/auth/roblox/route.ts");
const callback = await import("../src/app/auth/roblox/callback/route.ts");
const legacy = await import("../src/app/api/linked-games/route.ts");
const { SIGN_IN_COOKIE, newSignInAttempt } = await import("../src/lib/accounts/roblox-oauth.ts");
const { ANALYTICS_CONNECTION_COOKIE, newConnectionAttempt, connectionTarget } = await import("../src/lib/linked-games/connection.ts");
const { signAttempt, verifiedAttempt } = await import("../src/lib/accounts/sign-in-cookie.ts");
hooks.deregister();

const request = (path, body = { universeId: "100" }, headers = {}) => new Request(`https://romanum.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://romanum.test", ...headers }, body: JSON.stringify(body) });
async function redirected(operation, destination) {
  await assert.rejects(operation, error => error.destination === destination);
}
function attempts() {
  const normal = newSignInAttempt("/profile");
  const analytics = newConnectionAttempt(state.account.id, 100);
  state.values.set(SIGN_IN_COOKIE.name, signAttempt(normal, KEY));
  state.values.set(ANALYTICS_CONNECTION_COOKIE.name, signAttempt(analytics, KEY));
  state.values.set("romanum_session", "fixture-existing-session");
  return { normal, analytics };
}

test("cross-site and mismatched-origin starts reject before authentication, storage or verification", async () => {
  for (const start of [analyticsStart, ordinaryStart]) {
    for (const headers of [{ "sec-fetch-site": "cross-site" }, { Origin: "https://other.test" }]) {
      reset();
      const response = await start.POST(request("/auth/roblox/analytics", { universeId: "100" }, headers));
      assert.equal(response.status, 403);
      assert.ok(Object.values(state.counters).every(count => count === 0));
      assert.deepEqual(state.writes, []);
    }
  }
});

test("analytics start is disabled by default, rejects API-key extras and writes only a signed analytics attempt", async () => {
  reset({ enabled: false });
  assert.equal((await analyticsStart.POST(request("/auth/roblox/analytics"))).status, 503);
  assert.equal(state.counters.verification, 0); assert.equal(state.counters.database, 0); assert.deepEqual(state.writes, []);
  reset({ signedIn: false });
  assert.equal((await analyticsStart.POST(request("/auth/roblox/analytics"))).status, 401);
  assert.equal(state.counters.verification, 0); assert.equal(state.counters.database, 0);
  reset();
  assert.equal((await analyticsStart.POST(request("/auth/roblox/analytics", { universeId: "100", apiKey: "unaccepted-fixture-key" }))).status, 400);
  assert.equal(state.counters.verification, 0); assert.deepEqual(state.writes, []);
  const response = await analyticsStart.POST(request("/auth/roblox/analytics"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const url = new URL((await response.json()).url);
  assert.equal(url.searchParams.get("scope"), "openid profile universe.analytics:read");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(state.writes.length, 1);
  const cookie = state.writes[0];
  assert.equal(cookie.name, ANALYTICS_CONNECTION_COOKIE.name); assert.equal(cookie.options.httpOnly, true); assert.equal(cookie.options.sameSite, "lax");
  const signed = verifiedAttempt(cookie.value, KEY);
  assert.deepEqual(connectionTarget(signed), { accountId: state.account.id, universeId: 100 });
  assert.equal(signed.state, url.searchParams.get("state"));
  assert.equal(state.values.has(SIGN_IN_COOKIE.name), false);
  assert.deepEqual(state.verifiedActions, ["roblox_signin"]);
});

test("ordinary sign-in start retains identity-only scope and standard attempt cookie", async () => {
  reset({ enabled: false });
  const response = await ordinaryStart.POST(request("/auth/roblox", {}));
  assert.equal(response.status, 200);
  assert.equal(new URL((await response.json()).url).searchParams.get("scope"), "openid profile");
  assert.deepEqual(state.writes.map(cookie => cookie.name), [SIGN_IN_COOKIE.name]);
  assert.equal(state.values.has(ANALYTICS_CONNECTION_COOKIE.name), false);
});

test("retired API-key POST returns 410 without reading the body, keys or database", async () => {
  reset();
  const input = request("/api/linked-games", { universeId: "100", apiKey: "unaccepted-fixture-key" });
  input.json = input.text = input.arrayBuffer = async () => assert.fail("retired endpoint must not consume credentials");
  assert.equal((await legacy.POST(input)).status, 410);
  assert.equal(state.counters.database, 0); assert.equal(state.counters.secrets, 0); assert.equal(state.counters.verification, 0); assert.equal(state.counters.saveGame, 0); assert.deepEqual(state.writes, []);
  reset();
  assert.equal((await legacy.POST(request("/api/linked-games", {}, { "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal(state.counters.account, 0);
});

test("matching analytics callback consumes its attempt only and preserves the current session and concurrent ordinary sign-in", async () => {
  reset(); const { normal, analytics } = attempts();
  const normalValue = state.values.get(SIGN_IN_COOKIE.name);
  await redirected(callback.GET(new Request(`https://romanum.test/auth/roblox/callback?code=fixture-code&state=${analytics.state}`)), "/profile/settings/games?connection=connected#link-game");
  assert.equal(state.values.has(ANALYTICS_CONNECTION_COOKIE.name), false);
  assert.equal(state.values.get(SIGN_IN_COOKIE.name), normalValue);
  assert.equal(verifiedAttempt(normalValue, KEY).state, normal.state);
  assert.equal(state.values.get("romanum_session"), "fixture-existing-session");
  assert.deepEqual(state.writes.map(cookie => cookie.name), [ANALYTICS_CONNECTION_COOKIE.name]);
  assert.equal(state.counters.analyticsExchange, 1); assert.equal(state.counters.saveGame, 1);
  assert.equal(state.counters.signIn, 0); assert.equal(state.counters.startSession, 0); assert.equal(state.counters.signInAccount, 0); assert.equal(state.counters.forgetGuest, 0);
  assert.deepEqual(state.analyticsInput.target, { robloxUserId: 42, universeId: 100 });
  assert.equal(state.savedGame.input.accountId, state.account.id);
});

test("matching ordinary callback consumes standard attempt only and continues the existing account/session flow", async () => {
  reset(); const { normal } = attempts();
  const analyticsValue = state.values.get(ANALYTICS_CONNECTION_COOKIE.name);
  await redirected(callback.GET(new Request(`https://romanum.test/auth/roblox/callback?code=fixture-code&state=${normal.state}`)), "/profile");
  assert.equal(state.values.has(SIGN_IN_COOKIE.name), false);
  assert.equal(state.values.get(ANALYTICS_CONNECTION_COOKIE.name), analyticsValue);
  assert.equal(state.values.get("romanum_session"), "fixture-new-session");
  assert.deepEqual(state.writes.map(cookie => cookie.name), [SIGN_IN_COOKIE.name, "romanum_session"]);
  assert.equal(state.counters.signIn, 1); assert.equal(state.counters.signInAccount, 1); assert.equal(state.counters.startSession, 1);
  assert.equal(state.counters.analyticsExchange, 0); assert.equal(state.counters.saveGame, 0);
  assert.equal(state.signInInput.input.nonce, normal.nonce); assert.equal(state.signInInput.input.verifier, normal.verifier);
});
