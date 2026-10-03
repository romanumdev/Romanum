import test from "node:test";
import assert from "node:assert/strict";
import { assertSelectionReady, ModelSelectionError, persistedAssistantModel, resolveAssistantModel, revalidateAssistantModel } from "../src/lib/assistant/model-selection.ts";
import { RELEASED_EXECUTION_REVIEWS } from "../src/lib/models/readiness.ts";
import { providerRequestBudget, quoteProviderBudget } from "../src/lib/models/providers/request-bounds.ts";

const environment = { DEEPSEEK_API_KEY: "fixture-only", OPENAI_API_KEY: "fixture-only", ANTHROPIC_API_KEY: "fixture-only" };
const at = "2026-10-02T12:00:00.000Z";
const nativeIds = ["deepseek-v4-pro", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
const request = model => ({ model, messages: [{ role: "system", content: "Fixture instructions" }, { role: "user", content: "Fixture question" }], max_tokens: 16_000 });
const reviews = ids => ({ ...RELEASED_EXECUTION_REVIEWS, ...Object.fromEntries(ids.map(id => [id, { adapterSupported: true, executionEnabled: true }])) });
const disabledReviews = { ...RELEASED_EXECUTION_REVIEWS, ...Object.fromEntries(nativeIds.map(id => [id, { adapterSupported: true, executionEnabled: false }])) };
const resolve = (selection, enabled = reviews(nativeIds)) => resolveAssistantModel(selection, request("deepseek-flash"), Number.MAX_SAFE_INTEGER, environment, at, enabled);

test("strict server routing accepts each reviewed native adapter with its own quote and obeys disabled reviews", () => {
  for (const modelId of nativeIds) {
    const selection = { mode: "explicit", modelId };
    assert.throws(() => assertSelectionReady(selection, environment, disabledReviews), /unavailable/);
    assert.throws(() => resolveAssistantModel(selection, request(modelId), Number.MAX_SAFE_INTEGER, environment, at, disabledReviews), /unavailable/);
    const enabled = reviews([modelId]);
    assertSelectionReady(selection, environment, enabled);
    const route = resolve(selection, enabled);
    assert.equal(route.modelDecision.modelId, modelId);
    assert.deepEqual(route.modelDecision.quote, quoteProviderBudget(modelId, providerRequestBudget(request(modelId), modelId).budget, at));
    assert.deepEqual(persistedAssistantModel(route), route);
    revalidateAssistantModel(route, request(modelId), environment, enabled);
    assert.throws(() => revalidateAssistantModel(route, request(modelId), environment, disabledReviews), /unavailable/);
    assert.throws(() => revalidateAssistantModel(route, request(modelId), {}, enabled), /unavailable/);
    assert.ok(Object.isFrozen(route) && Object.isFrozen(route.modelDecision) && Object.isFrozen(route.modelDecision.quote));
  }
});

test("Auto compares per-provider quotes and pins the chosen ID across readiness and request changes", () => {
  const enabled = reviews(nativeIds), route = resolve({ mode: "auto" }, enabled);
  const candidates = ["deepseek-flash", ...nativeIds].map(modelId => resolve({ mode: "explicit", modelId }, enabled).modelDecision);
  candidates.sort((a, b) => a.quote.estimatedPriceNanoUsd - b.quote.estimatedPriceNanoUsd ||
    a.quote.reservationPriceNanoUsd - b.quote.reservationPriceNanoUsd || a.modelId.localeCompare(b.modelId));
  assert.equal(route.modelDecision.modelId, candidates[0].modelId);
  assert.deepEqual(route.modelSelection, { mode: "auto" });
  assert.equal(route.modelDecision.reason, "auto_affordable");
  const modelId = route.modelDecision.modelId;
  revalidateAssistantModel(route, request(modelId), environment, enabled);
  assert.throws(() => revalidateAssistantModel(route, request(modelId), environment, { ...enabled, [modelId]: { adapterSupported: true, executionEnabled: false } }), /unavailable/);
  const different = nativeIds.find(id => id !== modelId);
  assert.throws(() => revalidateAssistantModel(route, request(different), environment, enabled), /unavailable/);
  assert.equal(route.modelDecision.modelId, modelId);
  assert.throws(() => assertSelectionReady({ mode: "auto" }, {}, enabled), /isn't connected/);
});

test("persisted pins reject forged prices, unknown models, extra quote data and mutable references", () => {
  const route = resolve({ mode: "explicit", modelId: "gpt-6.1-sol" });
  const mutateQuote = patch => ({ ...route, modelDecision: { ...route.modelDecision, quote: { ...route.modelDecision.quote, ...patch } } });
  for (const payload of [
    mutateQuote({ rateCardVersion: "forged" }), mutateQuote({ modelId: "gpt-6-luna" }),
    mutateQuote({ reservationPriceNanoUsd: 0 }), mutateQuote({ reservationCredits: 2 }),
    mutateQuote({ estimatedCostNanoUsd: -1 }), mutateQuote({ estimatedCostNanoUsd: 1.5 }),
    mutateQuote({ estimatedPriceNanoUsd: 0 }), mutateQuote({ estimatedCredits: NaN }),
    mutateQuote({ minimumReservationCredits: 0 }), mutateQuote({ cacheHitGuaranteed: true }),
    mutateQuote({ estimateBasis: "uncached", estimatedCacheReadTokens: 1 }), mutateQuote({ browserConfigured: true }),
    { ...route, modelDecision: { ...route.modelDecision, modelId: "invented" } },
    { ...route, modelDecision: { ...route.modelDecision, reason: "auto_affordable" } },
    { ...route, modelDecision: { ...route.modelDecision, fallback: { modelId: "gpt-6-luna" } } },
    { ...route, modelDecision: { ...route.modelDecision, browserReady: true } },
    { ...route, modelSelection: { mode: "explicit", modelId: "gpt-6-luna" } },
    { ...route, legacy: true }, { ...route, modelResolvedAt: "2026-02-30T12:00:00.000Z" },
  ]) assert.throws(() => persistedAssistantModel(payload), ModelSelectionError);
  const payload = JSON.parse(JSON.stringify(route)), restored = persistedAssistantModel(payload);
  payload.modelDecision.modelId = "gpt-6-luna";
  payload.modelDecision.quote.reservationCredits = 0;
  assert.equal(restored.modelDecision.modelId, "gpt-6.1-sol");
  assert.equal(restored.modelDecision.quote.reservationCredits, route.modelDecision.quote.reservationCredits);
  const getterQuote = { ...route.modelDecision.quote };
  Object.defineProperty(getterQuote, "reservationCredits", { enumerable: true, get: () => { throw new Error("Getter must not execute"); } });
  assert.throws(() => persistedAssistantModel({ ...route, modelDecision: { ...route.modelDecision, quote: getterQuote } }), ModelSelectionError);
});

test("legacy omitted payload stays DeepSeek and cannot execute a native request", () => {
  const legacy = persistedAssistantModel({});
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.modelSelection.modelId, "deepseek-flash");
  revalidateAssistantModel(legacy, request("deepseek-flash"), environment);
  assert.throws(() => revalidateAssistantModel(legacy, request("gpt-6-luna"), environment, reviews(nativeIds)), /unavailable/);
});
