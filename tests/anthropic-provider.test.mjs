import test from "node:test";
import assert from "node:assert/strict";
import { createAnthropicAdapter, translateAnthropicRequest, compileAnthropicRequest, ANTHROPIC_ADAPTER_VERSION,
  ANTHROPIC_REQUEST_FORMAT, ANTHROPIC_ENDPOINT, ANTHROPIC_VERSION, ANTHROPIC_LIMITS } from "../src/lib/models/providers/anthropic.ts";
import { readModelReadiness } from "../src/lib/models/readiness.ts";
import { costUsage } from "../src/lib/models/usage.ts";
import { MODEL_CATALOG } from "../src/lib/models/catalog.ts";
import { at, modelId, tool, request, usage, start, block, delta, close, finish, textEvents, toolEvents, sse, responseFrom, jsonMessage } from "./fixtures/anthropic-provider.mjs";

const fixtureKey = "synthetic-adapter-key";
test("Anthropic request hash and persisted dispatch time bind final accounting identity", async () => {
  const req = request({ stream: false }), compiled = compileAnthropicRequest(req);
  const sent = [], submittedAt = "2026-10-03T07:00:00.000Z";
  const adapter = createAnthropicAdapter({ executionEnabled: true, getApiKey: () => { req.system = "After snapshot"; return fixtureKey; },
    now: () => "2026-10-03T08:00:00.000Z", fetch: async (url, options) => { sent.push(options.body);
      return responseFrom(JSON.stringify(jsonMessage()), { contentType: "application/json" }); } });
  assert.ok(Object.isFrozen(compiled.body)); assert.ok(Object.isFrozen(compiled.body.messages));
  const result = await adapter.complete(req, { binding: { expectedRequestHash: compiled.requestHash, submittedAt } });
  assert.equal(result.status, "completed"); assert.equal(result.usage.at, submittedAt); assert.equal(result.evidence.submittedAt, submittedAt);
  assert.equal(result.evidence.requestHash, compiled.requestHash); assert.equal(result.evidence.adapterVersion, ANTHROPIC_ADAPTER_VERSION);
  assert.equal(result.evidence.requestFormatVersion, ANTHROPIC_REQUEST_FORMAT); assert.equal(result.evidence.reportedModelId, modelId);
  assert.equal(sent[0], compiled.json);
  const failedResult = await adapter.complete(req, { binding: { expectedRequestHash: compiled.requestHash, submittedAt } });
  assert.equal(failedResult.submission, "not_submitted"); assert.equal(sent.length, 1);
});
test("Anthropic final thinking breakdown is output subset, never an additional bill", async () => {
  const events = textEvents(); events.at(-2).usage.output_tokens_details = { thinking_tokens: 15 };
  const h = harness(responseFrom(sse(events))), result = await h.adapter.complete(request());
  assert.equal(result.status, "completed"); assert.equal(result.usage.outputTokens, 20);
  assert.equal(result.providerCostNanoUsd, costUsage(result.usage));
  for (const thinking_tokens of [-1, 21, "15", 0.5]) {
    const invalid = textEvents(); invalid.at(-2).usage.output_tokens_details = { thinking_tokens };
    assert.equal((await harness(responseFrom(sse(invalid))).adapter.complete(request())).status, "failed");
  }
});
test("Anthropic snapshot rejects accessors without invoking private getters", async () => {
  let reads = 0;
  const req = request(); Object.defineProperty(req, "system", { enumerable: true, get: () => { reads++; return "Private"; } });
  const h = harness(null);
  assert.equal((await h.adapter.complete(req)).submission, "not_submitted"); assert.equal(reads, 0); assert.equal(h.calls.length, 0);
});
function harness(response, extra = {}) {
  const calls = [];
  const adapter = createAnthropicAdapter({ executionEnabled: true, getApiKey: () => fixtureKey, now: () => at,
    fetch: async (url, options) => { calls.push({ url, options }); return typeof response === "function" ? response(url, options) : response; }, ...extra });
  return { adapter, calls };
}
async function fromEvents(events, req = request(), options = {}) {
  const { adapter, calls } = harness(responseFrom(sse(events), options));
  const result = await adapter.complete(req);
  assert.equal(calls.length, 1);
  return result;
}
function failed(result, code, submission = "uncertain") {
  assert.equal(result.status, "failed"); assert.equal(result.code, code); assert.equal(result.submission, submission);
  assert.ok(!JSON.stringify(result).includes(fixtureKey));
  assert.equal(result.toolCalls, undefined);
}

test("disabled and missing/removed keys never submit; importing the adapter does not activate catalog models", async () => {
  let key = fixtureKey;
  const { adapter, calls } = harness(responseFrom(sse(textEvents())), { executionEnabled: false, getApiKey: () => { throw Error("must not inspect a key"); } });
  failed(await adapter.complete(request()), "execution_disabled", "not_submitted"); assert.equal(calls.length, 0);
  const removed = harness(() => responseFrom(sse(textEvents())), { getApiKey: () => key });
  assert.equal((await removed.adapter.complete(request())).status, "completed");
  key = undefined;
  failed(await removed.adapter.complete(request()), "missing_key", "not_submitted"); assert.equal(removed.calls.length, 1);
  for (const key of [undefined, "", "  ", "bad\nheader"]) {
    const noKey = harness(null, { getApiKey: () => key });
    failed(await noKey.adapter.complete(request()), "missing_key", "not_submitted"); assert.equal(noKey.calls.length, 0);
  }
  assert.ok(readModelReadiness({ ANTHROPIC_API_KEY: fixtureKey }, {}).filter(model => model.modelId.startsWith("claude-")).every(model => !model.selectable && !model.executionEnabled));
});

test("translation preserves system, images, tool identity and immediate grouped tool results", () => {
  const body = translateAnthropicRequest(request({ cacheTtl: "1h", messages: [
    { role: "user", content: [{ type: "image", mediaType: "image/png", data: "AAAA" }, { type: "text", text: "Fixture image." }] },
    { role: "assistant", content: "Inspecting.", toolCalls: [{ id: "toolu_a", name: tool.name, input: { query: "a" } }, { id: "toolu_b", name: tool.name, input: { query: "b" } }] },
    { role: "tool", toolCallId: "toolu_b", content: "Synthetic B", isError: true },
    { role: "tool", toolCallId: "toolu_a", content: "Synthetic A" }, { role: "user", content: "Summarize." },
  ] }));
  assert.equal(body.model, modelId); assert.equal(body.system, request().system);
  assert.equal(body.messages[0].content[0].source.type, "base64");
  assert.deepEqual(body.messages[1].content[1], { type: "tool_use", id: "toolu_a", name: tool.name, input: { query: "a" } });
  assert.deepEqual(body.messages[2].content.map(block => block.type), ["tool_result", "tool_result", "text"]);
  assert.equal(body.messages[2].content[0].is_error, true);
  assert.deepEqual(body.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(body.tools[0].input_schema.type, "object");
  assert.equal(body.fallback, undefined);
});

test("forged configuration, capabilities, unsupported IDs, invalid bounds and orphaned history fail before submission", async () => {
  const bad = [
    [request({ modelId: "gpt-6-astra" }), "unsupported_model"], [request({ modelId: "claude-unlisted" }), "unsupported_model"],
    [request({ capabilities: { audio: true } }), "unsupported_capability"], [request({ baseURL: "https://invalid.example" }), "invalid_request"],
    [request({ thinking: { type: "adaptive" } }), "invalid_request"], [request({ cacheTtl: "30m" }), "invalid_request"],
    [request({ maxTokens: 16001 }), "invalid_request"], [request({ maxInputTokens: 200001 }), "invalid_request"],
    [request({ tools: [tool, tool] }), "invalid_request"], [request({ messages: [{ role: "assistant", content: "prefill" }] }), "invalid_request"],
    [request({ messages: [{ role: "tool", toolCallId: "orphan", content: "Fixture" }] }), "invalid_request"],
    [request({ messages: [{ role: "user", content: "Fixture" }, { role: "assistant", content: "", toolCalls: [{ id: "toolu_a", name: tool.name, input: {} }] },
      { role: "user", content: "Missing immediate result" }] }), "invalid_request"],
    [request({ messages: [{ role: "system", content: "Late system" }] }), "invalid_request"],
    [request({ messages: [{ role: "user", content: [{ type: "image", url: "https://invalid.example/image" }] }] }), "invalid_request"],
  ];
  for (const [req, code] of bad) {
    const { adapter, calls } = harness(null); failed(await adapter.complete(req), code, "not_submitted"); assert.equal(calls.length, 0);
  }
});

test("every allowlisted Anthropic model is sent explicitly to the fixed origin with no redirect or retry", async () => {
  for (const model of MODEL_CATALOG.filter(model => model.provider === "anthropic")) {
    const events = textEvents(); events[0] = start({ model: model.id });
    const { adapter, calls } = harness(responseFrom(sse(events)));
    const result = await adapter.complete(request({ modelId: model.id }));
    assert.equal(result.modelId, model.id);
    const call = calls[0]; assert.equal(call.url, ANTHROPIC_ENDPOINT);
    assert.equal(JSON.parse(call.options.body).model, model.id);
    assert.equal(call.options.headers.Authorization, `Bearer ${fixtureKey}`);
    assert.equal(call.options.headers["anthropic-version"], ANTHROPIC_VERSION);
    assert.equal(call.options.redirect, "error"); assert.equal(call.options.credentials, "omit");
    const sent = JSON.parse(call.options.body);
    assert.equal(sent.service_tier, "standard_only");
    if (model.id === modelId) { assert.equal(sent.inference_geo, undefined); assert.equal(sent.thinking, undefined); }
    else { assert.equal(sent.inference_geo, "global"); assert.deepEqual(sent.thinking, { type: "adaptive", display: "omitted" }); }
    assert.ok(!call.options.body.includes(fixtureKey)); assert.ok(!JSON.stringify(result).includes(fixtureKey));
  }
});

test("streamed text survives arbitrary UTF-8 chunk boundaries and LF, CRLF or CR framing", async () => {
  for (const ending of ["\n", "\r\n", "\r"]) for (const chunkBytes of [1, 2, 7, 4096]) {
    const seen = [], { adapter } = harness(responseFrom(sse(textEvents(), ending), { chunkBytes }));
    const result = await adapter.complete(request(), { onText: text => seen.push(text) });
    assert.equal(result.status, "completed"); assert.equal(result.text, "Fixture café 🏛.");
    assert.equal(seen.join(""), result.text); assert.equal(result.usage.outputTokens, 20);
    assert.equal(result.usage.totalInputTokens, 550); assert.equal(result.usageComplete, true);
  }
});

test("ping, comment, multiline data and unknown extension events do not damage known stream state", async () => {
  const stream = ': fixture keepalive\n\nevent: extension_notice\ndata: {"type":"extension_notice","value":1}\n\n' +
    sse([start(), { type: "ping" }, ...textEvents().slice(1)]).replace('data: {"type":"message_start",', 'data: {"type":"message_start",\ndata: ');
  const { adapter } = harness(responseFrom(stream, { chunkBytes: 3 }));
  assert.equal((await adapter.complete(request())).status, "completed");
});

test("complete streamed tool calls parse once as bounded objects and remain separate from provisional text", async () => {
  const seen = [], { adapter } = harness(responseFrom(sse(toolEvents()), { chunkBytes: 2 }));
  const result = await adapter.complete(request(), { onText: text => seen.push(text) });
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.toolCalls, [{ id: "toolu_fixture_1", name: tool.name, input: { query: "synthetic sample" } }]);
  assert.equal(seen.join(""), "Checking fixtures. "); assert.equal(result.truncated, false);
});

test("malformed, nonobject, dangerous or oversized tool arguments never produce executable calls", async () => {
  for (const json of ['{"query":', '[]', 'null', '{"__proto__":{"polluted":true}}', JSON.stringify({ nested: { constructor: "bad" } })]) {
    const result = await fromEvents(toolEvents(json)); failed(result, "invalid_response"); assert.equal(result.usageComplete, true);
  }
  const oversized = JSON.stringify({ query: "x".repeat(ANTHROPIC_LIMITS.toolJsonBytes) });
  failed(await fromEvents(toolEvents(oversized)), "response_limit");
  const deep = '{"nested":'.repeat(34) + '{}' + '}'.repeat(34);
  failed(await fromEvents(toolEvents(deep)), "invalid_response");
});

test("parallel tool blocks preserve index order and reject duplicate IDs or undeclared tool names", async () => {
  const events = [start(), block(0, { type: "tool_use", id: "toolu_a", name: tool.name, input: {} }),
    block(1, { type: "tool_use", id: "toolu_b", name: tool.name, input: {} }),
    delta(1, { type: "input_json_delta", partial_json: '{"query":"b"}' }), close(1),
    delta(0, { type: "input_json_delta", partial_json: '{"query":"a"}' }), close(0), ...finish("tool_use")];
  assert.deepEqual((await fromEvents(events)).toolCalls.map(call => call.id), ["toolu_a", "toolu_b"]);
  const duplicate = structuredClone(events); duplicate[2].content_block.id = "toolu_a";
  failed(await fromEvents(duplicate), "invalid_response");
  const undeclared = toolEvents(); undeclared[3].content_block.name = "not_allowed";
  failed(await fromEvents(undeclared), "invalid_response");
});

test("token/context truncation exposes final usage and incomplete text but drops all tool calls without retry", async () => {
  for (const reason of ["max_tokens", "model_context_window_exceeded"]) {
    const result = await fromEvents(toolEvents('{"query":"unfinished', reason));
    assert.equal(result.status, "completed"); assert.equal(result.truncated, true); assert.equal(result.stopReason, reason);
    assert.equal(result.text, "Checking fixtures. "); assert.deepEqual(result.toolCalls, []); assert.equal(result.usageComplete, true);
  }
  const refusal = await fromEvents([...textEvents().slice(0, -2), ...finish("refusal")]);
  assert.equal(refusal.stopReason, "refusal"); assert.deepEqual(refusal.toolCalls, []);
});

test("nonstreaming JSON translates text/tool calls and uses the same actual-usage accounting", async () => {
  const raw = jsonMessage({ content: [{ type: "text", text: "Synthetic." }, { type: "tool_use", id: "toolu_a", name: tool.name, input: { query: "fixture" } }], stop_reason: "tool_use" });
  const { adapter } = harness(responseFrom(JSON.stringify(raw), { contentType: "application/json", chunkBytes: 1 }));
  const result = await adapter.complete(request({ stream: false }));
  assert.equal(result.status, "completed"); assert.equal(result.text, "Synthetic.");
  assert.deepEqual(result.toolCalls[0].input, { query: "fixture" }); assert.equal(costUsage(result.usage), 392500);
});

test("5-minute, 1-hour and mixed cache writes partition reads/writes/misses and output is cumulative", async () => {
  for (const [cacheTtl, creation, expectedCost] of [
    ["5m", { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 }, 392500],
    ["1h", { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 }, 430000],
    ["1h", { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 }, 500000],
  ]) {
    const count = creation.ephemeral_5m_input_tokens + creation.ephemeral_1h_input_tokens;
    const events = [start({ usage: usage({ cache_creation_input_tokens: count, cache_creation: creation }) }), ...textEvents().slice(1, -2),
      { type: "message_delta", delta: {}, usage: { output_tokens: 10 } }, ...finish()];
    const result = await fromEvents(events, request({ cacheTtl }));
    assert.equal(result.status, "completed"); assert.equal(result.usage.outputTokens, 20);
    assert.equal(result.usage.totalInputTokens, 500 + count); assert.equal(result.usage.inputMissTokens, 200);
    assert.equal(result.usage.cacheReadTokens, 300); assert.equal(costUsage(result.usage), expectedCost);
  }
  for (const cacheTtl of ["5m", "1h"]) {
    const events = textEvents(); events[0] = start({ usage: usage({ cache_creation: undefined }) });
    const result = await fromEvents(events, request({ cacheTtl }));
    assert.equal(result.usage[cacheTtl === "5m" ? "cacheWrite5mTokens" : "cacheWrite1hTokens"], 50);
  }
});

test("cache misses and late cumulative input counters replace snapshots instead of being summed", async () => {
  const events = textEvents(); events[0] = start({ usage: usage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }) });
  events.splice(-2, 0, { type: "message_delta", delta: {}, usage: { input_tokens: 200, output_tokens: 10 } });
  events[events.length - 2].usage.input_tokens = 200;
  const result = await fromEvents(events);
  assert.equal(result.usage.totalInputTokens, 200); assert.equal(result.usage.outputTokens, 20); assert.equal(costUsage(result.usage), 300000);
});

test("bad final usage, decreasing counters, unknown tiers or server charges fail closed", async () => {
  const variants = [];
  const noFinalUsage = textEvents(); delete noFinalUsage.at(-2).usage; variants.push([noFinalUsage, "invalid_response"]);
  const regression = textEvents(); regression.splice(-2, 0, { type: "message_delta", delta: {}, usage: { output_tokens: 21 } }); variants.push([regression, "invalid_response"]);
  for (const extra of [{ output_tokens: -1 }, { cache_creation_input_tokens: 49 }, { input_tokens: "200" }]) {
    const events = textEvents(); events[0] = start({ usage: usage(extra) }); variants.push([events, "invalid_response"]);
  }
  for (const extra of [{ service_tier: "priority" }, { inference_geo: "us" }, { speed: "fast" }, { server_tool_use: { web_search_requests: 1 } }, { iterations: [{}, {}] }]) {
    const events = textEvents(); events[0] = start({ usage: usage(extra) }); variants.push([events, "unsupported_capability"]);
  }
  for (const [events, code] of variants) failed(await fromEvents(events), code);
  const over = await fromEvents(textEvents(), request({ maxInputTokens: 500 }));
  failed(over, "invalid_response"); assert.equal(over.usageComplete, true); assert.equal(over.usage.totalInputTokens, 550);
});

test("frontier omitted thinking preserves opaque signatures and ordered native content for a bound tool continuation", async () => {
  const req = request({ modelId: "claude-opus-5-5" });
  const events = [start({ model: req.modelId }), block(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "thinking_delta", thinking: "" }), delta(0, { type: "signature_delta", signature: "synthetic_signature_" }),
    delta(0, { type: "signature_delta", signature: "part_b" }), close(0),
    block(1, { type: "redacted_thinking", data: "synthetic_redacted_fixture" }), close(1),
    block(2, { type: "text", text: "Checking fixtures." }), close(2),
    block(3, { type: "tool_use", id: "toolu_fixture_1", name: tool.name, input: {} }),
    delta(3, { type: "input_json_delta", partial_json: '{"query":"fixture"}' }), close(3), ...finish("tool_use")];
  const seen = [], { adapter } = harness(responseFrom(sse(events), { chunkBytes: 1 }));
  const result = await adapter.complete(req, { onText: text => seen.push(text) });
  assert.equal(result.status, "completed"); assert.equal(seen.join(""), "Checking fixtures.");
  assert.deepEqual(result.continuation.content.map(block => block.type), ["thinking", "redacted_thinking", "text", "tool_use"]);
  assert.equal(result.continuation.content[0].signature, "synthetic_signature_part_b");
  const continued = request({ ...req, messages: [...req.messages,
    { role: "assistant", content: result.text, toolCalls: result.toolCalls, continuation: result.continuation },
    { role: "tool", toolCallId: result.toolCalls[0].id, content: "Synthetic result." }] });
  assert.deepEqual(translateAnthropicRequest(continued).messages[1].content, result.continuation.content);
  for (const modified of [
    { ...continued, system: "Changed prefix" }, { ...continued, cacheTtl: "1h" },
    { ...continued, tools: [{ ...tool, description: "Changed schema context" }] },
    { ...continued, modelId: "claude-fable-5-1" },
    { ...continued, messages: [{ role: "user", content: "Changed history" }, ...continued.messages.slice(1)] },
  ]) {
    const untouched = harness(null); failed(await untouched.adapter.complete(modified), "invalid_request", "not_submitted"); assert.equal(untouched.calls.length, 0);
  }
});

test("missing or readable thinking signatures never leak into text or permit an unsafe continuation", async () => {
  const missing = [start(), block(0, { type: "thinking", thinking: "", signature: "" }), close(0), ...finish()];
  const result = await fromEvents(missing); failed(result, "invalid_response"); assert.equal(result.usageComplete, true);
  const readable = [start(), block(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "thinking_delta", thinking: "Synthetic unsupported readable thought" })];
  const seen = [], { adapter } = harness(responseFrom(sse(readable)));
  failed(await adapter.complete(request(), { onText: text => seen.push(text) }), "unsupported_capability"); assert.deepEqual(seen, []);
  const truncated = await fromEvents([...missing.slice(0, -2), ...finish("max_tokens")]);
  assert.equal(truncated.status, "completed"); assert.equal(truncated.continuation, null);
});

test("a returned model change, fallback block or unsupported response capability cannot silently replace the choice", async () => {
  const changed = textEvents(); changed[0] = start({ model: "claude-opus-5-5" }); failed(await fromEvents(changed), "model_mismatch");
  const fallback = [start(), block(0, { type: "fallback", model: "claude-opus-5-5" })]; failed(await fromEvents(fallback), "model_mismatch");
  const thinking = [start(), block(0, { type: "thinking", thinking: "opaque", signature: "fixture" })]; failed(await fromEvents(thinking), "unsupported_capability");
  const paused = [...textEvents().slice(0, -2), ...finish("pause_turn")]; failed(await fromEvents(paused), "unsupported_capability");
});

test("partial JSON/UTF-8, wrong event types, missing stops and invalid ordering never finish successfully", async () => {
  for (const events of [textEvents().slice(0, -1), textEvents().filter(event => event.type !== "content_block_stop"),
    [start(), delta(0, { type: "text_delta", text: "orphan" })], [start(), start()],
    [start(), block(1, { type: "text", text: "wrong index" })]]) {
    const result = await fromEvents(events); assert.equal(result.status, "failed"); assert.equal(result.usageComplete, false);
  }
  const emptyToolTurn = await fromEvents([start(), ...finish("tool_use")]);
  failed(emptyToolTurn, "invalid_response"); assert.equal(emptyToolTurn.usageComplete, true);
  const streams = [
    ['event: message_start\ndata: {"type":\n\n', "invalid_response"],
    ['event: ping\ndata: {"type":"message_stop"}\n\n', "invalid_response"],
    [sse(textEvents()).trimEnd(), "incomplete_stream"],
    [new Uint8Array([0xff, 0xfe]), "invalid_response"],
  ];
  for (const [stream, code] of streams) { const { adapter } = harness(responseFrom(stream)); failed(await adapter.complete(request()), code); }
});

test("HTTP and streamed provider failures are sanitized and never retried or treated as definitely unbilled", async () => {
  for (const [status, code] of [[400, "provider_error"], [401, "provider_unavailable"], [403, "provider_unavailable"], [429, "provider_busy"], [500, "provider_error"], [529, "provider_busy"]]) {
    const { adapter, calls } = harness(new Response(`private diagnostics ${fixtureKey}`, { status }));
    failed(await adapter.complete(request()), code); assert.equal(calls.length, 1);
  }
  const result = await fromEvents([start(), { type: "error", error: { type: "overloaded_error", message: `private ${fixtureKey}` } }]);
  failed(result, "provider_busy"); assert.equal(result.usageComplete, false); assert.equal(result.usage.outputTokens, 1);
  const { adapter, calls } = harness(() => { throw Error(`private transport ${fixtureKey}`); });
  failed(await adapter.complete(request()), "network_error"); assert.equal(calls.length, 1);
});

test("cancellation before submission prevents a call, and cancellation during streamed text aborts the one attempt", async () => {
  const before = new AbortController(); before.abort(); const untouched = harness(null);
  failed(await untouched.adapter.complete(request(), { signal: before.signal }), "cancelled", "not_submitted"); assert.equal(untouched.calls.length, 0);
  const during = new AbortController(), seen = [], { adapter, calls } = harness(responseFrom(sse(textEvents()), { chunkBytes: 1 }));
  const result = await adapter.complete(request(), { signal: during.signal, onText: text => { seen.push(text); during.abort(); } });
  failed(result, "cancelled"); assert.equal(result.usageComplete, false); assert.ok(seen.length); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, true);
});

test("timeouts bound both fetch and stalled body reads even when a mock transport ignores AbortSignal", async () => {
  const hangingFetch = harness(() => new Promise(() => {}), { timeoutMs: 10 });
  failed(await hangingFetch.adapter.complete(request()), "timeout"); assert.equal(hangingFetch.calls.length, 1);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse([start()]))); }, cancel() { cancelled = true; } });
  const hangingRead = harness(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }), { timeoutMs: 10 });
  const result = await hangingRead.adapter.complete(request()); failed(result, "timeout"); assert.equal(result.usageComplete, false);
  assert.equal(hangingRead.calls[0].options.signal.aborted, true); assert.equal(cancelled, true);
});

test("consumer exceptions are sanitized, stop the stream and never expose a partial tool call", async () => {
  const { adapter, calls } = harness(responseFrom(sse(toolEvents()), { chunkBytes: 1 }));
  failed(await adapter.complete(request(), { onText: () => { throw Error(`private ${fixtureKey}`); } }), "consumer_error");
  assert.equal(calls[0].options.signal.aborted, true); assert.equal(calls.length, 1);
});

test("event, text, tool-count and total JSON response limits cancel excess output", async () => {
  const largeEvent = 'event: extension_notice\ndata: {"type":"extension_notice","value":"' + "x".repeat(ANTHROPIC_LIMITS.eventBytes) + '"}\n\n';
  const tooLarge = harness(responseFrom(largeEvent)); failed(await tooLarge.adapter.complete(request()), "response_limit");
  const text = [start(), block(0, { type: "text", text: "" }), ...Array.from({ length: 6 }, () => delta(0, { type: "text_delta", text: "x".repeat(200_000) })), close(0), ...finish()];
  failed(await fromEvents(text), "response_limit");
  const calls = [start(), ...Array.from({ length: 17 }, (_, index) => [block(index, { type: "tool_use", id: `toolu_${index}`, name: tool.name, input: {} }), close(index)]).flat(), ...finish("tool_use")];
  failed(await fromEvents(calls), "response_limit");
  const json = harness(responseFrom(" ".repeat(ANTHROPIC_LIMITS.responseBytes + 1), { contentType: "application/json" }));
  failed(await json.adapter.complete(request({ stream: false })), "response_limit");
});

test("wrong media types and malformed nonstream JSON fail; browser use and invalid timeouts are rejected", async () => {
  const wrong = harness(responseFrom(JSON.stringify(jsonMessage()), { contentType: "application/json" }));
  failed(await wrong.adapter.complete(request()), "invalid_response");
  const malformed = harness(responseFrom('{"content":', { contentType: "application/json" }));
  failed(await malformed.adapter.complete(request({ stream: false })), "invalid_response");
  assert.throws(() => createAnthropicAdapter({ timeoutMs: 0 }), /timeout/);
  globalThis.window = {};
  try { assert.throws(() => createAnthropicAdapter(), /server-only/); } finally { delete globalThis.window; }
});

test("an in-flight request uses its validated snapshot even if the caller mutates the original selection/tools", async () => {
  const req = request(), { adapter } = harness(() => { req.modelId = "gpt-6-astra"; req.tools = []; return responseFrom(sse(toolEvents())); });
  const result = await adapter.complete(req);
  assert.equal(result.status, "completed"); assert.equal(result.modelId, modelId); assert.equal(result.toolCalls[0].name, tool.name);
});
