import type { AnthropicResult, OpenAIResult, DeepSeekResult } from "../providers/types.ts";
import { canonicalTime, freezeWire } from "../providers/wire.ts";
import type { AttemptOutcome, AttemptState, UsageEvidence } from "./types.ts";

/** Pure handoff for trusted adapter results. No hold, dispatch, settlement, release or retry happens here.
 * The caller must load the authorized, owner-scoped current state and persist the contract's revision CAS.
 * Native continuation, visible output and provider diagnostics never enter accounting evidence. */
export function adapterOutcome(state: AttemptState, result: AnthropicResult | OpenAIResult | DeepSeekResult, observedAt: string): AttemptOutcome {
  if (!canonicalTime(observedAt)) throw new Error("Invalid evidence timestamp.");
  const { prepared, holdId, bindingFingerprint } = state.held;
  const base = { attemptId: prepared.attemptId, holdId, bindingFingerprint, observedAt };
  if (result.status === "failed") {
    const usage: UsageEvidence = result.usage === null ? { kind: "none" } : result.usageComplete ? {
      kind: "unverified_final", usage: { ...result.usage }, reason: result.code === "model_mismatch" ? "identity_mismatch"
        : result.code === "unsupported_capability" ? "pricing_unverified" : "invalid_response",
    } : { kind: "partial", usage: { ...result.usage } };
    return freezeWire({ ...base, submission: result.submission, result: result.code === "cancelled" ? "cancelled" : "failed", usage });
  }
  if (!state.submission) throw new Error("Final adapter evidence requires a saved dispatch claim.");
  const e = result.evidence;
  // Preserve adapter-reported identities; do not silently replace them with the selected model/hash/time.
  const usage: UsageEvidence = e.submittedAt !== result.usage.at || e.providerMessageId !== result.messageId ||
      e.reportedModelId !== result.modelId || e.requestFormatVersion !== prepared.requestFormatVersion
    ? { kind: "unverified_final", usage: { ...result.usage }, reason: "identity_mismatch" }
    : { kind: "final", usage: { ...result.usage }, provenance: {
      source: "adapter_completed", adapterVersion: e.adapterVersion, provider: e.provider,
      providerMessageId: e.providerMessageId, reportedModelId: e.reportedModelId, requestHash: e.requestHash,
      dispatchId: state.submission.dispatchId, rateCardVersion: result.usage.rateCardVersion,
      pricingProfile: e.pricingProfile, terminalEvent: e.terminalEvent, unsupportedCharges: false,
    } };
  return freezeWire({ ...base, submission: "submitted", result: result.truncated ? "truncated"
    : result.stopReason === "refusal" ? "refused" : "completed", usage });
}
