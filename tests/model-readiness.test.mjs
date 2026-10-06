import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG, RATE_CARD_CHECKED_AT, RATE_CARD_VERSION, getModel } from "../src/lib/models/catalog.ts";
import { MODEL_IDS } from "../src/lib/models/types.ts";
import { hasReadyModel, publicModels, readModelReadiness, RELEASED_EXECUTION_REVIEWS } from "../src/lib/models/readiness.ts";

const environment = () => ({ DEEPSEEK_API_KEY: "fixture-deepseek", OPENAI_API_KEY: "fixture-openai", ANTHROPIC_API_KEY: "fixture-anthropic" });
test("catalog IDs, standard prices and provenance are explicit and immutable", () => {
  assert.deepEqual(MODEL_CATALOG.map((model) => model.id), [...MODEL_IDS]);
  assert.equal(getModel("claude-haiku-4-5-20251001").rates.cacheWrite1h, 2);
  assert.equal(getModel("gpt-6.1-sol").rates.cacheRead, 0.1);
  assert.equal(getModel("deepseek-v4-pro").capabilities.images, false);
  assert.equal(getModel("invented-frontier-model"), null);
  assert.equal(getModel({ toString: () => "gpt-6-astra" }), null);
  for (const model of MODEL_CATALOG) {
    assert.equal(model.rateCardVersion, RATE_CARD_VERSION);
    assert.equal(model.checkedAt, RATE_CARD_CHECKED_AT);
    for (const source of Object.values(model.sources)) assert.match(source, /^https:\/\//);
    assert.ok(Object.isFrozen(model) && Object.isFrozen(model.rates) && Object.isFrozen(model.capabilities));
  }
  assert.throws(() => { getModel("gpt-6.1-sol").rates.input = 0; }, TypeError);
});

test("reviewed release enables all supported native adapters including Pro", () => {
  const missing = readModelReadiness({});
  assert.ok(missing.every((model) => !model.configured && !model.selectable && model.reason === "missing_key"));
  const configured = readModelReadiness({ ...environment(), OPENAI_EXECUTION_ENABLED: "true", ANTHROPIC_EXECUTION_ENABLED: "true", MODEL_EXECUTION_ENABLED: "true" });
  const flash = configured.find((model) => model.modelId === "deepseek-flash");
  assert.equal(flash.selectable, true);
  assert.equal(flash.entitlementVerified, false);
  for (const model of configured.filter((model) => model.modelId !== "deepseek-flash")) {
    assert.equal(model.configured, true);
    assert.equal(model.adapterSupported, true);
    assert.equal(model.executionEnabled, true);
    assert.equal(model.selectable, true);
    assert.equal(model.reason, "ready");
    assert.equal(model.entitlementVerified, false);
  }
  const supported = readModelReadiness(environment(), { "gpt-6.1-sol": { adapterSupported: true, executionEnabled: false } });
  assert.equal(supported.find((model) => model.modelId === "gpt-6.1-sol").reason, "execution_disabled");
  assert.equal(readModelReadiness({ DEEPSEEK_API_KEY: "   " })[0].reason, "missing_key");
  assert.ok(Object.isFrozen(RELEASED_EXECUTION_REVIEWS));
  assert.ok(Object.values(RELEASED_EXECUTION_REVIEWS).every(Object.isFrozen));
  assert.throws(() => { RELEASED_EXECUTION_REVIEWS["gpt-6-luna"].executionEnabled = false; }, TypeError);
});

test("server-injected reviews enable only their exact configured model", () => {
  const reviews = { "gpt-6.1-sol": { adapterSupported: true, executionEnabled: true } };
  const ready = readModelReadiness(environment(), reviews);
  assert.deepEqual(ready.filter(model => model.selectable).map(model => model.modelId), ["gpt-6.1-sol"]);
  assert.equal(readModelReadiness({}, reviews).find(model => model.modelId === "gpt-6.1-sol").reason, "missing_key");
  assert.equal(readModelReadiness(environment()).find(model => model.modelId === "gpt-6.1-sol").selectable, true);
});

test("composer readiness accepts each reviewed provider but rejects missing, disabled or unsupported adapters", () => {
  assert.equal(hasReadyModel({}), false);
  assert.equal(hasReadyModel({ DEEPSEEK_API_KEY: " ", OPENAI_API_KEY: "\t", ANTHROPIC_API_KEY: "" }), false);
  for (const key of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const fixture = { [key]: "fixture-only" };
    assert.equal(hasReadyModel(fixture), true, key);
    delete fixture[key];
    assert.equal(hasReadyModel(fixture), false, `${key} removed`);
  }
  assert.equal(hasReadyModel(environment(), {}), false);
  assert.equal(hasReadyModel(environment(), { "gpt-6.1-sol": { adapterSupported: true, executionEnabled: false } }), false);
  assert.equal(hasReadyModel(environment(), { "gpt-6.1-sol": { adapterSupported: false, executionEnabled: true } }), false);
});

test("key removal is observed on the next invocation; public output contains only catalog and safe status", () => {
  const fixture = environment();
  assert.equal(readModelReadiness(fixture)[0].selectable, true);
  delete fixture.DEEPSEEK_API_KEY;
  assert.equal(readModelReadiness(fixture)[0].selectable, false);
  const response = publicModels({ ...environment(), PRIVATE_DIAGNOSTIC: "must-never-leak" });
  const json = JSON.stringify(response);
  for (const forbidden of ["fixture-deepseek", "fixture-openai", "fixture-anthropic", "must-never-leak", "API_KEY", "PRIVATE_DIAGNOSTIC"]) {
    assert.ok(!json.includes(forbidden));
  }
  assert.deepEqual(Object.keys(response).sort(), ["models", "rateCardVersion"]);
  assert.ok(response.models.every((model) => typeof model.configured === "boolean" && typeof model.selectable === "boolean"));
});

test("readiness refuses a browser environment instead of inspecting credentials there", () => {
  globalThis.window = {};
  try { assert.throws(() => publicModels(environment()), /server-only/); }
  finally { delete globalThis.window; }
});
test("public credit rates use customer markup and the unchanged credit unit while provider rates stay USD", () => {
  const response=publicModels(environment());
  for(const [id,expected] of [["gpt-6-luna",{input:25,output:125,cacheRead:2.5}],["gpt-6.1-sol",{input:500,output:2500,cacheRead:25}],["gpt-6-astra",{input:2500,output:12500,cacheRead:250}]]) {
    const model=response.models.find(row=>row.id===id),current=model.creditRateCards.find(card=>card.pricingPolicyVersion==="credit-policy-2p5-v2");
    assert.equal(current.unit,"credits_per_million_tokens");assert.equal(current.rateCardVersion,response.rateCardVersion);assert.deepEqual(current.rates,expected);
  }
  const luna=response.models.find(row=>row.id==="gpt-6-luna");
  assert.deepEqual(luna.rates,MODEL_CATALOG.find(row=>row.id===luna.id).rates);
  assert.deepEqual(luna.creditRateCards.find(card=>card.pricingPolicyVersion==="legacy-credit-policy-v1").rates,{input:16.5,output:82.5,cacheRead:1.65});
});
