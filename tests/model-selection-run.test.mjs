import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { assistantRequest, runAssistant } from "../src/lib/assistant/engine.ts";
import { quoteAssistantCall } from "../src/lib/assistant/billing.ts";
import { ModelSelectionError, formModelSelection, legacyAssistantModel, persistedAssistantModel, requestModelSelection, resolveAssistantModel, revalidateAssistantModel } from "../src/lib/assistant/model-selection.ts";
import { cancelChatRun, claimChatRun, readChatRun, submitChatQuestion } from "../src/lib/chats/runs.ts";
import { executeChatRun } from "../src/lib/chats/run-worker.ts";
import { readChat } from "../src/lib/chats/store.ts";

// This client harness exercises the released Flash adapter. Native provider
// transport has separate fixtures; unrelated keys must not change Auto here.
const env = { DEEPSEEK_API_KEY: "fixture-only" };
const providerKeys = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
const conversation = [{ role: "user", content: "Fixture question" }];
const at = "2026-10-02T12:00:00.000Z";
const route = selection => resolveAssistantModel(selection, assistantRequest(conversation), 100, env, at);
function environment(t) {
  const old = Object.fromEntries(providerKeys.map(key => [key, process.env[key]]));
  for (const key of providerKeys) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function harness(extra = {}) {
  const requests = [], holds = [], events = [];
  const client = { chat: { completions: { create: async request => {
    requests.push(request);
    return (async function* () {
      yield { choices: [{ delta: { content: "Fixture answer" } }] };
      yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    })();
  } } } };
  const billing = { credits: 0, reserve: async value => { holds.push(["reserve", value]); return "fixture-hold"; },
    settle: async () => { holds.push(["settle"]); }, finish: async (_, uncertain) => { holds.push(["finish", uncertain]); }, tool: async (_, execute) => execute(), ...extra };
  return { client, billing, requests, holds, events, send: event => events.push(event), signal: new AbortController().signal };
}
async function fixture(t) {
  environment(t);
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: text => client.exec(text) });
  const db = { ...sql(engine), transaction: fn => engine.transaction(client => fn(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  const accountId = randomUUID(), ownerId = `account:${accountId}`;
  await db.query("INSERT INTO accounts(id,owner_id,roblox_user_id,username,display_name) VALUES($1,$2,123,'fixture','Fixture')", [accountId, ownerId]);
  return { db, accountId, ownerId };
}
async function submit(f, selection) {
  return submitChatQuestion(f.db, { ownerId: f.ownerId, chatId: null, question: "Fixture question", attachments: [] }, f.accountId,
    () => route(selection));
}

test("strict JSON and multipart selection parsing preserves legacy omission but rejects forged/duplicate choices", () => {
  assert.deepEqual(requestModelSelection(undefined, false), { mode: "explicit", modelId: "deepseek-flash" });
  for (const value of [null, {}, { mode: "auto", configured: true }, { mode: "explicit", modelId: "invented" },
    { mode: "explicit", modelId: "deepseek-flash", quote: { reservationCredits: 0 } }, { mode: "auto", modelId: "deepseek-flash" }]) {
    assert.throws(() => requestModelSelection(value, true), ModelSelectionError);
  }
  const form = new FormData();
  assert.deepEqual(formModelSelection(form), { mode: "explicit", modelId: "deepseek-flash" });
  form.append("modelSelection", JSON.stringify({ mode: "auto" }));
  assert.deepEqual(formModelSelection(form), { mode: "auto" });
  form.append("modelSelection", JSON.stringify({ mode: "explicit", modelId: "deepseek-flash" }));
  assert.throws(() => formModelSelection(form), ModelSelectionError);
});

test("server routing accounts for actual framing, tools and images with the unchanged released hold ceiling", () => {
  const messages = [...conversation, { role: "user", content: [{ type: "text", text: "Inspect fixture" }, { type: "image_url", image_url: { url: "data:image/webp;base64,AA==" } }] }];
  for (const prompt of ["short", "é".repeat(4096), "System fixture"] ) {
    const request = assistantRequest(messages, { systemPrompt: prompt });
    const result = resolveAssistantModel({ mode: "auto" }, request, 100, env, at);
    assert.equal(result.modelDecision.modelId, "deepseek-flash");
    assert.equal(result.modelDecision.quote.reservationPriceNanoUsd, quoteAssistantCall(request));
    assert.equal(result.modelDecision.quote.estimateBasis, "uncached");
    assert.equal(result.modelDecision.quote.cacheHitGuaranteed, false);
  }
  for (const modelId of ["gpt-6.1-sol", "claude-opus-5-5"]) {
    assert.throws(() => resolveAssistantModel({ mode: "explicit", modelId }, assistantRequest(messages), 100, env, at), /unavailable/);
  }
  assert.throws(() => resolveAssistantModel({ mode: "explicit", modelId: "deepseek-v4-pro" }, assistantRequest(messages), 100, env, at), /cannot support/, "Pro cannot receive images");
  assert.throws(() => route({ mode: "explicit", modelId: "deepseek-v4-pro" }), /Not enough credits/, "text-only Pro requires its full reservation");
  assert.throws(() => resolveAssistantModel({ mode: "auto" }, assistantRequest(conversation), 1, env, at), /minimum reservation/);
  assert.throws(() => resolveAssistantModel({ mode: "auto" }, assistantRequest([{ role: "user", content: "x".repeat(200_000) }]), 100, env, at), /limits/);
});

test("Auto stays pinned; changed readiness, partial persisted fields, forged IDs and capabilities fail closed", () => {
  const selected = route({ mode: "auto" });
  assert.deepEqual(persistedAssistantModel(selected), selected);
  revalidateAssistantModel(selected, assistantRequest(conversation), env);
  assert.throws(() => revalidateAssistantModel(selected, assistantRequest(conversation), { OPENAI_API_KEY: "fixture-only" }), /unavailable/);
  for (const payload of [
    { modelSelection: { mode: "auto" } }, { ...selected, modelResolvedAt: "bad" },
    { ...selected, modelSelection: { mode: "explicit", modelId: "gpt-6.1-sol" } },
    { ...selected, modelDecision: { ...selected.modelDecision, modelId: "deepseek-v4-pro" } },
    { ...selected, modelDecision: { ...selected.modelDecision, quote: { ...selected.modelDecision.quote, rateCardVersion: "forged" } } },
  ]) assert.throws(() => persistedAssistantModel(payload), ModelSelectionError);
  assert.throws(() => revalidateAssistantModel(selected, { ...assistantRequest(conversation), model: "deepseek-v4-pro" }, env), /unavailable/);
  assert.throws(() => revalidateAssistantModel(selected, assistantRequest([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://invalid.test/forged" } }] }]), env), /validated/);
  assert.deepEqual(persistedAssistantModel({}).modelSelection, { mode: "explicit", modelId: "deepseek-flash" });
  assert.equal(persistedAssistantModel({}).legacy, true);
});

test("foreground Auto/explicit attempts preserve choice, report actual model once and keep released settlement", async t => {
  environment(t);
  for (const selection of [{ mode: "auto" }, { mode: "explicit", modelId: "deepseek-flash" }]) {
    const h = harness(), modelRoute = route(selection);
    await runAssistant({ ...h, conversation, modelRoute });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].model, "deepseek-flash");
    assert.deepEqual(h.events.map(event => event.type), ["model_selection", "model", "text", "done"]);
    assert.deepEqual(h.events[0].modelSelection, selection);
    assert.equal(h.events[0].decision.modelId, "deepseek-flash");
    assert.equal(h.holds[0][1], modelRoute.modelDecision.quote.reservationPriceNanoUsd);
    assert.deepEqual(h.holds.at(-1), ["settle"]);
  }
});

test("key removal after reservation prevents submission and releases the unsubmitted hold", async t => {
  environment(t);
  const h = harness({ reserve: async () => { delete process.env.DEEPSEEK_API_KEY; return "fixture-hold"; } });
  await runAssistant({ ...h, conversation, modelRoute: route({ mode: "auto" }) });
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.holds, [["finish", false]]);
  assert.deepEqual(h.events.map(event => event.type), ["model_selection", "error"]);
  assert.match(h.events.at(-1).message, /unavailable/);
  assert.doesNotMatch(JSON.stringify(h.events), /fixture-only|API_KEY/);
});

test("the pinned adapter survives a tool loop and receives fresh authorised results while old private history is withheld", async t => {
  environment(t);
  const h = harness(), selection = { mode: "auto" };
  const analyticsTools = { definitions: [{ type: "function", function: { name: "get_private_game_overview", description: "Fixture tool", parameters: { type: "object" } } }],
    checkAccess: async () => {}, execute: async () => ({ ok: true, summary: "Fixture observation", result: { scope: "private_owner", observation: "fresh-fixture-observation" } }) };
  h.client.chat.completions.create = async request => {
    h.requests.push(request);
    return (async function* () {
      if (h.requests.length === 1) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "current", function: { name: "get_private_game_overview", arguments: "{}" } }] } }] };
      else yield { choices: [{ delta: { content: "Fixture conclusion" } }] };
      yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    })();
  };
  const history = [{ role: "user", content: "Earlier fixture" }, { role: "assistant", content: "", tool_calls: [{ id: "previous", type: "function", function: { name: "get_private_game_overview", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "previous", content: JSON.stringify({ scope: "private_owner", observation: "old-fixture-observation" }) }, ...conversation];
  const modelRoute = resolveAssistantModel(selection, assistantRequest(history, { analyticsTools }), 100, env, at);
  await runAssistant({ ...h, conversation: history, analyticsTools, modelRoute });
  assert.equal(h.requests.length, 2); assert.ok(h.requests.every(request => request.model === "deepseek-flash"));
  assert.doesNotMatch(JSON.stringify(h.requests), /old-fixture-observation/);
  assert.match(JSON.stringify(h.requests[1]), /fresh-fixture-observation/);
  assert.equal(h.events.filter(event => event.type === "model_selection").length, 1);
  assert.equal(h.events.filter(event => event.type === "model").length, 1);
  assert.equal(h.holds.filter(([kind]) => kind === "settle").length, 2);
});

test("queued payload pins selection and decision, durable/replayed events preserve it after finalization", async t => {
  const f = await fixture(t);
  for (const selection of [{ mode: "auto" }, { mode: "explicit", modelId: "deepseek-flash" }]) {
    const submitted = await submit(f, selection);
    const { payload } = (await f.db.query("SELECT payload FROM chat_runs WHERE id=$1", [submitted.runId])).rows[0];
    assert.deepEqual(payload.modelSelection, selection);
    assert.deepEqual(payload.modelDecision, submitted.modelRoute.modelDecision);
    const queued = await readChatRun(f.db, f.ownerId, submitted.runId);
    assert.equal(queued.status, "queued");
    assert.equal(queued.events.length, 1);
    assert.deepEqual(queued.events[0].e.modelSelection, selection);
    assert.ok(!queued.events.some(({ e }) => e.type === "model"));
    const h = harness();
    await executeChatRun(f.db, submitted.runId, { client: h.client, billing: h.billing });
    const page = await readChatRun(f.db, f.ownerId, submitted.runId);
    assert.equal(page.status, "complete");
    const saved = await readChat(f.db, f.ownerId, submitted.saved.chatId);
    const selectionEvent = saved.messages.at(-1).events.find(({ e }) => e.type === "model_selection").e;
    assert.deepEqual(selectionEvent.modelSelection, selection);
    assert.deepEqual(selectionEvent.decision, payload.modelDecision);
    assert.equal(saved.messages.at(-1).events.filter(({ e }) => e.type === "model").length, 1);
    assert.equal((await f.db.query("SELECT payload FROM chat_runs WHERE id=$1", [submitted.runId])).rows[0].payload, null);
  }
});

test("queued removal/forgery never calls a provider; cancellation preserves decision without claiming execution", async t => {
  const f = await fixture(t);
  const cancelled = await submit(f, { mode: "auto" });
  await cancelChatRun(f.db, f.ownerId, cancelled.runId);
  const cancelledChat = await readChat(f.db, f.ownerId, cancelled.saved.chatId);
  assert.ok(cancelledChat.messages.at(-1).events.some(({ e }) => e.type === "model_selection"));
  assert.ok(!cancelledChat.messages.at(-1).events.some(({ e }) => e.type === "model"));
  for (const change of ["removed", "forged"]) {
    process.env.DEEPSEEK_API_KEY = "fixture-only";
    const next = await submit(f, { mode: "auto" });
    if (change === "removed") delete process.env.DEEPSEEK_API_KEY;
    else await f.db.query("UPDATE chat_runs SET payload=jsonb_set(payload,'{modelDecision,modelId}','\"gpt-6-astra\"'::jsonb) WHERE id=$1", [next.runId]);
    const h = harness();
    await executeChatRun(f.db, next.runId, { client: h.client, billing: h.billing });
    assert.equal(h.requests.length, 0); assert.equal(h.holds.length, 0);
    assert.equal((await readChatRun(f.db, f.ownerId, next.runId)).status, "failed");
  }
});

test("blocked selection rolls back its question transaction; legacy runs retain exact DeepSeek adapter", async t => {
  const f = await fixture(t);
  await assert.rejects(submit(f, { mode: "explicit", modelId: "gpt-6-astra" }), /unavailable/);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM chat_messages")).rows[0].n, 0);
  const old = await submitChatQuestion(f.db, { ownerId: f.ownerId, chatId: null, question: "Legacy fixture", attachments: [] }, f.accountId);
  const payload = (await f.db.query("SELECT payload FROM chat_runs WHERE id=$1", [old.runId])).rows[0].payload;
  assert.equal(payload.modelSelection, undefined);
  const h = harness();
  await executeChatRun(f.db, old.runId, { client: h.client, billing: h.billing });
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].model, "deepseek-flash");
  const progress = await readChatRun(f.db, f.ownerId, old.runId);
  assert.equal(progress.events.find(({ e }) => e.type === "model_selection").e.legacy, true);
  assert.deepEqual(legacyAssistantModel().modelSelection, { mode: "explicit", modelId: "deepseek-flash" });
  assert.equal(await claimChatRun(f.db, old.runId), null);
});

test("a missing queued attachment retains the requested choice without claiming a model attempt", async t => {
  const f = await fixture(t), selection = { mode: "explicit", modelId: "deepseek-flash" };
  const submitted = await submit(f, selection);
  await f.db.query("UPDATE chat_runs SET payload=jsonb_set(payload,'{attachmentIds}',$2::jsonb) WHERE id=$1", [submitted.runId, JSON.stringify([randomUUID()])]);
  const h = harness();
  await executeChatRun(f.db, submitted.runId, { client: h.client, billing: h.billing });
  assert.equal(h.requests.length, 0); assert.equal(h.holds.length, 0);
  const saved = await readChat(f.db, f.ownerId, submitted.saved.chatId);
  assert.deepEqual(saved.messages.at(-1).events.find(({ e }) => e.type === "model_selection").e.modelSelection, selection);
  assert.ok(!saved.messages.at(-1).events.some(({ e }) => e.type === "model"));
});
