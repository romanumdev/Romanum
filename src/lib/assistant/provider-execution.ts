import type OpenAI from "openai";
import { createHash } from "node:crypto";
import { env } from "node:process";
import type { Database } from "../history/database.ts";
import { readProviderAttempt, reserveProviderAttempt, submitProviderAttempt, finishProviderAttempt } from "../credits/provider-attempts.ts";
import { createAccountingContract } from "../models/execution-accounting/decision.ts";
import { adapterOutcome } from "../models/execution-accounting/adapter-evidence.ts";
import { getModel } from "../models/catalog.ts";
import { readModelReadiness, RELEASED_EXECUTION_REVIEWS } from "../models/readiness.ts";
import { providerAccountingAvailable } from "../models/provider-schema.ts";
import type { ExecutionReviews } from "../models/types.ts";
import { compileOpenAIRequest, createOpenAIAdapter } from "../models/providers/openai.ts";
import { compileAnthropicRequest, createAnthropicAdapter } from "../models/providers/anthropic.ts";
import { compileDeepSeekRequest, createDeepSeekAdapter } from "../models/providers/deepseek.ts";
import { PROVIDER_BOUND_POLICY, providerBoundReview, providerRequestBudget, quoteProviderBudget } from "../models/providers/request-bounds.ts";
import type { ContractPolicy } from "../models/execution-accounting/types.ts";
import type { AnthropicRequest, AnthropicContinuation, OpenAIRequest, OpenAIContinuation, ProviderMessage, OpenAIMessage,
  DeepSeekRequest, DeepSeekContinuation, ProviderTool, InputPart, ToolCall, JsonValue } from "../models/providers/types.ts";
import { safeJson, freezeWire } from "../models/providers/wire.ts";
import { quotePricingPolicy } from "../credits/pricing-policy.ts";
import { persistedAssistantModel, revalidateAssistantModel, type AssistantModelRoute } from "./model-selection.ts";

type Request = OpenAI.Chat.ChatCompletionCreateParamsStreaming;
export type ProviderExecutionOptions = {
  environment?: Readonly<Record<string, string | undefined>>; reviews?: Readonly<ExecutionReviews>; boundsPolicy?: ContractPolicy;
  /** Trusted fixture transport only; no browser or environment-controlled endpoint. */
  fetch?: typeof globalThis.fetch; now?: () => string; timeoutMs?: number;
};
export type ProviderExecutionContext = { ownerId: string; feature: "ask" | "chat"; conversationId: string; runId: string | null };
export type ProviderAssistantCompletion = { content: string; calls: { id: string; name: string; arguments: string }[]; terminal: boolean; truncated: boolean };
export interface AssistantProviderExecution {
  complete(route: AssistantModelRoute, request: Request, options: { step: number; signal: AbortSignal; beforeSend: () => Promise<void> }): Promise<ProviderAssistantCompletion>;
}

function toolCalls(message: OpenAI.Chat.ChatCompletionAssistantMessageParam): ToolCall[] {
  return (message.tool_calls ?? []).map(call => {
    if (call.type !== "function") throw new Error("Only application function tools are supported.");
    const input = JSON.parse(call.function.arguments);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid tool arguments.");
    safeJson(input, 64 * 1024);
    return { id: call.id, name: call.function.name, input };
  });
}
function userContent(content: OpenAI.Chat.ChatCompletionUserMessageParam["content"]): string | InputPart[] {
  if (typeof content === "string") return content;
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type !== "image_url") throw new Error("Unsupported input content.");
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(part.image_url.url);
    if (!match) throw new Error("Only validated inline media is supported.");
    return { type: "image", mediaType: match[1] as Extract<InputPart, { type: "image" }>["mediaType"], data: match[2] };
  });
}

/** The browser never supplies native reasoning. Earlier completed tool turns become visible history;
 * authentic continuation from this invocation is retained privately and replayed verbatim within its tool loop.
 * A crashed invocation never replays tool effects or automatically resubmits a durable dispatch.
 */
export function createAssistantProviderExecution(db: Database, context: ProviderExecutionContext,
  onPrice: (priceNanoUsd: number) => void, options: ProviderExecutionOptions = {}): AssistantProviderExecution {
  if (typeof window !== "undefined") throw new Error("Provider execution is server-only.");
  const environment = options.environment ?? env, reviews = options.reviews ?? RELEASED_EXECUTION_REVIEWS;
  const policy = options.boundsPolicy ?? PROVIDER_BOUND_POLICY, contract = createAccountingContract(policy);
  const now = options.now ?? (() => new Date().toISOString());
  const native = new Map<number, OpenAIContinuation | AnthropicContinuation | DeepSeekContinuation>();
  let firstUser: number | null = null;
  return Object.freeze({ async complete(route: AssistantModelRoute, raw: Request, callOptions: Parameters<AssistantProviderExecution["complete"]>[2]): Promise<ProviderAssistantCompletion> {
    const pinned = persistedAssistantModel(route), modelId = pinned.modelDecision!.modelId, model = getModel(modelId)!;
    if (modelId === "deepseek-flash" || raw.model !== modelId || !Number.isSafeInteger(callOptions.step) || callOptions.step < 0) throw new Error("Invalid pinned native attempt.");
    revalidateAssistantModel(pinned, raw, environment, reviews, policy);
    callOptions.signal.throwIfAborted();
    if (!await providerAccountingAvailable(db)) throw new Error("The selected model is unavailable. Choose another model to continue.");
    const request = freezeWire(JSON.parse(safeJson(raw, 8 * 1024 * 1024, true)) as Request);
    if (firstUser === null) firstUser = request.messages.findLastIndex(message => message.role === "user");
    if (firstUser < 0) throw new Error("A user request is required.");
    let system = "";
    const history: (ProviderMessage | OpenAIMessage)[] = [];
    for (const [index, message] of request.messages.entries()) {
      if (message.role === "system") {
        if (history.length || typeof message.content !== "string") throw new Error("Native system instructions must remain fixed across the turn.");
        system += (system ? "\n\n" : "") + message.content;
      } else if (message.role === "user") {
        const content = userContent(message.content);
        history.push({ role: "user", content: model.provider === "deepseek" && Array.isArray(content) && content.every(part => part.type === "text")
          ? content.map(part => (part as Extract<InputPart, { type: "text" }>).text).join("\n") : content });
      }
      else if (message.role === "assistant") {
        if (message.content != null && typeof message.content !== "string") throw new Error("Unsupported assistant history.");
        if (index < firstUser) {
          // Current-turn reasoning is not reconstructible from saved Chat Completions history.
          if (message.content) history.push(model.provider === "deepseek"
            ? { role: "user", content: `Earlier assistant answer:\n${message.content}` }
            : { role: "assistant", content: message.content });
        } else {
          const calls = toolCalls(message), continuation = native.get(index);
          if (calls.length && !continuation) throw new Error("Authentic native continuation is required.");
          history.push({ role: "assistant", content: message.content ?? "", ...(calls.length ? { toolCalls: calls } : {}),
            ...(continuation ? { continuation } : {}) } as ProviderMessage | OpenAIMessage);
        }
      } else if (message.role === "tool") {
        if (typeof message.content !== "string") throw new Error("Unsupported tool result.");
        history.push(index < firstUser
          ? { role: "user", content: `Earlier tool result (${message.tool_call_id}):\n${message.content}` }
          : { role: "tool", toolCallId: message.tool_call_id, content: message.content });
      } else throw new Error("Unsupported native message role.");
    }
    const bounded = providerRequestBudget(request, modelId, policy), review = providerBoundReview(modelId, policy);
    const tools: ProviderTool[] = (request.tools ?? []).map(tool => {
      if (tool.type !== "function") throw new Error("Only application tools are supported.");
      return { name: tool.function.name, description: tool.function.description ?? "",
        inputSchema: (tool.function.parameters ?? { type: "object" }) as Record<string, JsonValue> };
    });
    const common = { system, messages: history, ...(tools.length ? { tools } : {}), maxTokens: request.max_tokens!,
      maxInputTokens: bounded.budget.maxInputTokens, capabilities: { text: true, tools: tools.length > 0, images: bounded.images } };
    const translated = model.provider === "openai"
      ? { ...common, modelId, cacheTtl: "30m", reasoningEffort: "medium" } as OpenAIRequest
      : model.provider === "deepseek" ? { ...common, modelId, reasoningEffort: "high" } as DeepSeekRequest
      : { ...common, modelId, cacheTtl: "5m", stream: true } as AnthropicRequest;
    const compiled = model.provider === "openai" ? compileOpenAIRequest(translated as OpenAIRequest)
      : model.provider === "deepseek" ? compileDeepSeekRequest(translated as DeepSeekRequest) : compileAnthropicRequest(translated as AnthropicRequest);
    const attemptId = createHash("sha256").update(JSON.stringify(["romanum-native-attempt-v1", context.ownerId, context.feature, context.conversationId, context.runId, callOptions.step])).digest("hex");
    let state = await readProviderAttempt(db, attemptId, context.ownerId, contract);
    if (state && state.held.prepared.requestHash !== compiled.requestHash) throw new Error("A durable attempt cannot change its request.");
    if (!state) {
      const at = now(), quote = quoteProviderBudget(modelId, bounded.budget, at, policy, quotePricingPolicy(pinned.modelDecision!.quote));
      const prepared = contract.prepare({ version: 1, attemptId, ...context, step: callOptions.step, selection: pinned.modelSelection,
        modelId, provider: model.provider, adapterVersion: review.adapterVersion, requestFormatVersion: review.requestFormatVersion,
        requestHash: compiled.requestHash, bounds: { strategyId: review.strategyId, strategyVersion: review.strategyVersion,
          requestHash: compiled.requestHash, capabilities: ["text", ...(tools.length ? ["tools"] : []), ...(bounded.images ? ["images"] : [])], budget: bounded.budget },
        pricingProfile: "standard-global-text-v1", quote, preparedAt: at });
      state = await reserveProviderAttempt(db, prepared, contract);
    }
    if (state.phase !== "held") throw new Error("This durable provider attempt already dispatched or finished; automatic replay is disabled.");
    try {
      await callOptions.beforeSend();
      revalidateAssistantModel(pinned, request, environment, reviews, policy);
      callOptions.signal.throwIfAborted();
    } catch (error) {
      await finishProviderAttempt(db, attemptId, context.ownerId, adapterOutcome(state,
        { status: "failed", code: "cancelled", message: "Stopped before dispatch.", submission: "not_submitted", usage: null, usageComplete: false }, now()), contract);
      throw error;
    }
    const claim = await submitProviderAttempt(db, attemptId, context.ownerId, compiled.requestHash, contract, now());
    if (!claim.dispatch) throw new Error("Another worker claimed this attempt; automatic replay is disabled.");
    state = claim.state;
    const enabled = readModelReadiness(environment, reviews).find(item => item.modelId === modelId)?.selectable === true;
    const adapterOptions = { executionEnabled: enabled, fetch: options.fetch, timeoutMs: options.timeoutMs, now,
      getApiKey: () => environment[model.provider === "openai" ? "OPENAI_API_KEY" : model.provider === "deepseek" ? "DEEPSEEK_API_KEY" : "ANTHROPIC_API_KEY"] };
    const binding = { expectedRequestHash: compiled.requestHash, submittedAt: state.submission!.submittedAt };
    const result = model.provider === "openai"
      ? await createOpenAIAdapter(adapterOptions).complete(translated as OpenAIRequest, { signal: callOptions.signal, binding })
      : model.provider === "deepseek" ? await createDeepSeekAdapter(adapterOptions).complete(translated as DeepSeekRequest, { signal: callOptions.signal, binding })
      : await createAnthropicAdapter(adapterOptions).complete(translated as AnthropicRequest, { signal: callOptions.signal, binding });
    const settled = await finishProviderAttempt(db, attemptId, context.ownerId, adapterOutcome(state, result, now()), contract);
    onPrice(settled.priceNanoUsd);
    if (result.status !== "completed" || !settled.settled) throw new Error("Provider accounting requires reconciliation; no automatic retry.");
    await callOptions.beforeSend(); // Access can change while the response and ledger commit are in flight.
    callOptions.signal.throwIfAborted();
    if (result.continuation) native.set(request.messages.length, result.continuation);
    const terminal = result.truncated || ["refusal", "content_filter"].includes(result.stopReason);
    return { content: result.text, terminal, truncated: result.truncated, calls: terminal ? [] : result.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: safeJson(call.input, 64 * 1024) })) };
  } });
}
