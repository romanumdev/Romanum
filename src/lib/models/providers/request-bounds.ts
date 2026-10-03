import type OpenAI from "openai";
import { Buffer } from "node:buffer";
import { getModel, MODEL_CATALOG } from "../catalog.ts";
import { quoteNativeModel } from "../estimate.ts";
import type { ModelId, TokenBudget } from "../types.ts";
import type { ContractPolicy } from "../execution-accounting/types.ts";
import { validatePolicy } from "../execution-accounting/validate.ts";
import { OPENAI_ADAPTER_VERSION, OPENAI_REQUEST_FORMAT } from "./openai.ts";
import { ANTHROPIC_ADAPTER_VERSION, ANTHROPIC_REQUEST_FORMAT } from "./anthropic.ts";
import { DEEPSEEK_ADAPTER_VERSION, DEEPSEEK_REQUEST_FORMAT } from "./deepseek.ts";
import { NATIVE_BOUND_STRATEGY, NATIVE_BOUND_VERSION, NATIVE_INPUT_CAPACITY } from "./native-capacity.ts";
import { safeJson } from "./wire.ts";
import { CURRENT_PRICING_POLICY, type PricingPolicyVersion } from "../../credits/pricing-policy.ts";

export type ProviderBoundReviews = ContractPolicy;
export type ProviderAssistantRequest = Pick<OpenAI.Chat.ChatCompletionCreateParams, "model" | "messages" | "tools" | "max_tokens">;
/** No execution grant: reviewed capacity applies only to the exact single-sample native adapters. */
export const PROVIDER_BOUND_POLICY: ContractPolicy = validatePolicy({ reviewedBounds: MODEL_CATALOG
  .filter(model => NATIVE_INPUT_CAPACITY[model.id]).map(model => ({
    strategyId: NATIVE_BOUND_STRATEGY, strategyVersion: NATIVE_BOUND_VERSION, provider: model.provider, modelId: model.id,
    adapterVersion: model.provider === "openai" ? OPENAI_ADAPTER_VERSION : model.provider === "deepseek" ? DEEPSEEK_ADAPTER_VERSION : ANTHROPIC_ADAPTER_VERSION,
    requestFormatVersion: model.provider === "openai" ? OPENAI_REQUEST_FORMAT : model.provider === "deepseek" ? DEEPSEEK_REQUEST_FORMAT : ANTHROPIC_REQUEST_FORMAT,
    capabilities: ["text", "tools", ...(model.capabilities.images ? ["images"] : [])], cacheTtls: [...model.cacheTtls],
    maxInputTokens: NATIVE_INPUT_CAPACITY[model.id], maxOutputTokens: model.maxOutputTokens,
  })) });

export function providerBoundReview(modelId: ModelId, policy: ContractPolicy = PROVIDER_BOUND_POLICY) {
  const review = validatePolicy(policy).reviewedBounds.find(bound => bound.modelId === modelId &&
    bound.strategyId === NATIVE_BOUND_STRATEGY && bound.strategyVersion === NATIVE_BOUND_VERSION);
  if (!review) throw new Error("A reviewed native request bound is required.");
  return review;
}

/** Bytes/framing are ONLY admission and estimate inputs. The monetary ceiling is the full native window.
 * Includes cache-write premium and long-context rates, irrespective of admission estimates or expected hits.
 */
export function providerRequestBudget(request: ProviderAssistantRequest, modelId: ModelId = request.model as ModelId,
  policy: ContractPolicy = PROVIDER_BOUND_POLICY): { budget: TokenBudget; images: boolean } {
  const model = getModel(modelId), review = providerBoundReview(modelId, policy);
  if (!model || !Number.isSafeInteger(request.max_tokens) || request.max_tokens! < 1 || request.max_tokens! > review.maxOutputTokens) {
    throw new Error("Invalid bounded native request.");
  }
  const snapshot = JSON.parse(safeJson({ messages: request.messages, tools: request.tools ?? [] }, 8 * 1024 * 1024, true));
  let images = 0, imageBytes = 0;
  const framed = JSON.stringify(snapshot, (key, value) => {
    if (key !== "image_url") return value;
    if (!value || typeof value.url !== "string" || !/^data:image\/(png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.url)) {
      throw new Error("Only validated inline images are supported.");
    }
    imageBytes += Buffer.from(value.url.slice(value.url.indexOf(",") + 1), "base64").length;
    images++;
    return { url: "[inline image]" };
  });
  const input = Buffer.byteLength(framed) + 2048 + request.messages.length * 64 + (request.tools?.length ?? 0) * 128 + images * 1024;
  if (images > 3 || imageBytes > 2 * 1024 * 1024 || input + request.max_tokens! > model.contextTokens) {
    throw new Error("Request exceeds application admission limits.");
  }
  return { images: images > 0, budget: { inputTokens: input, maxInputTokens: review.maxInputTokens,
    outputTokens: request.max_tokens!, maxOutputTokens: request.max_tokens!, cacheTtl: model.cacheTtls[0] } };
}

export function quoteProviderBudget(modelId: ModelId, budget: TokenBudget, at: string, policy: ContractPolicy = PROVIDER_BOUND_POLICY, pricingPolicyVersion: PricingPolicyVersion = CURRENT_PRICING_POLICY) {
  const review = providerBoundReview(modelId, policy);
  if (budget.maxInputTokens !== review.maxInputTokens || budget.maxOutputTokens > review.maxOutputTokens) throw new Error("Unreviewed request bound.");
  return quoteNativeModel(modelId, budget, { at, pricingPolicyVersion });
}
