import type OpenAI from "openai";
import { env } from "node:process";
import { quoteAssistantCall } from "./billing.ts";
import { fundedFinalAnswer } from "./request-budget.ts";
import { getModel, RATE_CARD_VERSION } from "../models/catalog.ts";
import { NANO_USD_PER_CREDIT } from "../credits/pricing.ts";
import { CURRENT_PRICING_POLICY, markedUpPrice, pricingPolicyVersion, quotePricingPolicy, type PricingPolicyVersion } from "../credits/pricing-policy.ts";
import { quoteModel, reservationCredits } from "../models/estimate.ts";
import { count, freeze, record, timestamp } from "../models/execution-accounting/validate.ts";
import type { ContractPolicy } from "../models/execution-accounting/types.ts";
import { PROVIDER_BOUND_POLICY, providerRequestBudget, quoteProviderBudget } from "../models/providers/request-bounds.ts";
import { parseModelSelection, routeModel } from "../models/route.ts";
import { readModelReadiness, RELEASED_EXECUTION_REVIEWS } from "../models/readiness.ts";
import type { ExecutionReviews, ModelQuote, ModelSelection, RouteDecision, RouteReason, TokenBudget } from "../models/types.ts";

type SelectedDecision = Extract<RouteDecision, { status: "selected" }>;
export type AssistantModelRoute = {
  modelSelection: ModelSelection;
  modelDecision: SelectedDecision | null;
  modelResolvedAt: string;
  /** Older queued payloads keep their original adapter and reservation policy. */
  legacy?: true;
};
type Request = Pick<OpenAI.Chat.ChatCompletionCreateParams, "model" | "messages" | "tools" | "max_tokens">;
type Environment = Readonly<Record<string, string | undefined>>;

const messages: Partial<Record<RouteReason, string>> = {
  invalid_selection: "Choose a valid model.",
  model_unavailable: "The selected model is unavailable. Choose another model to continue.",
  no_ready_model: "The AI assistant isn't connected.",
  capability_mismatch: "The selected model cannot support this request's tools or images.",
  context_limit: "The conversation exceeds the selected model's supported limits.",
  minimum_hold: "Not enough credits for the minimum reservation.",
  insufficient_balance: "Not enough credits for this request's reservation.",
};
export class ModelSelectionError extends Error {
  readonly status: number;
  readonly decision: RouteDecision;
  constructor(decision: RouteDecision) {
    super(messages[decision.reason] ?? "The model selection could not be validated.");
    this.name = "ModelSelectionError";
    this.decision = decision;
    this.status = decision.reason === "invalid_selection" || decision.reason === "invalid_request" ? 400
      : ["minimum_hold", "insufficient_balance"].includes(decision.reason) ? 402
      : decision.reason === "no_ready_model" ? 503 : decision.reason === "model_unavailable" ? 409 : 422;
  }
}
function blocked(reason: RouteReason): never {
  throw new ModelSelectionError({ status: "blocked", reason, fallback: null });
}

/** Omitted selections from older clients preserve DeepSeek; malformed supplied values never default. */
export function requestModelSelection(value: unknown, supplied: boolean): ModelSelection {
  if (!supplied) return { mode: "explicit", modelId: "deepseek-flash" };
  return parseModelSelection(value) ?? blocked("invalid_selection");
}
export function formModelSelection(form: FormData): ModelSelection {
  const values = form.getAll("modelSelection");
  if (!values.length) return requestModelSelection(undefined, false);
  if (values.length !== 1 || typeof values[0] !== "string" || values[0].length > 256) blocked("invalid_selection");
  try { return requestModelSelection(JSON.parse(values[0] as string), true); }
  catch (error) { if (error instanceof ModelSelectionError) throw error; return blocked("invalid_selection"); }
}

/** A cheap availability check can reject an unavailable selection before opening an owner transaction. */
export function assertSelectionReady(selection: ModelSelection, environment: Environment = env, reviews: Readonly<ExecutionReviews> = RELEASED_EXECUTION_REVIEWS): void {
  const parsed = parseModelSelection(selection);
  if (!parsed) blocked("invalid_selection");
  const readiness = readModelReadiness(environment, reviews);
  if (parsed.mode === "explicit") {
    if (!readiness.find(model => model.modelId === parsed.modelId)?.selectable) blocked("model_unavailable");
  } else if (!readiness.some(model => model.selectable)) blocked("no_ready_model");
}

/** Same conservative framing/image bounds as the released quote; checked against it below.
 * No browser token estimates, cache hints, balance, readiness or quotes enter this path.
 */
function requestBounds(request: Request): { budget: TokenBudget; images: boolean } {
  let images = 0;
  const json = JSON.stringify({ messages: request.messages, tools: request.tools }, (key, value) => {
    if (key !== "image_url") return value;
    if (!value || typeof value.url !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value.url)) blocked("invalid_request");
    images++;
    return { detail: value.detail, url: "[image]" };
  });
  const input = Buffer.byteLength(json, "utf8") + 2048 + request.messages.length * 64 + (request.tools?.length ?? 0) * 128 + images * 1024;
  return { budget: { inputTokens: input, maxInputTokens: input, outputTokens: request.max_tokens!, maxOutputTokens: request.max_tokens! }, images: images > 0 };
}

/** Resolve Auto exactly once from current server readiness and a trusted, fully framed request. */
export function resolveAssistantModel(selection: ModelSelection, request: Request, availableCredits: number, environment: Environment = env, at = new Date().toISOString(), reviews: Readonly<ExecutionReviews> = RELEASED_EXECUTION_REVIEWS, boundPolicy: ContractPolicy = PROVIDER_BOUND_POLICY, pricingPolicy: PricingPolicyVersion = CURRENT_PRICING_POLICY): AssistantModelRoute {
  try { return resolveRequest(selection, request, availableCredits, environment, at, reviews, boundPolicy, pricingPolicy); }
  catch (error) {
    // Fund a smaller Flash answer before starting research. Explicit native choices
    // and unavailable providers retain their existing failure/consent behavior.
    if (!(error instanceof ModelSelectionError) || !["insufficient_balance", "minimum_hold"].includes(error.decision.reason)
      || (selection.mode === "explicit" && selection.modelId !== "deepseek-flash")
      || !readModelReadiness(environment, reviews).some(model => model.modelId === "deepseek-flash" && model.selectable)) throw error;
    const bounded = fundedFinalAnswer({ ...request, model: "deepseek-flash", stream: true }, availableCredits, pricingPolicy);
    if (!bounded) throw error;
    return resolveRequest(selection, bounded, availableCredits, environment, at, reviews, boundPolicy, pricingPolicy, true);
  }
}

function resolveRequest(selection: ModelSelection, request: Request, availableCredits: number, environment: Environment, at: string, reviews: Readonly<ExecutionReviews>, boundPolicy: ContractPolicy, pricingPolicy: PricingPolicyVersion, flashOnly = false): AssistantModelRoute {
  const bounds = requestBounds(request);
  // The bounded fallback is reconstructed only by the Flash execution path.
  const readiness = readModelReadiness(environment, reviews).filter(model => !flashOnly || model.modelId === "deepseek-flash");
  // Routing retains its existing ordering; each native provider supplies its own reviewed ceiling.
  const nativeQuotes = readiness.some(model => model.selectable && model.modelId !== "deepseek-flash");
  const decision = routeModel({ selection, availableCredits, budget: bounds.budget,
    capabilities: { text: true, tools: !!request.tools?.length, images: bounds.images }, at, pricingPolicyVersion: pricingPolicy }, readiness,
  nativeQuotes ? modelId => {
    if (modelId === "deepseek-flash") return quoteModel(modelId, bounds.budget, { at, pricingPolicyVersion: pricingPolicy });
    const native = providerRequestBudget(request, modelId, boundPolicy);
    return quoteProviderBudget(modelId, native.budget, at, boundPolicy, pricingPolicy);
  } : undefined);
  if (decision.status !== "selected") throw new ModelSelectionError(decision);
  if (decision.modelId === "deepseek-flash") {
    let ceiling: number;
    try { ceiling = quoteAssistantCall({ ...request, model: decision.modelId }, pricingPolicy); }
    catch { return blocked("context_limit"); }
    if (ceiling !== decision.quote.reservationPriceNanoUsd || reservationCredits(ceiling) !== decision.quote.reservationCredits) blocked("model_unavailable");
  }
  return freeze({ modelSelection: selection, modelDecision: decision, modelResolvedAt: at });
}

export function legacyAssistantModel(): AssistantModelRoute {
  return { modelSelection: { mode: "explicit", modelId: "deepseek-flash" }, modelDecision: null, modelResolvedAt: new Date().toISOString(), legacy: true };
}

/** Partial or malformed new payloads are not legacy payloads and cannot switch back to Auto. */
export function persistedAssistantModel(payload: Partial<AssistantModelRoute>): AssistantModelRoute {
  if (payload.modelSelection === undefined && payload.modelDecision === undefined && payload.modelResolvedAt === undefined && payload.legacy === undefined) return legacyAssistantModel();
  try {
    const selection = parseModelSelection(payload.modelSelection);
    const selected = record(payload.modelDecision, ["status", "modelId", "reason", "quote", "fallback"]);
    const model = getModel(selected.modelId);
    if (!selection || payload.legacy !== undefined || !model || selected.status !== "selected" || selected.fallback !== null ||
      (selection.mode === "explicit" ? selection.modelId !== model.id || selected.reason !== "explicit_selection"
        : !["auto_affordable", "auto_cache_scenario"].includes(selected.reason as string))) blocked("invalid_selection");
    const q = record(selected.quote, ["modelId", "rateCardVersion", "estimatedCostNanoUsd", "estimatedPriceNanoUsd", "estimatedCredits",
      "reservationPriceNanoUsd", "reservationCredits", "estimateBasis", "estimatedCacheReadTokens", "cacheHitGuaranteed", "minimumReservationCredits"], ["pricingPolicyVersion"]);
    const quote: ModelQuote = {
      ...(q.pricingPolicyVersion === undefined ? {} : { pricingPolicyVersion: pricingPolicyVersion(q.pricingPolicyVersion) }),
      modelId: model.id, rateCardVersion: RATE_CARD_VERSION, estimatedCostNanoUsd: count(q.estimatedCostNanoUsd),
      estimatedPriceNanoUsd: count(q.estimatedPriceNanoUsd), estimatedCredits: q.estimatedCredits as number,
      reservationPriceNanoUsd: count(q.reservationPriceNanoUsd, true), reservationCredits: count(q.reservationCredits, true),
      estimateBasis: q.estimateBasis as ModelQuote["estimateBasis"], estimatedCacheReadTokens: count(q.estimatedCacheReadTokens),
      cacheHitGuaranteed: false, minimumReservationCredits: 2,
    };
    if (q.modelId !== model.id || q.rateCardVersion !== RATE_CARD_VERSION || q.cacheHitGuaranteed !== false || q.minimumReservationCredits !== 2 ||
      !["uncached", "compatible_cache_scenario"].includes(quote.estimateBasis) ||
      (quote.estimatedCacheReadTokens > 0) !== (quote.estimateBasis === "compatible_cache_scenario") ||
      (selection.mode === "auto" && (selected.reason === "auto_cache_scenario") !== (quote.estimateBasis === "compatible_cache_scenario")) ||
      quote.estimatedPriceNanoUsd !== markedUpPrice(quote.estimatedCostNanoUsd, quotePricingPolicy(quote), "ceil") ||
      quote.estimatedCredits !== quote.estimatedPriceNanoUsd / NANO_USD_PER_CREDIT ||
      quote.estimatedPriceNanoUsd > quote.reservationPriceNanoUsd ||
      quote.reservationCredits !== reservationCredits(quote.reservationPriceNanoUsd)) blocked("invalid_selection");
    const decision: SelectedDecision = { status: "selected", modelId: model.id, reason: selected.reason as RouteReason, quote, fallback: null };
    return freeze({ modelSelection: selection, modelDecision: decision, modelResolvedAt: timestamp(payload.modelResolvedAt) });
  } catch { return blocked("invalid_selection"); }
}

/** Revalidate the resolved ID, never reroute Auto. Existing atomic holds remain the balance authority.
 * Call before reservation and again from meteredStream's beforeSend hook, after the hold is obtained.
 */
export function revalidateAssistantModel(route: AssistantModelRoute, request: Request, environment: Environment = env, reviews: Readonly<ExecutionReviews> = RELEASED_EXECUTION_REVIEWS, boundPolicy: ContractPolicy = PROVIDER_BOUND_POLICY): void {
  if (route.legacy) {
    if (request.model !== "deepseek-flash") blocked("model_unavailable");
    if (route.modelDecision !== null || route.modelSelection.mode !== "explicit" || route.modelSelection.modelId !== "deepseek-flash") blocked("invalid_selection");
    const readiness = readModelReadiness(environment, reviews).find(model => model.modelId === "deepseek-flash");
    if (!readiness?.selectable) blocked("model_unavailable");
    quoteAssistantCall(request);
    return;
  }
  const persisted = persistedAssistantModel(route);
  if (request.model !== persisted.modelDecision!.modelId) blocked("model_unavailable");
  const current = resolveAssistantModel({ mode: "explicit", modelId: persisted.modelDecision!.modelId }, request, Number.MAX_SAFE_INTEGER, environment, new Date().toISOString(), reviews, boundPolicy, quotePricingPolicy(persisted.modelDecision!.quote));
  if (current.modelDecision!.modelId !== persisted.modelDecision!.modelId) blocked("model_unavailable");
}
