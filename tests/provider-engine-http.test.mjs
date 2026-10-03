import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { assistantBilling } from "../src/lib/assistant/billing.ts";
import { assistantRequest } from "../src/lib/assistant/engine.ts";
import { resolveAssistantModel } from "../src/lib/assistant/model-selection.ts";
import { grantCredits, getBalance } from "../src/lib/credits/ledger.ts";
import { costUsage } from "../src/lib/models/usage.ts";
import { submitChatQuestion, readChatRun } from "../src/lib/chats/runs.ts";
import { readChat } from "../src/lib/chats/store.ts";
import { CHAT_PROMPT } from "../src/lib/chats/prompt.ts";
import * as openai from "./fixtures/openai-provider.mjs";
import * as anthropic from "./fixtures/anthropic-provider.mjs";
import * as deepseek from "./fixtures/deepseek-provider.mjs";

// Actual API/engine/native HTTP parsing/wallet integration. Only trusted authentication,
// server review configuration and transport are synthetic. No environment mutations.
const src = fileURLToPath(new URL("../src/", import.meta.url));
const moduleUrl = relative => new URL(relative, new URL("../src/", import.meta.url)).href;
const virtual = code => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
const overrides = {
  "@/lib/history/database": "export async function historyDatabase(){const f=globalThis.__providerHttp; f.storage++; return f.db;}",
  "@/lib/accounts/session": "export async function ensureOwner(){return globalThis.__providerHttp.ownerId;} export async function readAccount(){return null;}",
  "@/lib/credits/guest": `import {getBalance} from ${JSON.stringify(moduleUrl("lib/credits/ledger.ts"))}; export function welcomeGuest(db,ownerId){return getBalance(db,{ownerId});}`,
  "@/lib/assistant/model-selection": `import * as real from ${JSON.stringify(moduleUrl("lib/assistant/model-selection.ts"))};
    export const ModelSelectionError=real.ModelSelectionError; export const requestModelSelection=real.requestModelSelection;
    export function assertSelectionReady(selection){const f=globalThis.__providerHttp; return real.assertSelectionReady(selection,f.environment,f.reviews);}
    export function resolveAssistantModel(selection,request,balance){const f=globalThis.__providerHttp; return real.resolveAssistantModel(selection,request,balance,f.environment,f.at,f.reviews);}`,
  "@/lib/assistant/engine": `export {assistantRequest,runAssistant} from ${JSON.stringify(moduleUrl("lib/assistant/engine.ts"))};
    export function assistantClient(){globalThis.__providerHttp.deepseekClients++; throw new Error('Native HTTP route constructed a DeepSeek client');}`,
  "@/lib/assistant/billing": `import {assistantBilling as real} from ${JSON.stringify(moduleUrl("lib/assistant/billing.ts"))};
    export function assistantBilling(db,ownerId,feature){const f=globalThis.__providerHttp; f.billing=real(db,ownerId,feature,{...f.context,options:f.providerOptions}); return f.billing;}`,
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (overrides[specifier] && context.parentURL?.includes("/src/app/api/")) return virtual(overrides[specifier]);
  if (context.parentURL?.includes("/src/") && specifier.startsWith("next/") && !path.extname(specifier)) return next(`${specifier}.js`, context);
  if (specifier.startsWith("@/")) {
    const base = path.resolve(src, specifier.slice(2));
    const candidate = [base, `${base}.ts`].find(file => existsSync(file) && statSync(file).isFile());
    if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
  }
  if (context.parentURL?.startsWith(pathToFileURL(src).href) && specifier.startsWith(".") && !path.extname(specifier)) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(`${base}.ts`)) return { url: pathToFileURL(`${base}.ts`).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const ask = await import("../src/app/api/assistant/route.ts");
const { executeChatRun } = await import("../src/lib/chats/run-worker.ts");
hooks.deregister();

const at = "2026-10-03T07:00:00.000Z";
const modelIds = ["gpt-6-luna", "claude-haiku-4-5-20251001", deepseek.modelId];
const reviews = Object.fromEntries(modelIds.map(modelId => [modelId, { adapterSupported: true, executionEnabled: true }]));
async function fixture(t, { modelId = "gpt-6-luna", enabled = true, credits = 10_000, mismatch = false } = {}) {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: operation => engine.transaction(client => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  const ownerId = `fixture:${randomUUID()}`, context = { conversationId: randomUUID(), runId: null };
  await grantCredits(db, { ownerId, amount: credits, operationId: `fixture-grant:${ownerId}` });
  const f = { db, ownerId, context, modelId, at, environment: { OPENAI_API_KEY: "synthetic-only", ANTHROPIC_API_KEY: "synthetic-only", DEEPSEEK_API_KEY: "synthetic-only" },
    reviews: enabled ? reviews : Object.fromEntries(modelIds.map(id => [id, { adapterSupported: true, executionEnabled: false }])), requests: [], storage: 0, deepseekClients: 0 };
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(url, modelId.startsWith("gpt-") ? "https://api.openai.com/v1/responses" : modelId === deepseek.modelId ? "https://api.deepseek.com/chat/completions" : "https://api.anthropic.com/v1/messages");
    assert.equal(body.model, modelId);
    const attempts = (await db.query("SELECT state FROM provider_attempts")).rows;
    assert.ok(attempts.some(row => row.state.phase === "submitted" && row.state.submission), "durable dispatch commits before transport");
    assert.ok((await getBalance(db, { ownerId })).reserved > 0, "wallet reservation precedes transport");
    f.requests.push(body);
    if (modelId.startsWith("gpt-")) return openai.response(openai.envelope({ model: mismatch ? "gpt-6-astra" : modelId,
      output: mismatch ? [openai.call()] : [openai.reasoning(), openai.text("Verified HTTP fixture answer.")] }));
    if (modelId === deepseek.modelId) {
      const payload = deepseek.envelope({ model: mismatch ? "deepseek-flash" : modelId });
      payload.choices[0].message.content = "Verified HTTP fixture answer.";
      return deepseek.response(payload);
    }
    const events = anthropic.textEvents("Verified HTTP fixture answer.");
    events[0].message.model = modelId;
    return anthropic.responseFrom(anthropic.sse(events));
  };
  f.providerOptions = { environment: f.environment, reviews: f.reviews, fetch: fetcher, now: () => at, timeoutMs: 5000 };
  globalThis.__providerHttp = f;
  t.after(() => { delete globalThis.__providerHttp; });
  return f;
}
const askRequest = (modelId, extra = {}) => new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "Inspect the synthetic HTTP fixture." }], modelSelection: { mode: "explicit", modelId }, ...extra }) });
const events = async response => (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const attempts = async f => (await f.db.query("SELECT * FROM provider_attempts")).rows;
const charges = async f => (await f.db.query("SELECT * FROM usage_charges")).rows;

test("actual Ask HTTP boundary completes native selection, quote, hold, provider response and wallet settlement", async t => {
  for (const modelId of modelIds) await t.test(modelId, async t => {
    const f = await fixture(t, { modelId });
    const response = await ask.POST(askRequest(modelId, { quote: { reservationCredits: 0 }, availableCredits: 999999, configured: true, model: "deepseek-flash" }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const stream = await events(response), [attempt] = await attempts(f), [charge] = await charges(f);
    assert.equal(f.deepseekClients, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(stream[0].type, "model_selection");
    assert.deepEqual(stream[0].modelSelection, { mode: "explicit", modelId });
    assert.equal(stream[0].decision.modelId, modelId);
    assert.equal(attempt.state.held.prepared.modelId, modelId);
    assert.equal(attempt.state.held.prepared.feature, "ask");
    assert.equal(attempt.state.held.prepared.conversationId, f.context.conversationId);
    assert.equal(attempt.state.held.prepared.quote.reservationCredits, stream[0].decision.quote.reservationCredits);
    assert.equal(attempt.status, "settled");
    assert.equal(Number(charge.cost_nano_usd), costUsage(attempt.state.decision.candidate.usage));
    assert.equal(Number(charge.price_nano_usd), Math.round(Number(charge.cost_nano_usd) * 2.5));
    assert.deepEqual(stream.filter(event => event.type === "model").map(event => event.modelId), [modelId]);
    assert.equal(stream.find(event => event.type === "text").delta, "Verified HTTP fixture answer.");
    assert.ok(stream.some(event => event.type === "done"));
    assert.equal(stream.at(-1).type, "usage");
    assert.equal(stream.at(-1).credits, Number(charge.price_nano_usd) / 10_000_000);
    assert.equal((await getBalance(f.db, { ownerId: f.ownerId })).reserved, 0);
    assert.doesNotMatch(JSON.stringify(stream) + JSON.stringify(attempt), /synthetic-only|synthetic_opaque_reasoning|synthetic_private_reasoning|API_KEY/);
  });
});

test("actual Ask model mismatch executes no tool and retains its dispatched hold without charging or retrying", async t => {
  const f = await fixture(t, { mismatch: true });
  const response = await ask.POST(askRequest(f.modelId));
  assert.equal(response.status, 200);
  const stream = await events(response), [attempt] = await attempts(f);
  assert.equal(f.requests.length, 1);
  assert.equal(f.deepseekClients, 0);
  assert.equal(attempt.status, "open");
  assert.equal(attempt.state.phase, "retained");
  assert.equal((await charges(f)).length, 0);
  assert.ok((await getBalance(f.db, { ownerId: f.ownerId })).reserved > 0);
  assert.equal((await getBalance(f.db, { ownerId: f.ownerId })).balance, 10_000);
  assert.equal(stream.at(-1).type, "error");
  assert.ok(!stream.some(event => ["tool_start", "tool_end", "model", "text", "done", "usage"].includes(event.type)));
  assert.doesNotMatch(JSON.stringify(stream), /synthetic-only|API_KEY|model_mismatch|diagnostic/);
});

test("browser enable claims cannot override a disabled server review at the actual Ask boundary", async t => {
  const f = await fixture(t, { enabled: false });
  const response = await ask.POST(askRequest(f.modelId, { executionEnabled: true, adapterSupported: true, configured: true,
    environment: { OPENAI_API_KEY: "browser-forgery" }, reviews: { [f.modelId]: { adapterSupported: true, executionEnabled: true } } }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /unavailable/);
  assert.equal(f.storage, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.deepseekClients, 0);
  assert.equal((await attempts(f)).length, 0);
  assert.equal((await charges(f)).length, 0);
});

test("actual Ask trusted wallet balance rejects native reservation despite forged browser credits", async t => {
  const f = await fixture(t, { credits: 1 });
  const response = await ask.POST(askRequest(f.modelId, { availableCredits: 999999, quote: { reservationCredits: 0 } }));
  assert.equal(response.status, 402);
  assert.equal((await response.json()).decision.reason, "minimum_hold");
  assert.equal(f.requests.length, 0);
  assert.equal(f.deepseekClients, 0);
  assert.equal((await attempts(f)).length, 0);
  assert.equal((await charges(f)).length, 0);
});

test("actual queued worker executes a persisted native pin and saves replayable events with one wallet charge", async t => {
  for (const modelId of ["gpt-6-luna", deepseek.modelId]) await t.test(modelId, async t => {
  const f = await fixture(t, { modelId });
  const accountId = randomUUID();
  await f.db.query("INSERT INTO accounts(id,owner_id,roblox_user_id,username,display_name) VALUES($1,$2,123,'fixture','Fixture')", [accountId, f.ownerId]);
  const selection = { mode: "explicit", modelId: f.modelId };
  const submitted = await submitChatQuestion(f.db, { ownerId: f.ownerId, chatId: null, question: "Queued native fixture", attachments: [] }, accountId,
    () => resolveAssistantModel(selection, assistantRequest([{ role: "user", content: "Queued native fixture" }], { systemPrompt: CHAT_PROMPT }), 10_000, f.environment, at, reviews));
  const queuedPayload = (await f.db.query("SELECT payload FROM chat_runs WHERE id=$1", [submitted.runId])).rows[0].payload;
  assert.deepEqual(queuedPayload.modelSelection, selection);
  assert.deepEqual(queuedPayload.modelDecision, submitted.modelRoute.modelDecision);
  assert.equal(f.requests.length, 0);
  const billing = assistantBilling(f.db, f.ownerId, "chat", { conversationId: submitted.saved.chatId, runId: submitted.runId, options: f.providerOptions });
  const analyticsTools = { definitions: [], checkAccess: async () => {}, execute: async () => { assert.fail("Unexpected queued analytics tool"); } };
  assert.equal(await executeChatRun(f.db, submitted.runId, { billing, analyticsTools }), true);
  assert.equal(f.requests.length, 1);
  const replay = await readChatRun(f.db, f.ownerId, submitted.runId), saved = await readChat(f.db, f.ownerId, submitted.saved.chatId);
  assert.equal(replay.status, "complete");
  const savedEvents = saved.messages.at(-1).events.map(event => event.e);
  assert.deepEqual(savedEvents.find(event => event.type === "model_selection").decision, queuedPayload.modelDecision);
  assert.deepEqual(savedEvents.filter(event => event.type === "model").map(event => event.modelId), [f.modelId]);
  assert.ok(savedEvents.some(event => event.type === "text" && event.delta === "Verified HTTP fixture answer."));
  const [attempt] = await attempts(f);
  assert.equal(attempt.status, "settled");
  assert.equal(attempt.state.held.prepared.feature, "chat");
  assert.equal(attempt.state.held.prepared.runId, submitted.runId);
  assert.equal(attempt.state.held.prepared.conversationId, submitted.saved.chatId);
  assert.equal((await charges(f)).length, 1);
  assert.equal((await getBalance(f.db, { ownerId: f.ownerId })).reserved, 0);
  assert.equal(await executeChatRun(f.db, submitted.runId, { billing, analyticsTools }), false);
  assert.equal(f.requests.length, 1);
  assert.equal((await charges(f)).length, 1);
  });
});
