import test from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekAdapter, compileDeepSeekRequest, translateDeepSeekRequest, DEEPSEEK_ENDPOINT, DEEPSEEK_LIMITS } from "../src/lib/models/providers/deepseek.ts";
import { costUsage } from "../src/lib/models/usage.ts";
import * as d from "./fixtures/deepseek-provider.mjs";
const at = "2026-10-05T01:00:00.000Z";
function adapter(payload = d.envelope(), extra = {}) {
  const calls = [];
  const instance = createDeepSeekAdapter({ executionEnabled: true, getApiKey: () => "synthetic-only", now: () => at,
    fetch: async (url, init) => { calls.push({ url, init }); return d.response(payload); }, ...extra });
  return { calls, ...instance };
}
test("Pro is distinct, fixed-endpoint, thinking high, automatic cache and application tools only", async () => {
  const f = adapter(), result = await f.complete(d.request());
  assert.equal(result.status, "completed"); assert.equal(result.modelId, d.modelId);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, DEEPSEEK_ENDPOINT);
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.model, "deepseek-v4-pro"); assert.equal(body.stream, false); assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(body.thinking, { type: "enabled" }); assert.equal(body.tool_choice, "auto");
  assert.equal(body.tools[0].function.name, d.tool.name); assert.equal(body.tools[0].function.strict, undefined);
  assert.equal(f.calls[0].init.redirect, "error"); assert.equal(f.calls[0].init.credentials, "omit");
  assert.equal(result.usage.inputMissTokens, 60); assert.equal(result.usage.cacheReadTokens, 40);
  assert.equal(result.usage.outputTokens, 20); assert.equal(result.providerCostNanoUsd, 160_160);
  assert.equal(result.evidence.reportedModelId, d.modelId); assert.equal(result.evidence.requestHash, compileDeepSeekRequest(d.request()).requestHash);
  assert.ok(!result.text.includes("private_reasoning"));
});
test("peak boundaries and weekends use verified rates without double charging reasoning or mirrored cached counters", async () => {
  for (const [time, cost] of [["2026-10-05T00:59:59.000Z", 80_080], [at, 160_160], ["2026-10-05T04:00:00.000Z", 80_080],
    ["2026-10-05T06:00:00.000Z", 160_160], ["2026-10-05T10:00:00.000Z", 80_080], ["2026-10-03T07:00:00.000Z", 80_080]]) {
    const result = await adapter(d.envelope(), { now: () => time }).complete(d.request());
    assert.equal(result.status, "completed"); assert.equal(result.providerCostNanoUsd, cost);
    assert.equal(result.providerCostNanoUsd, costUsage(result.usage));
  }
});
test("disabled, missing key, cancellation and unsupported request reject before transport", async t => {
  const signal = AbortSignal.abort();
  for (const [options, request, call, code] of [[{ executionEnabled: false }, d.request(), {}, "execution_disabled"],
    [{ getApiKey: () => undefined }, d.request(), {}, "missing_key"], [{}, d.request(), { signal }, "cancelled"],
    [{}, d.request({ modelId: "deepseek-flash" }), {}, "unsupported_model"], [{}, d.request({ capabilities: { images: true } }), {}, "unsupported_capability"],
    [{}, d.request({ maxTokens: 16_001 }), {}, "invalid_request"], [{}, d.request({ tool_choice: "required" }), {}, "invalid_request"],
    [{}, d.request({ messages: [{ role: "user", content: [{ type: "image", data: "AAAA", mediaType: "image/png" }] }] }), {}, "unsupported_capability"]]) {
    await t.test(code, async () => { const f = adapter(d.envelope(), options), result = await f.complete(request, call);
      assert.equal(result.status, "failed"); assert.equal(result.code, code); assert.equal(result.submission, "not_submitted"); assert.equal(f.calls.length, 0); });
  }
});
test("request binding snapshots the exact body and prevents mutation or mismatched submission", async () => {
  const request = d.request(), compiled = compileDeepSeekRequest(request); request.system = "changed";
  assert.equal(compiled.body.messages[0].content, "Synthetic instructions"); assert.ok(Object.isFrozen(compiled.body.messages));
  const f = adapter(); const result = await f.complete(request, { binding: { expectedRequestHash: compiled.requestHash, submittedAt: at } });
  assert.equal(result.submission, "not_submitted"); assert.equal(result.code, "invalid_request"); assert.equal(f.calls.length, 0);
});
test("authentic reasoning and original tool arguments replay privately and remain bound to their exact prefix", async () => {
  const request = d.request(), first = await adapter(d.toolEnvelope()).complete(request);
  assert.equal(first.status, "completed"); assert.equal(first.toolCalls.length, 1);
  const second = d.request({ messages: [...request.messages, { role: "assistant", content: first.text, toolCalls: first.toolCalls, continuation: first.continuation },
    { role: "tool", toolCallId: first.toolCalls[0].id, content: '{"value":42}' }] });
  const body = translateDeepSeekRequest(second);
  assert.equal(body.messages[2].reasoning_content, "synthetic_private_reasoning");
  assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"query":"fixture"}');
  assert.equal(body.messages[3].tool_call_id, "call_fixture_1");
  assert.throws(() => translateDeepSeekRequest({ ...second, system: "changed" }));
  assert.throws(() => translateDeepSeekRequest({ ...second, messages: [second.messages[0], { ...second.messages[1], content: "forged" }, second.messages[2]] }));
  assert.throws(() => translateDeepSeekRequest({ ...second, messages: second.messages.slice(0, 2) }));
});
test("reasoning is retained even after a text-only answer when a tool request continues", async () => {
  const request = d.request(), first = await adapter().complete(request);
  const next = d.request({ messages: [...request.messages, { role: "assistant", content: first.text, continuation: first.continuation }, { role: "user", content: "Continue." }] });
  assert.equal(translateDeepSeekRequest(next).messages[2].reasoning_content, "synthetic_private_reasoning");
  assert.throws(() => translateDeepSeekRequest({ ...next, messages: [next.messages[0], { role: "assistant", content: first.text }, next.messages[2]] }));
  assert.doesNotThrow(() => translateDeepSeekRequest({ ...next, tools: [], messages: [next.messages[0], { role: "assistant", content: first.text }, next.messages[2]] }));
});
test("identity, final counters and tool validity fail uncertain with no fallback or retry", async t => {
  const cases = [d.envelope({ model: "deepseek-flash" }), d.envelope({ choices: [] }), d.envelope({ usage: d.usage({ prompt_cache_miss_tokens: 59 }) }),
    d.envelope({ usage: d.usage({ prompt_tokens_details: { cached_tokens: 39 } }) }), d.envelope({ usage: d.usage({ total_tokens: 121 }) }),
    d.envelope({ usage: d.usage({ completion_tokens_details: { reasoning_tokens: 21 } }) }), d.envelope({ usage: d.usage({ prompt_cache_hit_tokens: undefined }) }),
    d.toolEnvelope("unrequested_tool"), d.envelope({ choices: [{ ...d.envelope().choices[0], message: { role: "assistant", content: "Missing reasoning" } }] }),
    d.envelope({ choices: [d.toolEnvelope().choices[0]], usage: d.usage({ completion_tokens: 101, total_tokens: 201 }) }),
    d.envelope({ choices: [{ index: 0, finish_reason: "aborted", message: { role: "assistant", content: "Partial" } }] })];
  for (const [i, payload] of cases.entries()) await t.test(String(i), async () => {
    const f = adapter(payload), result = await f.complete(d.request());
    assert.equal(result.status, "failed"); assert.equal(result.submission, "uncertain"); assert.equal(f.calls.length, 1);
    assert.equal(result.toolCalls, undefined); assert.ok(!JSON.stringify(result).includes("synthetic-only"));
  });
});
test("truncation settles bounded final usage while suppressing unfinished tool intents", async () => {
  const payload = d.toolEnvelope(); payload.choices[0].finish_reason = "length"; payload.choices[0].message.tool_calls[0].function.arguments = '{"unfinished":';
  const result = await adapter(payload).complete(d.request());
  assert.equal(result.status, "completed"); assert.equal(result.truncated, true); assert.equal(result.continuation, null); assert.deepEqual(result.toolCalls, []);
});
test("status, network failures, deadlines and response limits remain uncertain and sanitize diagnostics", async t => {
  for (const [label, fetch, code] of [["busy", async () => new Response("private", { status: 429 }), "provider_busy"],
    ["redirect", async () => new Response(null, { status: 307 }), "provider_error"], ["network", async () => { throw new Error("secret credential"); }, "network_error"],
    ["deadline", async () => new Promise(() => {}), "timeout"], ["limit", async () => new Response("x".repeat(DEEPSEEK_LIMITS.responseBytes + 1), { headers: { "content-type": "application/json" } }), "response_limit"]]) {
    await t.test(label, async () => { let calls = 0; const f = adapter(undefined, { timeoutMs: 15, fetch: async (...args) => { calls++; return fetch(...args); } });
      const result = await f.complete(d.request()); assert.equal(result.code, code); assert.equal(result.submission, "uncertain"); assert.equal(calls, 1);
      assert.ok(!JSON.stringify(result).includes("secret credential")); });
  }
});
