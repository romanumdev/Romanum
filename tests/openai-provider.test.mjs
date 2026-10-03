import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAIAdapter, compileOpenAIRequest, translateOpenAIRequest, OPENAI_ENDPOINT, OPENAI_LIMITS,
  OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT } from "../src/lib/models/providers/openai.ts";
import { readModelReadiness } from "../src/lib/models/readiness.ts";
import { getModel } from "../src/lib/models/catalog.ts";
import { normalizeUsage } from "../src/lib/models/usage.ts";
import { at, models, request, tool, envelope, usage, text, reasoning, call, response } from "./fixtures/openai-provider.mjs";

function harness(value = envelope(), options = {}) {
  const calls = [];
  const adapter = createOpenAIAdapter({ executionEnabled: true, getApiKey: () => "synthetic-key", now: () => at,
    fetch: async (url, init) => { calls.push({ url, init }); return typeof value === "function" ? value(url, init) : response(value); }, ...options });
  return { adapter, calls };
}
function failed(result, code, submission = "uncertain") {
  assert.equal(result.status, "failed"); assert.equal(result.code, code); assert.equal(result.submission, submission);
  assert.equal(result.evidence, undefined); assert.equal(result.providerCostNanoUsd, undefined); assert.equal(result.toolCalls, undefined);
}
test("OpenAI factory/import/key presence cannot activate paid execution or readiness", async () => {
  let keyReads = 0, calls = 0;
  const adapter = createOpenAIAdapter({ getApiKey: () => { keyReads++; return "fixture"; }, fetch: async () => { calls++; throw Error(); } });
  failed(await adapter.complete(request()), "execution_disabled", "not_submitted");
  assert.equal(keyReads, 0); assert.equal(calls, 0);
  for (const model of readModelReadiness({ OPENAI_API_KEY: "fixture" }, {}).filter(model => models.includes(model.modelId))) {
    assert.equal(model.selectable, false); assert.equal(model.executionEnabled, false); assert.equal(model.entitlementVerified, false);
  }
  for (const key of [undefined, "", "bad\nheader"]) {
    const h = harness(null, { getApiKey: () => key });
    failed(await h.adapter.complete(request()), "missing_key", "not_submitted"); assert.equal(h.calls.length, 0);
  }
});
test("each exact GPT-6 model uses Responses with reasoning and standard cache pricing", async () => {
  const costs = [103500, 2010000, 10350000];
  for (const [index, modelId] of models.entries()) {
    const h = harness(envelope({ model: modelId })), req = request({ modelId });
    const compiled = compileOpenAIRequest(req), result = await h.adapter.complete(req);
    assert.equal(result.status, "completed"); assert.equal(result.modelId, modelId);
    assert.equal(result.providerCostNanoUsd, costs[index]); assert.equal(result.usage.outputTokens, 100);
    assert.equal(result.usage.inputMissTokens, 100); assert.equal(result.usage.cacheReadTokens, 600); assert.equal(result.usage.cacheWriteTokens, 300);
    assert.equal(result.evidence.reportedModelId, modelId); assert.equal(result.evidence.requestHash, compiled.requestHash);
    assert.equal(result.evidence.adapterVersion, OPENAI_ADAPTER_VERSION); assert.equal(result.evidence.requestFormatVersion, OPENAI_REQUEST_FORMAT);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, OPENAI_ENDPOINT); assert.equal(h.calls[0].init.body, compiled.json);
    assert.equal(h.calls[0].init.redirect, "error"); assert.equal(h.calls[0].init.credentials, "omit");
    const sent = JSON.parse(h.calls[0].init.body);
    assert.equal(sent.reasoning.effort, "medium"); assert.equal(sent.store, false); assert.equal(sent.stream, false);
    assert.equal(sent.service_tier, "default"); assert.equal(sent.background, false); assert.equal(sent.max_output_tokens, 100);
    assert.deepEqual(sent.prompt_cache_options, { mode: "implicit", ttl: "30m" });
    assert.equal(sent.tools[0].type, "function"); assert.equal(sent.tools[0].strict, false);
    assert.equal(getModel(modelId).rates.cacheWrite, getModel(modelId).rates.input * 1.25);
  }
});
test("request translation rejects substitutions, hosted tools, unreviewed fields and reasoning-none on Sol/Astra", async () => {
  const cases = [
    [request({ modelId: "gpt-6-sol" }), "unsupported_model"], [request({ modelId: "claude-opus-5-5" }), "unsupported_model"],
    [request({ endpoint: "https://invalid.example" }), "invalid_request"], [request({ stream: true }), "invalid_request"],
    [request({ maxInputTokens: 1050001 }), "invalid_request"], [request({ maxTokens: 16001 }), "invalid_request"],
    [request({ cacheTtl: "1h" }), "invalid_request"], [request({ tools: [{ type: "web_search" }] }), "invalid_request"],
    [request({ capabilities: { audio: true } }), "unsupported_capability"], [request({ tools: [tool, tool] }), "invalid_request"],
    ...models.slice(1).map(modelId => [request({ modelId, reasoningEffort: "none" }), "invalid_request"]),
    [request({ messages: [{ role: "tool", toolCallId: "orphan", content: "fixture" }] }), "invalid_request"],
    [request({ messages: [{ role: "user", content: "fixture" }, { role: "assistant", content: "prefill" }] }), "invalid_request"],
  ];
  for (const [req, code] of cases) {
    const h = harness(null); failed(await h.adapter.complete(req), code, "not_submitted"); assert.equal(h.calls.length, 0);
  }
  assert.equal(translateOpenAIRequest(request({ reasoningEffort: "none" })).reasoning.effort, "none");
});
test("exact request hash binds tools, history, caps, cache/reasoning policy and snapshots mutable source", async () => {
  const req = request(), original = compileOpenAIRequest(req);
  assert.ok(Object.isFrozen(original.body)); assert.ok(Object.isFrozen(original.body.input));
  for (const modified of [request({ system: "Changed" }), request({ maxTokens: 99 }), request({ reasoningEffort: "high" }),
    request({ messages: [{ role: "user", content: "Changed" }] }), request({ tools: [{ ...tool, description: "Changed" }] })]) {
    assert.notEqual(compileOpenAIRequest(modified).requestHash, original.requestHash);
    const h = harness(null);
    failed(await h.adapter.complete(modified, { binding: { expectedRequestHash: original.requestHash, submittedAt: at } }), "invalid_request", "not_submitted");
    assert.equal(h.calls.length, 0);
  }
  const dispatchAt = "2026-10-03T06:59:59.000Z";
  const h = harness(envelope(), { getApiKey: () => { req.system = "Mutation after compile"; return "fixture"; } });
  const result = await h.adapter.complete(req, { binding: { expectedRequestHash: original.requestHash, submittedAt: dispatchAt } });
  assert.equal(result.usage.at, dispatchAt); assert.equal(result.evidence.submittedAt, dispatchAt);
  assert.equal(h.calls[0].init.body, original.json);
});
test("reasoning function round preserves opaque items, phases and call IDs in original order", async () => {
  const h = harness(envelope({ output: [reasoning(), text("Checking."), call()] }));
  const result = await h.adapter.complete(request());
  assert.equal(result.stopReason, "tool_use"); assert.deepEqual(result.toolCalls[0], { id: "call_fixture_1", name: tool.name, input: { query: "synthetic example" } });
  const continued = request({ messages: [...request().messages,
    { role: "assistant", content: result.text, toolCalls: result.toolCalls, continuation: result.continuation },
    { role: "tool", toolCallId: result.toolCalls[0].id, content: "Synthetic result" }] });
  const body = translateOpenAIRequest(continued);
  assert.deepEqual(body.input.slice(1, 4), result.continuation.content);
  assert.equal(body.input[2].phase, "final_answer"); assert.equal(body.input[4].call_id, "call_fixture_1");
  for (const changed of [ { ...continued, modelId: models[1] }, { ...continued, system: "Changed prefix" },
    { ...continued, reasoningEffort: "high" }, { ...continued, tools: [{ ...tool, description: "Changed" }] },
    { ...continued, messages: [...continued.messages.slice(0, 1), { ...continued.messages[1], continuation: undefined }, continued.messages[2]] } ]) {
    assert.throws(() => translateOpenAIRequest(changed));
  }
});
test("native user images use data URLs and require full-history trusted input bounds", () => {
  const body = translateOpenAIRequest(request({ messages: [{ role: "user", content: [
    { type: "image", mediaType: "image/png", data: "AAAA" }, { type: "text", text: "Fixture" }] }] }));
  assert.equal(body.input[0].content[0].image_url, "data:image/png;base64,AAAA");
  assert.equal(body.input[0].content[0].detail, "auto");
  assert.throws(() => translateOpenAIRequest(request({ messages: [{ role: "user", content: [{ type: "image", url: "https://invalid.example" }] }] })));
});
test("nullable or absent message phase is valid; explicit phases survive private continuation", async () => {
  for (const phase of [null, "commentary", "final_answer"]) {
    const result = await harness(envelope({ output: [{ ...text(), phase }] })).adapter.complete(request());
    assert.equal(result.status, "completed"); assert.equal(result.continuation.content[0].phase, phase);
  }
  const item = text(); delete item.phase;
  assert.equal((await harness(envelope({ output: [item] })).adapter.complete(request())).status, "completed");
});
test("truncation keeps final usage/text but never exposes tool intents or native continuation", async () => {
  for (const reason of ["max_output_tokens", "content_filter"]) {
    const result = await harness(envelope({ status: "incomplete", incomplete_details: { reason }, output: [
      { ...reasoning(), encrypted_content: null }, text("Partial."), call({ arguments: '{"query":', status: "incomplete" })] })).adapter.complete(request());
    assert.equal(result.status, "completed"); assert.equal(result.truncated, true); assert.equal(result.stopReason, reason);
    assert.deepEqual(result.toolCalls, []); assert.equal(result.continuation, null); assert.equal(result.usageComplete, true);
  }
});
test("refusal has attributable final usage and cannot propose tools", async () => {
  const refusal = { ...text(), content: [{ type: "refusal", refusal: "Synthetic refusal." }] };
  const result = await harness(envelope({ output: [refusal] })).adapter.complete(request());
  assert.equal(result.stopReason, "refusal"); assert.equal(result.continuation, null); assert.deepEqual(result.toolCalls, []);
  failed(await harness(envelope({ output: [refusal, call()] })).adapter.complete(request()), "invalid_response");
});
test("model changes, paid modifiers and hosted tool outputs cannot become verified usage", async () => {
  for (const model of [models[1], "gpt-6-sol", "unknown", undefined]) {
    failed(await harness(envelope({ model })).adapter.complete(request()), "model_mismatch");
  }
  for (const extra of [{ service_tier: "priority" }, { service_tier: "flex" }, { inference_geo: "us" }, { store: true },
    { tools: [{ type: "web_search" }] }, { output: [{ type: "web_search_call", id: "ws_fixture", status: "completed" }] }]) {
    failed(await harness(envelope(extra)).adapter.complete(request()), "unsupported_capability");
  }
});
test("contradictory totals/cache categories and invalid reasoning counters cannot produce a price", async () => {
  for (const report of [usage({ total_tokens: 999 }), usage({ input_tokens: -1 }), usage({ input_tokens: 1.5 }),
    usage({ input_tokens_details: { cached_tokens: 800, cache_write_tokens: 300 } }), usage({ input_tokens_details: { cached_tokens: 600 } }),
    usage({ output_tokens_details: { reasoning_tokens: 101 } }), usage({ output_tokens_details: { reasoning_tokens: "70" } }),
    usage({ prompt_tokens_details: { cached_tokens: 100 } }), usage({ completion_tokens_details: { reasoning_tokens: 60 } }),
    usage({ output_tokens: 101, total_tokens: 1101 })]) {
    failed(await harness(envelope({ usage: report })).adapter.complete(request()), "invalid_response");
  }
  assert.throws(() => normalizeUsage(models[0], usage({ output_tokens_details: { reasoning_tokens: 101 } }), { at }));
});
test("failed semantic validation with complete usage stays uncertain and provides no final evidence", async () => {
  for (const args of ["[]", "null", '{"__proto__":{}}', '{"constructor":"bad"}', '{"query":']) {
    const result = await harness(envelope({ output: [call({ arguments: args })] })).adapter.complete(request());
    failed(result, "invalid_response"); assert.equal(result.usageComplete, true); assert.equal(result.usage.outputTokens, 100);
  }
  failed(await harness(envelope({ output: [call(), call({ id: "fc_fixture_2" })] })).adapter.complete(request()), "invalid_response");
  failed(await harness(envelope({ output: [call({ name: "undeclared" })] })).adapter.complete(request()), "invalid_response");
});
test("no submitted rejection or network exception causes an automatic retry/release or leaks raw errors", async () => {
  for (const status of [401, 402, 403, 429, 500, 503]) {
    const h = harness(() => new Response("PRIVATE_PROVIDER_ERROR", { status }));
    const result = await h.adapter.complete(request());
    assert.equal(result.submission, "uncertain"); assert.equal(h.calls.length, 1); assert.ok(!JSON.stringify(result).includes("PRIVATE_PROVIDER_ERROR"));
  }
  const h = harness(() => { throw Error("PRIVATE_NETWORK_ERROR synthetic-key"); });
  failed(await h.adapter.complete(request()), "network_error"); assert.equal(h.calls.length, 1);
});
test("cancellation and deadlines cover fetch and body read even when injected transport ignores abort", async () => {
  const before = new AbortController(); before.abort(); const untouched = harness(null);
  failed(await untouched.adapter.complete(request(), { signal: before.signal }), "cancelled", "not_submitted"); assert.equal(untouched.calls.length, 0);
  const hanging = harness(() => new Promise(() => {}), { timeoutMs: 10 });
  failed(await hanging.adapter.complete(request()), "timeout"); assert.equal(hanging.calls.length, 1);
  const during = new AbortController(), body = harness(() => new Response(new ReadableStream({}), { headers: { "Content-Type": "application/json" } }));
  const pending = body.adapter.complete(request(), { signal: during.signal }); setTimeout(() => during.abort(), 10);
  failed(await pending, "cancelled"); assert.equal(body.calls.length, 1); assert.equal(body.calls[0].init.signal.aborted, true);
});
test("bounded transport rejects incomplete JSON, invalid UTF-8 and excessive responses", async () => {
  failed(await harness(() => response('{"object":')).adapter.complete(request()), "invalid_response");
  failed(await harness(() => new Response(new Uint8Array([255]), { headers: { "Content-Type": "application/json" } })).adapter.complete(request()), "invalid_response");
  failed(await harness(() => new Response("x".repeat(OPENAI_LIMITS.responseBytes + 1), { headers: { "Content-Type": "application/json" } })).adapter.complete(request()), "response_limit");
});
test("strict snapshots reject getters without running them, cycles and lossy JSON", async () => {
  let reads = 0;
  const req = request(); Object.defineProperty(req, "system", { enumerable: true, get: () => { reads++; return "private"; } });
  const h = harness(null); failed(await h.adapter.complete(req), "invalid_request", "not_submitted"); assert.equal(reads, 0); assert.equal(h.calls.length, 0);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => translateOpenAIRequest(request({ tools: [{ ...tool, inputSchema: cyclic }] })));
});
