import type OpenAI from "openai";
import { quoteAssistantCall } from "./billing.ts";
import { reservationCredits } from "../models/estimate.ts";
import { CURRENT_PRICING_POLICY, type PricingPolicyVersion } from "../credits/pricing-policy.ts";

type Request = OpenAI.Chat.ChatCompletionCreateParamsStreaming;
export const FINAL_ANSWER_INSTRUCTION = "Finish the answer now using the evidence already retrieved. State any missing or unchecked areas. No more tools are available this turn.";
const MIN_FINAL_TOKENS = 1024;
const MAX_FINAL_TOKENS = 4096;

/** Same evidence and instructions; omit tool schemas and stop further research. */
export function finalAnswerRequest(request: Request): Request {
  const rest = { ...request };
  delete rest.tools;
  return { ...rest, messages: request.messages.some(message => message.role === "system" && message.content === FINAL_ANSWER_INSTRUCTION)
    ? request.messages : [...request.messages, { role: "system", content: FINAL_ANSWER_INSTRUCTION }] };
}

export function requestFitsCredits(request: Request, availableCredits: number, policy: PricingPolicyVersion = CURRENT_PRICING_POLICY): boolean {
  return reservationCredits(quoteAssistantCall(request, policy)) <= availableCredits;
}

/** A bounded final response, still covered by the peak uncached quote and carry headroom.
 * This is a proposal; the existing atomic reservation remains the spending authority.
 */
export function fundedFinalAnswer(request: Request, availableCredits: number, policy: PricingPolicyVersion = CURRENT_PRICING_POLICY): Request | null {
  if (!Number.isSafeInteger(availableCredits) || availableCredits < 2) return null;
  const final = finalAnswerRequest(request);
  let low = MIN_FINAL_TOKENS, high = Math.min(MAX_FINAL_TOKENS, request.max_tokens ?? MAX_FINAL_TOKENS);
  if (high < low || !requestFitsCredits({ ...final, max_tokens: low }, availableCredits, policy)) return null;
  // Largest affordable reviewed output cap; no assumptions about cache hits or future usage.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (requestFitsCredits({ ...final, max_tokens: middle }, availableCredits, policy)) low = middle;
    else high = middle - 1;
  }
  return { ...final, max_tokens: low };
}
