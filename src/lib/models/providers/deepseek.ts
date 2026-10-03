import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { env } from "node:process";
import { z } from "zod";
import { getModel } from "../catalog.ts";
import { costUsage, normalizeUsage } from "../usage.ts";
import type { NormalizedUsage } from "../types.ts";
import { canonicalTime, compileWire, safeJson } from "./wire.ts";
import { NATIVE_INPUT_CAPACITY } from "./native-capacity.ts";
import { providerFailureDiagnostic } from "./failure-diagnostics.ts";
import type { AdapterErrorCode, AnthropicAdapterOptions, DeepSeekOutputMessage, DeepSeekRequest, DeepSeekResult,
  JsonValue, OpenAICallOptions, ProviderFailurePhase, ToolCall } from "./types.ts";

export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_ADAPTER_VERSION = "deepseek-pro-chat-v1";
export const DEEPSEEK_REQUEST_FORMAT = "deepseek-pro-chat-json-v1";
export const DEEPSEEK_LIMITS = Object.freeze({ requestBytes: 8 * 1024 * 1024, responseBytes: 4 * 1024 * 1024,
  textBytes: 1024 * 1024, reasoningBytes: 2 * 1024 * 1024, toolJsonBytes: 64 * 1024, toolCalls: 16 });
class Fault extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode) { super(`Model request: ${code}.`); this.code = code; }
}
function fail(code: AdapterErrorCode): never { throw new Fault(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_response");
  return value as Record<string, unknown>;
}
function json(value: unknown, code: AdapterErrorCode, limit: number): string {
  try { return safeJson(value, limit); } catch { return fail(code); }
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const jsonObject = z.record(z.string(), z.unknown());
const call = z.object({ id, name, input: jsonObject }).strict();
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string().min(1) }).strict(),
  z.object({ role: z.literal("assistant"), content: z.string(), toolCalls: z.array(call).max(DEEPSEEK_LIMITS.toolCalls).optional(),
    continuation: z.object({ provider: z.literal("deepseek"), modelId: z.literal("deepseek-v4-pro"),
      prefixHash: z.string().regex(/^[a-f0-9]{64}$/), content: jsonObject }).strict().optional() }).strict(),
  z.object({ role: z.literal("tool"), toolCallId: id, content: z.string(), isError: z.boolean().optional() }).strict(),
]);
const requestSchema = z.object({ modelId: z.literal("deepseek-v4-pro"), system: z.string().optional(),
  messages: z.array(message).min(1).max(512),
  tools: z.array(z.object({ name, description: z.string().max(16_384), inputSchema: jsonObject }).strict()).max(64).optional(),
  maxTokens: z.number().int().min(1).max(16_000), maxInputTokens: z.number().int().min(1).max(1_000_000),
  reasoningEffort: z.enum(["low", "high", "max"]).optional(),
  capabilities: z.object({ text: z.boolean().optional(), tools: z.boolean().optional(), images: z.boolean().optional() }).strict().optional(),
}).strict();
type WireMessage = Record<string, unknown>;
export type DeepSeekWireRequest = {
  model: "deepseek-v4-pro"; messages: WireMessage[]; tools?: WireMessage[]; max_tokens: number;
  thinking: { type: "enabled" }; reasoning_effort: "low" | "high" | "max"; stream: false; tool_choice: "auto" | "none";
};
function prefixHash(base: Omit<DeepSeekWireRequest, "messages">, messages: WireMessage[]): string {
  return createHash("sha256").update(json({ ...base, messages }, "invalid_request", DEEPSEEK_LIMITS.requestBytes)).digest("hex");
}
function output(value: unknown, tools: readonly { name: string }[], truncated: boolean) {
  const raw = object(value);
  if (raw.role !== "assistant" || (raw.content !== null && typeof raw.content !== "string") ||
      (raw.reasoning_content != null && typeof raw.reasoning_content !== "string")) fail("invalid_response");
  if (!truncated && tools.length && typeof raw.reasoning_content !== "string") fail("invalid_response");
  const text = (raw.content ?? "") as string, reasoning = (raw.reasoning_content ?? "") as string;
  if (Buffer.byteLength(text) > DEEPSEEK_LIMITS.textBytes || Buffer.byteLength(reasoning) > DEEPSEEK_LIMITS.reasoningBytes) fail("response_limit");
  if (raw.tool_calls !== undefined && !Array.isArray(raw.tool_calls)) fail("invalid_response");
  const native: DeepSeekOutputMessage = { role: "assistant", content: raw.content as string | null, reasoning_content: reasoning };
  const toolCalls: ToolCall[] = [], ids = new Set<string>();
  for (const entry of (raw.tool_calls ?? []) as unknown[]) {
    const tool = object(entry), fn = object(tool.function);
    if (!id.safeParse(tool.id).success || ids.has(String(tool.id)) || tool.type !== "function" ||
        !name.safeParse(fn.name).success || !tools.some(t => t.name === fn.name) || typeof fn.arguments !== "string") fail("invalid_response");
    if (ids.size >= DEEPSEEK_LIMITS.toolCalls || Buffer.byteLength(fn.arguments as string) > DEEPSEEK_LIMITS.toolJsonBytes) fail("response_limit");
    ids.add(tool.id as string);
    if (!truncated) {
      let input: Record<string, unknown>;
      try { input = object(JSON.parse(fn.arguments as string)); } catch { return fail("invalid_response"); }
      json(input, "invalid_response", DEEPSEEK_LIMITS.toolJsonBytes);
      toolCalls.push({ id: tool.id as string, name: fn.name as string, input: input as Record<string, JsonValue> });
    }
    (native.tool_calls ??= []).push({ id: tool.id as string, type: "function", function: { name: fn.name as string, arguments: fn.arguments as string } });
  }
  return { text, toolCalls, native };
}

/** Pro has its own exact ID, text-only admission and automatic cache; no Flash fallback. */
export function translateDeepSeekRequest(value: DeepSeekRequest): DeepSeekWireRequest {
  json(value, "invalid_request", DEEPSEEK_LIMITS.requestBytes);
  if (value?.modelId !== "deepseek-v4-pro" || !getModel(value.modelId)) fail("unsupported_model");
  if (value.capabilities?.images || value.messages?.some(m => m.role === "user" && typeof m.content !== "string")) fail("unsupported_capability");
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) fail("invalid_request");
  const request = parsed.data;
  const tools = request.tools?.map(tool => {
    json(tool.inputSchema, "invalid_request", DEEPSEEK_LIMITS.toolJsonBytes);
    if (tool.inputSchema.type !== "object") fail("invalid_request");
    return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
  });
  if (new Set(request.tools?.map(tool => tool.name)).size !== (tools?.length ?? 0)) fail("invalid_request");
  const base: Omit<DeepSeekWireRequest, "messages"> = { model: "deepseek-v4-pro", max_tokens: request.maxTokens,
    thinking: { type: "enabled" }, reasoning_effort: request.reasoningEffort ?? "high", stream: false,
    tool_choice: tools?.length ? "auto" : "none", ...(tools?.length ? { tools } : {}) };
  const messages: WireMessage[] = request.system ? [{ role: "system", content: request.system }] : [];
  const seen = new Set<string>(); let pending = new Set<string>();
  for (const entry of request.messages) {
    if (entry.role === "tool") {
      if (!pending.delete(entry.toolCallId)) fail("invalid_request");
      messages.push({ role: "tool", tool_call_id: entry.toolCallId, content: entry.content }); continue;
    }
    if (pending.size) fail("invalid_request");
    if (entry.role === "user") { messages.push({ role: "user", content: entry.content }); continue; }
    const calls = entry.toolCalls ?? [];
    pending = new Set(calls.map(c => c.id));
    if (pending.size !== calls.length || calls.some(c => seen.has(c.id) || !request.tools?.some(t => t.name === c.name))) fail("invalid_request");
    calls.forEach(c => seen.add(c.id));
    if (entry.continuation) {
      const native = entry.continuation;
      if (native.prefixHash !== prefixHash(base, messages)) fail("invalid_request");
      const validated = output(native.content, request.tools ?? [], false);
      if (validated.text !== entry.content || JSON.stringify(validated.toolCalls) !== JSON.stringify(calls)) fail("invalid_request");
      messages.push(validated.native);
    } else {
      if (calls.length || !entry.content || tools?.length) fail("invalid_request");
      // Without tools, the API ignores prior reasoning. Tool requests require authentic continuation.
      messages.push({ role: "assistant", content: entry.content, reasoning_content: "" });
    }
  }
  if (pending.size || request.messages[0].role !== "user" || request.messages.at(-1)?.role === "assistant") fail("invalid_request");
  return { ...base, messages };
}
export function compileDeepSeekRequest(request: DeepSeekRequest) {
  return compileWire(translateDeepSeekRequest(request), { endpoint: DEEPSEEK_ENDPOINT, requestFormat: DEEPSEEK_REQUEST_FORMAT }, DEEPSEEK_LIMITS.requestBytes);
}

/** Single bounded JSON completion, disabled by default. Submitted failures stay uncertain; never retry. */
export function createDeepSeekAdapter(options: AnthropicAdapterOptions = {}) {
  if (typeof window !== "undefined") throw new Error("DeepSeek adapter is server-only.");
  const enabled = options.executionEnabled === true, fetcher = options.fetch ?? globalThis.fetch;
  const getKey = options.getApiKey ?? (() => env.DEEPSEEK_API_KEY), now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? 25_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid adapter timeout.");
  return Object.freeze({ async complete(request: DeepSeekRequest, callOptions: OpenAICallOptions = {}): Promise<DeepSeekResult> {
    let submitted = false, usage: NormalizedUsage | null = null, usageComplete = false;
    let phase: ProviderFailurePhase = "pre_dispatch";
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let interruption: "cancelled" | "timeout" | undefined;
    const controller = new AbortController();
    const interrupt = (code: "cancelled" | "timeout") => { if (!controller.signal.aborted) { interruption = code; controller.abort(); } };
    const cancel = () => interrupt("cancelled");
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Fault(interruption ?? "cancelled")), { once: true }));
    void aborted.catch(() => {});
    try {
      if (!enabled) fail("execution_disabled");
      const compiled = compileDeepSeekRequest(request), body = compiled.body;
      const snapshot = JSON.parse(json(request, "invalid_request", DEEPSEEK_LIMITS.requestBytes)) as DeepSeekRequest;
      if (callOptions.binding && (callOptions.binding.expectedRequestHash !== compiled.requestHash || !canonicalTime(callOptions.binding.submittedAt))) fail("invalid_request");
      const apiKey = getKey()?.trim();
      if (!apiKey || /\s/.test(apiKey) || apiKey.length > 1024) fail("missing_key");
      const at = callOptions.binding?.submittedAt ?? now();
      if (!canonicalTime(at)) fail("invalid_request");
      if (callOptions.signal?.aborted) fail("cancelled");
      callOptions.signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => interrupt("timeout"), timeoutMs);
      submitted = true; phase = "fetch";
      const response = await Promise.race([fetcher(DEEPSEEK_ENDPOINT, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body: compiled.json, signal: controller.signal }), aborted]);
      phase = "response_headers";
      if (!response.ok) fail([401, 402, 403].includes(response.status) ? "provider_unavailable" : response.status === 429 ? "provider_busy" : "provider_error");
      if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) fail("invalid_response");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let total = 0;
      for (;;) {
        phase = "response_body";
        const chunk = await Promise.race([reader.read(), aborted]); phase = "response_validation";
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > DEEPSEEK_LIMITS.responseBytes) fail("response_limit");
        chunks.push(chunk.value);
      }
      if (controller.signal.aborted) fail(interruption ?? "cancelled");
      let envelope: Record<string, unknown>;
      try { envelope = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); } catch { return fail("invalid_response"); }
      if (envelope.object !== "chat.completion" || !id.safeParse(envelope.id).success) fail("invalid_response");
      if (envelope.model !== snapshot.modelId) fail("model_mismatch");
      if (envelope.error != null || !Array.isArray(envelope.choices) || envelope.choices.length !== 1) fail("invalid_response");
      const choice = object(envelope.choices[0]);
      if (choice.index !== 0 || !["stop", "length", "content_filter", "tool_calls"].includes(String(choice.finish_reason))) fail("invalid_response");
      const rawUsage = object(envelope.usage);
      if (["prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "total_tokens"].some(key => rawUsage[key] === undefined)) fail("invalid_response");
      try { usage = normalizeUsage(snapshot.modelId, rawUsage, { at, cacheTtl: "automatic" }); } catch { fail("invalid_response"); }
      usageComplete = true;
      if (usage!.totalInputTokens > snapshot.maxInputTokens || usage!.outputTokens > snapshot.maxTokens ||
          usage!.totalInputTokens + usage!.outputTokens > NATIVE_INPUT_CAPACITY[snapshot.modelId]!) fail("invalid_response");
      const truncated = choice.finish_reason === "length", terminal = truncated || choice.finish_reason === "content_filter";
      const parsed = output(choice.message, snapshot.tools ?? [], terminal);
      if (!terminal && ((choice.finish_reason === "tool_calls") !== (parsed.toolCalls.length > 0))) fail("invalid_response");
      const { messages, ...base } = body;
      return { status: "completed", modelId: snapshot.modelId, messageId: envelope.id as string, text: parsed.text,
        toolCalls: terminal ? [] : parsed.toolCalls, stopReason: truncated ? "max_tokens" : choice.finish_reason === "content_filter" ? "content_filter" : parsed.toolCalls.length ? "tool_use" : "end_turn",
        truncated, usage: usage!, usageComplete: true, providerCostNanoUsd: costUsage(usage!),
        continuation: terminal ? null : { provider: "deepseek", modelId: snapshot.modelId, prefixHash: prefixHash(base, messages), content: parsed.native },
        evidence: { provider: "deepseek", adapterVersion: DEEPSEEK_ADAPTER_VERSION, requestFormatVersion: DEEPSEEK_REQUEST_FORMAT,
          requestHash: compiled.requestHash, submittedAt: at, reportedModelId: envelope.model as string,
          providerMessageId: envelope.id as string, pricingProfile: "standard-global-text-v1", terminalEvent: "completed" } };
    } catch (error) {
      const code = interruption ?? (error instanceof Fault ? error.code : "network_error");
      return { status: "failed", code, message: `Model request: ${code}.`, submission: submitted ? "uncertain" : "not_submitted", usage, usageComplete,
        diagnostic: providerFailureDiagnostic(error, phase, code) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callOptions.signal?.removeEventListener("abort", cancel);
      if (reader) void reader.cancel().catch(() => {});
      controller.abort();
    }
  } });
}
