// node:process keeps this implementation on the server; the client imports types.ts only.
import { env } from "node:process";
import { MODEL_CATALOG, RATE_CARD_VERSION } from "./catalog.ts";
import { NANO_USD_PER_CREDIT } from "../credits/pricing.ts";
import { CURRENT_PRICING_POLICY, LEGACY_PRICING_POLICY, markedUpPrice, tokenCost } from "../credits/pricing-policy.ts";
import type { ExecutionReviews, ModelReadiness, ModelsResponse, ProviderId } from "./types.ts";

const keyNames: Record<ProviderId, string> = {
  deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
};
/** Reviewed release choices. Environment flags cannot activate an unsupported adapter. */
export const RELEASED_EXECUTION_REVIEWS: Readonly<ExecutionReviews> = Object.freeze({
  "deepseek-flash": Object.freeze({ adapterSupported: true, executionEnabled: true }),
  "deepseek-v4-pro": Object.freeze({ adapterSupported: true, executionEnabled: false }),
  "gpt-6-luna": Object.freeze({ adapterSupported: true, executionEnabled: true }),
  "gpt-6.1-sol": Object.freeze({ adapterSupported: true, executionEnabled: true }),
  "gpt-6-astra": Object.freeze({ adapterSupported: true, executionEnabled: true }),
  "claude-haiku-4-5-20251001": Object.freeze({ adapterSupported: true, executionEnabled: true }),
  "claude-sonnet-5-5": Object.freeze({ adapterSupported: true, executionEnabled: true }),
  "claude-opus-5-5": Object.freeze({ adapterSupported: true, executionEnabled: true }),
  "claude-fable-5-1": Object.freeze({ adapterSupported: true, executionEnabled: true }),
});
type ServerEnvironment = Readonly<Record<string, string | undefined>>;
function serverOnly() {
  if (typeof window !== "undefined") throw new Error("Model readiness is server-only.");
}

/** Check per invocation, not at import time. Presence is not authentication or entitlement. */
export function readModelReadiness(
  environment: ServerEnvironment = env,
  reviews: Readonly<ExecutionReviews> = RELEASED_EXECUTION_REVIEWS,
): ModelReadiness[] {
  serverOnly();
  return MODEL_CATALOG.map((model) => {
    const configured = typeof environment[keyNames[model.provider]] === "string" &&
      environment[keyNames[model.provider]]!.trim().length > 0;
    const adapterSupported = reviews[model.id]?.adapterSupported === true;
    const executionEnabled = reviews[model.id]?.executionEnabled === true;
    const selectable = configured && adapterSupported && executionEnabled;
    return {
      modelId: model.id, configured, adapterSupported, executionEnabled, selectable, entitlementVerified: false,
      reason: !configured ? "missing_key" : !adapterSupported ? "adapter_not_supported" : !executionEnabled ? "execution_disabled" : "ready",
    };
  });
}

/** Public allowlist: never spread environment, review objects, exceptions, or a provider client. */
export function publicModels(environment: ServerEnvironment = env, reviews: Readonly<ExecutionReviews> = RELEASED_EXECUTION_REVIEWS): ModelsResponse {
  serverOnly();
  const readiness = readModelReadiness(environment, reviews);
  return { rateCardVersion: RATE_CARD_VERSION, models: MODEL_CATALOG.map((model, i) => ({
    ...model, ...readiness[i],
    creditRateCards: ([CURRENT_PRICING_POLICY, LEGACY_PRICING_POLICY] as const).map(pricingPolicyVersion => {
      const credits = (rate: number) => markedUpPrice(tokenCost([{ tokens: 1_000_000, rate }]), pricingPolicyVersion) / NANO_USD_PER_CREDIT;
      return { rateCardVersion: model.rateCardVersion, pricingPolicyVersion, unit: "credits_per_million_tokens" as const,
        rates: { input: credits(model.rates.input), output: credits(model.rates.output), cacheRead: credits(model.rates.cacheRead) } };
    }),
  })) };
}
