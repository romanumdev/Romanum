import type { ModelDefinition, ModelId, TokenRates } from "./types.ts";

/** A new, isolated rate card. Does not replace credits/pricing.ts or reprice stored usage. */
export const RATE_CARD_VERSION = "2026-10-02.standard.v1";
export const RATE_CARD_CHECKED_AT = "2026-10-02T12:05:51.000Z";
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const OPENAI_CACHING = "https://developers.openai.com/api/docs/guides/prompt-caching";
const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_MODELS = "https://platform.claude.com/docs/en/models/overview";
const ANTHROPIC_CACHING = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching";
const DEEPSEEK_PRICING = "https://api-docs.deepseek.com/quick_start/pricing/";
const DEEPSEEK_CACHING = "https://api-docs.deepseek.com/guides/kv_cache/";
const common = {
  // Deliberately bounded below vendor limits for this foundation. Integrations must include framing/images.
  contextTokens: 200_000, maxOutputTokens: 16_000,
  rateCardVersion: RATE_CARD_VERSION, checkedAt: RATE_CARD_CHECKED_AT,
};
const visionTools = { text: true, tools: true, images: true };
const longContext = { overInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 };
function openai(id: ModelId, label: string, rates: TokenRates, notes: string[] = []): ModelDefinition {
  return { ...common, id, label, provider: "openai", capabilities: { ...visionTools }, rates,
    cacheTtls: ["30m"], longContext: { ...longContext },
    sources: { model: `https://developers.openai.com/api/docs/models/${id}`, pricing: OPENAI_PRICING, caching: OPENAI_CACHING }, notes };
}
function anthropic(id: ModelId, label: string, rates: TokenRates): ModelDefinition {
  return { ...common, id, label, provider: "anthropic", capabilities: { ...visionTools }, rates,
    cacheTtls: ["5m", "1h"], sources: { model: ANTHROPIC_MODELS, pricing: ANTHROPIC_PRICING, caching: ANTHROPIC_CACHING },
    notes: ["Native Messages adapter and billing review required. Standard global inference only."] };
}
const models: ModelDefinition[] = [
  { ...common, id: "deepseek-flash", label: "DeepSeek Flash", provider: "deepseek", capabilities: { ...visionTools },
    rates: { input: 0.3, cacheRead: 0.006, output: 1.2 }, offPeakRates: { input: 0.15, cacheRead: 0.003, output: 0.6 },
    cacheTtls: ["automatic"], sources: { model: DEEPSEEK_PRICING, pricing: DEEPSEEK_PRICING, caching: DEEPSEEK_CACHING },
    notes: ["Existing assistant adapter. Peak ceiling covers pricing-boundary crossings; Chinese holidays are conservatively treated as weekdays."] },
  { ...common, id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", capabilities: { ...visionTools, images: false },
    rates: { input: 1.32, cacheRead: 0.044, output: 3.96 }, offPeakRates: { input: 0.66, cacheRead: 0.022, output: 1.98 },
    cacheTtls: ["automatic"], sources: { model: DEEPSEEK_PRICING, pricing: DEEPSEEK_PRICING, caching: DEEPSEEK_CACHING },
    notes: ["V4-Pro-0813 remains available (official docs verified 2026-10-03). Text/tools only; no vision. Separate Chat Completions adapter; release execution gate required."] },
  openai("gpt-6-luna", "GPT-6 Luna", { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
    ["Responses supports tools; Chat Completions function calling requires reasoning_effort=none."]),
  openai("gpt-6.1-sol", "GPT-6.1 Sol", { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 }),
  openai("gpt-6-astra", "GPT-6 Astra", { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 }),
  anthropic("claude-haiku-4-5-20251001", "Claude Haiku 4.5", { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 }),
  anthropic("claude-sonnet-5-5", "Claude Sonnet 5.5", { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 }),
  anthropic("claude-opus-5-5", "Claude Opus 5.5", { input: 4, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, output: 20 }),
  anthropic("claude-fable-5-1", "Claude Fable 5.1", { input: 10, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 }),
];
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const MODEL_CATALOG: readonly ModelDefinition[] = freeze(models);
export function getModel(id: unknown): ModelDefinition | null {
  return typeof id === "string" ? MODEL_CATALOG.find((model) => model.id === id) ?? null : null;
}

/** Same conservative weekday convention as the current rate card; no holiday service. */
export function isDeepSeekPeak(at: string): boolean {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid pricing time.");
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return date.getUTCDay() > 0 && date.getUTCDay() < 6 &&
    ((minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600));
}
export function ratesAt(model: ModelDefinition, at: string): TokenRates {
  if (!Number.isFinite(Date.parse(at))) throw new Error("Invalid pricing time.");
  return model.offPeakRates && !isDeepSeekPeak(at) ? model.offPeakRates : model.rates;
}
