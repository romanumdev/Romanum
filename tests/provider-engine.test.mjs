import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { assistantRequest, runAssistant } from "../src/lib/assistant/engine.ts";
import { assistantBilling } from "../src/lib/assistant/billing.ts";
import { resolveAssistantModel } from "../src/lib/assistant/model-selection.ts";
import { PROVIDER_BOUND_POLICY, providerRequestBudget, quoteProviderBudget } from "../src/lib/models/providers/request-bounds.ts";
import { NATIVE_INPUT_CAPACITY } from "../src/lib/models/providers/native-capacity.ts";
import { createAccountingContract } from "../src/lib/models/execution-accounting/decision.ts";
import { finishProviderAttempt, settleProviderAttempt } from "../src/lib/credits/provider-attempts.ts";
import { grantCredits, getBalance } from "../src/lib/credits/ledger.ts";
import { getModel } from "../src/lib/models/catalog.ts";
import { costUsage } from "../src/lib/models/usage.ts";
import * as o from "./fixtures/openai-provider.mjs";
import * as a from "./fixtures/anthropic-provider.mjs";
import * as d from "./fixtures/deepseek-provider.mjs";

// These exercise real routing, engine, native HTTP parsers and wallet transactions.
// Transport is synthetic; no environment changes, provider calls or application database.
const at = "2026-10-03T07:00:00.000Z";
const all = [...o.models, d.modelId, "claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
const conversation = [{ role: "user", content: "Inspect the synthetic fixture." }];
const definition = { type: "function", function: { name: o.tool.name, description: o.tool.description, parameters: o.tool.inputSchema } };
async function fixture(t, modelId = "gpt-6-luna", options = {}) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: fn => engine.transaction(client => fn(sql(client))), close: () => engine.close() };
  for (const migration of ["002_credits", "010_usage", "014_usage_holds", "023_provider_attempts"]) await db.exec(await readFile(new URL(`../db/migrations/${migration}.sql`, import.meta.url), "utf8"));
  const ownerId = `fixture:${randomUUID()}`, context = { conversationId: randomUUID(), runId: randomUUID() };
  await grantCredits(db, { ownerId, amount: options.credits ?? 10_000, operationId: `fixture-grant:${ownerId}` });
  const environment = { OPENAI_API_KEY: "synthetic-only", ANTHROPIC_API_KEY: "synthetic-only", ...(modelId === d.modelId ? { DEEPSEEK_API_KEY: "synthetic-only" } : {}) };
  const reviews = Object.fromEntries(all.map(id => [id, { adapterSupported: true, executionEnabled: true }]));
  const events = [], requests = [], tools = [];
  const abort = new AbortController();
  const projectTools = { definitions: [definition], execute: async prepared => {
    const settled = await db.query("SELECT count(*)::int AS n FROM provider_attempts WHERE status='settled'");
    assert.ok(settled.rows[0].n >= 1, "tool execution follows verified settlement");
    tools.push(prepared); return { ok: true, summary: "Synthetic result", result: { value: 42 } };
  } };
  const modelRoute = resolveAssistantModel({ mode: "explicit", modelId }, assistantRequest(conversation, { projectTools }), 10_000, environment, at, reviews);
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    const attempts = (await db.query("SELECT state FROM provider_attempts")).rows;
    assert.ok(attempts.some(row => row.state.phase === "submitted" && row.state.submission), "dispatch claim committed before transport");
    assert.ok((await getBalance(db, { ownerId })).reserved > 0, "wallet hold precedes transport");
    requests.push({ url, body, init });
    if (options.fetch) return options.fetch({ url, init, body, f });
    const id = `${modelId.replaceAll(".", "_")}_${requests.length}`;
    if (getModel(modelId).provider === "openai") return o.response(o.envelope({ id: `resp_${id}`, model: modelId,
      output: options.toolLoop && requests.length === 1 ? [o.reasoning(), o.text("Checking fixtures."), o.call()] : [o.reasoning(), o.text("Verified answer.")] }));
    if (modelId === d.modelId) return d.response({ ...(options.toolLoop && requests.length === 1 ? d.toolEnvelope(o.tool.name) : d.envelope()), id: `chatcmpl_${id}` });
    const events = options.toolLoop && requests.length === 1 ? a.toolEvents() : a.textEvents("Verified answer.");
    events[0].message.model = modelId; events[0].message.id = `msg_${id}`;
    return a.responseFrom(a.sse(events));
  };
  const billing = assistantBilling(db, ownerId, "chat", { ...context, options: { environment, reviews, fetch: fetcher, now: () => at, timeoutMs: options.timeoutMs ?? 5000 } });
  const f = { db, ownerId, context, environment, reviews, events, requests, tools, abort, projectTools, modelRoute, billing, fetcher };
  f.run = extra => runAssistant({ conversation, send: event => events.push(event), signal: abort.signal, billing, projectTools, modelRoute, ...extra });
  return f;
}
const rows = async f => (await f.db.query("SELECT * FROM provider_attempts ORDER BY created_at,attempt_id")).rows;
const charges = async f => (await f.db.query("SELECT * FROM usage_charges")).rows;

test("each native model completes request→quote→hold→single attempt→actual usage→settlement using only its own provider credential", async t => {
  for (const modelId of all) await t.test(modelId, async t => {
    const f = await fixture(t, modelId); await f.run();
    assert.equal(f.requests.length, 1); assert.equal(f.events.find(e => e.type === "model").modelId, modelId);
    assert.equal(f.events.at(-1).type, "done"); assert.ok(!f.events.some(e => e.type === "thinking"));
    const [attempt] = await rows(f), [charge] = await charges(f);
    assert.equal(attempt.status, "settled"); assert.equal(attempt.state.held.prepared.modelId, modelId);
    assert.equal(attempt.state.held.prepared.bounds.budget.maxInputTokens, NATIVE_INPUT_CAPACITY[modelId]);
    assert.equal(Number(charge.cost_nano_usd), costUsage(attempt.state.decision.candidate.usage));
    assert.equal(Number(charge.price_nano_usd), Math.round(Number(charge.cost_nano_usd) * 2.5));
    assert.equal(f.billing.credits, Number(charge.price_nano_usd) / 10_000_000);
    assert.equal((await getBalance(f.db, { ownerId: f.ownerId })).reserved, 0);
    const serialized = JSON.stringify(f.events) + JSON.stringify(attempt);
    assert.ok(!serialized.includes("synthetic_opaque_reasoning")); assert.ok(!serialized.includes("synthetic_private_reasoning")); assert.ok(!serialized.includes("synthetic-only"));
    assert.ok(attempt.state.decision.candidate.usage.cacheReadTokens || attempt.state.decision.candidate.usage.cacheWriteTokens || attempt.state.decision.candidate.usage.cacheWrite5mTokens);
  });
});

test("real engine tool loops replay authentic native order, tools and reasoning privately after each verified settlement", async t => {
  for (const modelId of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", d.modelId, "claude-sonnet-5-5"]) await t.test(modelId, async t => {
    const f = await fixture(t, modelId, { toolLoop: true }); await f.run({ analysisTimeBudgetMs: 0 });
    assert.equal(f.requests.length, 2); assert.equal(f.tools.length, 1);
    assert.equal((await rows(f)).filter(row => row.status === "settled").length, 2);
    assert.equal(f.events.filter(event => event.type === "model").length, 1);
    assert.equal(f.events.at(-1).type, "done"); assert.equal(f.events.at(-1).messages.length, 3);
    const body = f.requests[1].body;
    if (modelId.startsWith("gpt")) {
      assert.equal(body.input.find(item => item.type === "reasoning").encrypted_content, "synthetic_opaque_reasoning");
      assert.equal(body.input.find(item => item.type === "function_call_output").call_id, "call_fixture_1");
      assert.equal(body.tools.length, f.requests[0].body.tools.length);
    } else if (modelId === d.modelId) {
      assert.equal(body.model, d.modelId); assert.equal(body.messages.at(-1).tool_call_id, "call_fixture_1");
      assert.equal(body.messages.find(message => message.role === "assistant").reasoning_content, "synthetic_private_reasoning");
    } else assert.equal(body.messages.at(-1).content[0].tool_use_id, "toolu_fixture_1");
    assert.ok(!JSON.stringify(f.events).includes("synthetic_opaque_reasoning"));
    assert.ok(!JSON.stringify(f.events).includes("synthetic_private_reasoning"));
  });
});

test("native billing ceilings include complete vendor windows, cache writes and OpenAI long-context premiums; admission remains200k", () => {
  const request = assistantRequest(conversation);
  for (const modelId of all) {
    const { budget } = providerRequestBudget(request, modelId), quote = quoteProviderBudget(modelId, budget, at);
    assert.equal(budget.maxInputTokens, NATIVE_INPUT_CAPACITY[modelId]);
    const model = getModel(modelId), multiplier = model.provider === "openai" ? 2 : 1;
    const outputMultiplier = model.provider === "openai" ? 1.5 : 1;
    const write = model.rates.cacheWrite ?? model.rates.cacheWrite5m ?? model.rates.input;
    const maximum = Math.ceil((budget.maxInputTokens * write * multiplier + budget.maxOutputTokens * model.rates.output * outputMultiplier) * 1000 * 2.5);
    assert.equal(quote.reservationPriceNanoUsd, maximum);
    assert.throws(() => quoteProviderBudget(modelId, { ...budget, maxInputTokens: 100 }, at));
    assert.throws(() => providerRequestBudget({ ...request, messages: [{ role: "user", content: "x".repeat(200_000) }] }, modelId));
  }
});

test("exhausted credits prevent durable reservation and transport, even for a previously resolved selection", async t => {
  const f = await fixture(t, "gpt-6-luna", { credits: 1 }); await f.run();
  assert.equal(f.requests.length, 0); assert.equal((await rows(f)).length, 0); assert.equal((await charges(f)).length, 0);
  assert.equal(f.events.at(-1).type, "error");
});

test("cancellation and credential removal after hold release an undispatched attempt without charging", async t => {
  for (const kind of ["cancel", "remove_key"]) await t.test(kind, async t => {
    const f = await fixture(t); let checks = 0;
    await f.run({ beforeAttempt: async () => { if (++checks === 2) { if (kind === "cancel") f.abort.abort(); else delete f.environment.OPENAI_API_KEY; } } });
    assert.equal(f.requests.length, 0); assert.equal((await rows(f))[0].status, "released");
    assert.equal((await getBalance(f.db, { ownerId: f.ownerId })).reserved, 0); assert.equal((await charges(f)).length, 0);
  });
});

test("response mismatch, timeout and cancellation after dispatch retain the hold with no tool, debit or automatic retry", async t => {
  for (const kind of ["mismatch", "timeout", "cancel"]) await t.test(kind, async t => {
    const f = await fixture(t, "gpt-6-luna", { timeoutMs: 15, fetch: ({ f }) => {
      if (kind === "mismatch") return o.response(o.envelope({ model: "gpt-6-astra", output: [o.call()] }));
      if (kind === "cancel") f.abort.abort();
      return new Promise(() => {});
    } });
    await f.run(); const [attempt] = await rows(f);
    assert.equal(f.requests.length, 1); assert.equal(f.tools.length, 0); assert.equal((await charges(f)).length, 0);
    assert.equal(attempt.status, "open"); assert.equal(attempt.state.phase, "retained");
    assert.ok((await getBalance(f.db, { ownerId: f.ownerId })).reserved > 0);
    await f.run(); assert.equal(f.requests.length, 1); assert.equal((await rows(f)).length, 1);
  });
});

test("duplicate workers and callbacks share one durable attempt and never charge twice", async t => {
  const f = await fixture(t);
  const second = assistantBilling(f.db, f.ownerId, "chat", { ...f.context, options: { environment: f.environment, reviews: f.reviews, fetch: f.fetcher, now: () => at } });
  await Promise.all([f.run(), f.run({ billing: second })]);
  assert.equal(f.requests.length, 1); const [attempt] = await rows(f);
  assert.equal((await charges(f)).length, 1);
  const before = await getBalance(f.db, { ownerId: f.ownerId });
  const contract = createAccountingContract(PROVIDER_BOUND_POLICY);
  const callbacks = await Promise.all(Array.from({ length: 4 }, () => finishProviderAttempt(f.db, attempt.attempt_id, f.ownerId, attempt.state.evidence.at(-1), contract)));
  assert.ok(callbacks.every(result => result.settled && result.chargedCredits === 0 && result.priceNanoUsd === 0));
  assert.deepEqual(await getBalance(f.db, { ownerId: f.ownerId }), before); assert.equal((await charges(f)).length, 1);
});

test("commit acknowledgement loss retains a durable dispatch even when transport never ran", async t => {
  const f = await fixture(t);
  const transaction = f.db.transaction; let lose = true;
  f.db.transaction = async operation => {
    const result = await transaction(operation);
    if (lose && result?.dispatch === true) { lose = false; throw new Error("synthetic commit acknowledgement lost"); }
    return result;
  };
  await f.run(); assert.equal(f.requests.length, 0); assert.equal((await rows(f))[0].state.phase, "submitted");
  assert.ok((await getBalance(f.db, { ownerId: f.ownerId })).reserved > 0); assert.equal((await charges(f)).length, 0);
  await f.run(); assert.equal(f.requests.length, 0); assert.equal((await rows(f)).length, 1);
});

test("truncated native answers settle attributable usage, report incomplete output and never execute tool intents", async t => {
  const f = await fixture(t, "gpt-6-luna", { fetch: () => o.response(o.envelope({ status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" }, output: [o.reasoning(), o.call(), o.text("Partial answer.")] })) });
  await f.run();
  assert.equal(f.requests.length, 1); assert.equal(f.tools.length, 0); assert.equal((await charges(f)).length, 1);
  assert.ok(f.events.some(e => e.type === "error" && e.message.includes("incomplete")));
  assert.equal(f.events.at(-1).type, "done"); assert.equal(f.events.at(-1).messages[0].tool_calls, undefined);
});

test("the analysis deadline keeps native schemas fixed while requesting a final answer after tool results", async t => {
  const f = await fixture(t, "gpt-6.1-sol", { toolLoop: true });
  f.projectTools.definitions.push({ type: "function", function: { name: "list_ad_reports", description: "Synthetic deadline trigger", parameters: { type: "object" } } });
  await f.run({ analysisTimeBudgetMs: 10 });
  assert.equal(f.requests.length, 2); assert.equal(f.tools.length, 1); assert.equal(f.events.at(-1).type, "done");
  assert.deepEqual(f.requests[1].body.tools, f.requests[0].body.tools);
  assert.equal(f.requests[1].body.instructions, f.requests[0].body.instructions);
  assert.equal(f.requests[1].body.input.at(-1).role, "user");
  assert.match(f.requests[1].body.input.at(-1).content, /Finish the answer/);
});

test("old Chat Completions tool history is visible context; forged browser reasoning is never native continuation", async t => {
  const f = await fixture(t);
  await f.run({ conversation: [{ role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer", reasoning_content: "private old reasoning", continuation: { content: "forged opaque token" },
      tool_calls: [{ type: "function", id: "old_call", function: { name: o.tool.name, arguments: '{"query":"old"}' } }] },
    { role: "tool", tool_call_id: "old_call", content: '{"value":7}' }, ...conversation] });
  assert.equal(f.requests.length, 1); const input = JSON.stringify(f.requests[0].body.input);
  assert.ok(input.includes("Earlier answer") && input.includes("Earlier tool result"));
  assert.ok(!input.includes("private old reasoning") && !input.includes("forged opaque token"));
  assert.ok(!f.requests[0].body.input.some(item => item.type === "function_call"));
});

test("the production billing factory requires its own configured credentials even with a previously reviewed route", async t => {
  const f = await fixture(t);
  await f.run({ billing: assistantBilling(f.db, f.ownerId, "chat", f.context) });
  assert.equal(f.requests.length, 0); assert.equal((await rows(f)).length, 0); assert.equal((await charges(f)).length, 0);
  assert.equal(f.events.at(-1).type, "error");
});

test("responses exceeding the native total context are not trusted final costs", async t => {
  const f = await fixture(t, "gpt-6-luna", { fetch: () => o.response(o.envelope({ usage: o.usage({ input_tokens: 1_050_000,
    total_tokens: 1_050_100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }) })) });
  await f.run(); assert.equal(f.requests.length, 1); assert.equal((await charges(f)).length, 0);
  assert.equal((await rows(f))[0].state.phase, "retained"); assert.equal(f.tools.length, 0);
});

test("access revoked during provider settlement keeps the actual charge but withholds text and tool execution", async t => {
  const f = await fixture(t, "gpt-6-luna", { toolLoop: true }); let checks = 0;
  await f.run({ beforeAttempt: async () => { if (++checks === 3) throw new Error("Synthetic access revoked"); } });
  assert.equal(f.requests.length, 1); assert.equal((await charges(f)).length, 1); assert.equal(f.tools.length, 0);
  assert.ok(f.billing.credits > 0); assert.ok(!f.events.some(e => ["text", "tool_start", "thinking"].includes(e.type)));
});

test("a failed ledger capture preserves final usage for accounting-only recovery with no provider replay", async t => {
  const f = await fixture(t, "gpt-6-luna", { toolLoop: true });
  const transaction = f.db.transaction; let fail = true;
  f.db.transaction = operation => transaction(sql => operation({ ...sql, query: async (text, values) => {
    if (fail && text.startsWith("INSERT INTO usage_charges")) { fail = false; throw new Error("Synthetic capture failure"); }
    return sql.query(text, values);
  } }));
  await f.run(); const [attempt] = await rows(f);
  assert.equal(f.requests.length, 1); assert.equal(f.tools.length, 0); assert.equal((await charges(f)).length, 0);
  assert.equal(attempt.status, "candidate"); assert.equal(attempt.state.phase, "candidate");
  assert.equal(attempt.state.evidence.at(-1).usage.kind, "final"); assert.ok(attempt.state.decision.candidate.providerMessageId);
  assert.equal(f.billing.credits, 0); assert.ok(!f.events.some(e => e.type === "text"));
  const contract = createAccountingContract(PROVIDER_BOUND_POLICY);
  const recovered = await settleProviderAttempt(f.db, attempt.attempt_id, f.ownerId, contract);
  assert.ok(recovered.settled && recovered.priceNanoUsd > 0); assert.equal((await charges(f)).length, 1);
  assert.equal((await getBalance(f.db, { ownerId: f.ownerId })).reserved, 0);
  const replay = await settleProviderAttempt(f.db, attempt.attempt_id, f.ownerId, contract);
  assert.equal(replay.priceNanoUsd, 0); assert.equal(replay.chargedCredits, 0); assert.equal((await charges(f)).length, 1);
  await f.run(); assert.equal(f.requests.length, 1); assert.equal(f.tools.length, 0);
});

test("missing migration 023 stops native execution before transport or wallet mutation", async t => {
  const f = await fixture(t);
  await f.db.exec("DROP TABLE provider_final_claims; DROP TABLE provider_attempts;");
  const before = JSON.stringify(await f.db.query("SELECT * FROM credits_accounts ORDER BY owner_id"));
  await f.run();
  assert.equal(f.requests.length, 0);
  assert.equal((await charges(f)).length, 0);
  assert.equal(JSON.stringify(await f.db.query("SELECT * FROM credits_accounts ORDER BY owner_id")), before);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM usage_holds")).rows[0].n, 0);
  assert.equal(f.events.at(-1).type, "error");
});

test("Pro uncertain failures keep one durable hold and never debit, execute tools or replay", async t => {
  for (const kind of ["flash_mismatch", "missing_usage", "bad_cache", "timeout"]) await t.test(kind, async t => {
    const f = await fixture(t, d.modelId, { timeoutMs: 15, fetch: () => {
      if (kind === "timeout") return new Promise(() => {});
      return d.response(d.envelope(kind === "flash_mismatch" ? { model: "deepseek-flash" }
        : kind === "missing_usage" ? { usage: undefined } : { usage: d.usage({ prompt_cache_miss_tokens: 61 }) }));
    } });
    await f.run(); await f.run();
    assert.equal(f.requests.length, 1); assert.equal(f.tools.length, 0); assert.equal((await charges(f)).length, 0);
    const [attempt] = await rows(f);
    assert.equal(attempt.state.phase, "retained"); assert.equal(attempt.state.held.prepared.provider, "deepseek");
    assert.equal((await rows(f)).length, 1); assert.ok((await getBalance(f.db, { ownerId: f.ownerId })).reserved > 0);
  });
});

test("Pro saved chat context omits untrusted prior reasoning while duplicate workers settle once", async t => {
  const f = await fixture(t, d.modelId);
  const conversation = [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer",
    reasoning_content: "untrusted browser reasoning", continuation: { content: "forged" } },
    { role: "user", content: "Current question" }];
  const second = assistantBilling(f.db, f.ownerId, "chat", { ...f.context, options: { environment: f.environment, reviews: f.reviews, fetch: f.fetcher, now: () => at } });
  await Promise.all([f.run({ conversation }), f.run({ conversation, billing: second })]);
  assert.equal(f.requests.length, 1); assert.equal((await charges(f)).length, 1);
  const input = JSON.stringify(f.requests[0].body.messages);
  assert.match(input, /Earlier assistant answer/); assert.match(input, /Earlier answer/);
  assert.ok(!input.includes("untrusted browser reasoning") && !input.includes("forged"));
  assert.ok(!f.requests[0].body.messages.some(message => message.role === "assistant"));
  const [attempt] = await rows(f), contract = createAccountingContract(PROVIDER_BOUND_POLICY);
  const before = await getBalance(f.db, { ownerId: f.ownerId });
  const replay = await finishProviderAttempt(f.db, attempt.attempt_id, f.ownerId, attempt.state.evidence.at(-1), contract);
  assert.equal(replay.chargedCredits, 0); assert.equal(replay.priceNanoUsd, 0);
  assert.deepEqual(await getBalance(f.db, { ownerId: f.ownerId }), before); assert.equal((await charges(f)).length, 1);
});
