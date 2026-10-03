import type { ModelId } from "../types.ts";

/** Billing ceilings for one native, stateless sample; independent of Romanum's 200k admission limit.
 * Verified 2026-10-03 against the individual official model pages and context-window guides.
 * Input may fill the entire window; subtracting the requested output would under-reserve.
 */
export const NATIVE_BOUND_STRATEGY = "native-context-window";
export const NATIVE_BOUND_VERSION = "2026-10-03.v1";
export const NATIVE_INPUT_CAPACITY: Readonly<Partial<Record<ModelId, number>>> = Object.freeze({
  "deepseek-v4-pro": 1_000_000,
  "gpt-6-luna": 1_050_000, "gpt-6.1-sol": 1_050_000, "gpt-6-astra": 1_050_000,
  "claude-haiku-4-5-20251001": 200_000, "claude-sonnet-5-5": 1_000_000,
  "claude-opus-5-5": 1_000_000, "claude-fable-5-1": 1_000_000,
});
