import test from "node:test";
import assert from "node:assert/strict";
import { createAccountingContract } from "../src/lib/models/execution-accounting/decision.ts";
import { costUsage, normalizeUsage } from "../src/lib/models/usage.ts";
import { quoteModel } from "../src/lib/models/estimate.ts";
import { callCost, modelPricing } from "../src/lib/credits/pricing.ts";
import { meteredStream } from "../src/lib/assistant/billing.ts";
import { readModelReadiness } from "../src/lib/models/readiness.ts";
import { createAnthropicAdapter } from "../src/lib/models/providers/anthropic.ts";
import { request, jsonMessage } from "./fixtures/anthropic-provider.mjs";
import { AT, REQUEST_HASH, OTHER_HASH, OPUS, fixture, heldFixture, submittedFixture,
  finalOutcome, anthropicUsage, oneHourUsage, openaiUsage, deepseekUsage,
  legacyMismatchedStream } from "./fixtures/provider-accounting-contract.mjs";

const clone = (value) => structuredClone(value);
const reject = (operation) => assert.throws(operation, error => {
  assert.equal(typeof error.code, "string");
  assert.ok(error.code.length > 0);
  return true;
});
const decide = (f, outcome) => f.contract.decide(f.state, outcome, { expectedRevision: f.state.revision });
const retained = (f, outcome) => {
  const next = decide(f, outcome);
  assert.equal(next.phase, "retained");
  assert.equal(next.uncertain, true);
  return next;
};

test("blocker 1: legacy flattening underprices 1h writes; candidate preserves every TTL counter", () => {
  const usage = oneHourUsage();
  assert.equal(costUsage(usage), 8_000_000);
  assert.equal(callCost({ model: OPUS, at: new Date(AT), input: 0, cachedInput: 0,
    cacheWrite: 1000, output: 0 }), 5_000_000);
  const f = submittedFixture();
  const candidate = decide(f, finalOutcome(f.state, usage));
  assert.equal(candidate.phase, "candidate");
  assert.deepEqual(candidate.decision.candidate.usage, usage);
  assert.equal(candidate.decision.candidate.usage.cacheWriteTokens, 0);
  assert.equal(candidate.decision.candidate.usage.cacheWrite1hTokens, 1000);
  assert.equal(costUsage(candidate.decision.candidate.usage), 8_000_000);
  const mixed = decide(f, finalOutcome(f.state));
  assert.deepEqual(mixed.decision.candidate.usage, anthropicUsage());
  assert.equal(costUsage(mixed.decision.candidate.usage), 4_320_000);
});

test("blocker 2: foundation models missing from legacy billing stay explicit normalized candidates", () => {
  for (const modelId of ["gpt-6-astra", "gpt-6.1-sol", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]) {
    assert.throws(() => modelPricing(modelId), /No price/);
    const f = submittedFixture({ modelId });
    const usage = modelId.startsWith("gpt") ? openaiUsage(modelId)
      : normalizeUsage(modelId, { input_tokens: 100, output_tokens: 100 }, { at: AT });
    const next = decide(f, finalOutcome(f.state, usage));
    assert.equal(next.phase, "candidate");
    assert.equal(next.decision.candidate.usage.modelId, modelId);
    // Eligibility cannot silently become a debit or a legacy CallUsage conversion.
    assert.equal(next.phase === "settled", false);
    assert.equal("creditsCharged" in next.decision.candidate, false);
    assert.equal("call" in next.decision.candidate, false);
  }
});

test("blocker 3: unbound or transplanted holds cannot fund another attempt", () => {
  const f = heldFixture();
  reject(() => f.contract.hold(f.prepared, { holdId: f.hold.holdId, reservedCredits: f.hold.reservedCredits }));
  reject(() => f.contract.hold(f.prepared, { ...f.hold, bindingFingerprint: OTHER_HASH }));
  reject(() => f.contract.hold(f.prepared, { ...f.hold, ownerId: "wrong-owner" }));
  reject(() => f.contract.hold(f.prepared, { ...f.hold, feature: "ask" }));
  // Equal whole-credit amounts do not prove that the stored nano-price ceiling matches.
  reject(() => f.contract.hold(f.prepared, { ...f.hold, maxPriceNanoUsd: f.hold.maxPriceNanoUsd - 1 }));
  const another = f.contract.prepare({ ...f.input, attemptId: "00000000-0000-4000-8000-000000000099" });
  assert.notEqual(another.bindingFingerprint, f.prepared.bindingFingerprint);
  reject(() => f.contract.hold(another, f.hold));
});

test("submission and finalization are single transitions; stale revisions and replayed attempts reject", () => {
  const f = submittedFixture();
  reject(() => f.contract.submit(f.state, { ...f.submission, expectedRevision: f.state.revision }));
  reject(() => f.contract.submit(f.state, f.submission));
  reject(() => f.contract.decide(f.state, finalOutcome(f.state), { expectedRevision: f.state.revision - 1 }));
  const final = decide(f, finalOutcome(f.state));
  reject(() => f.contract.decide(final, finalOutcome(f.state), { expectedRevision: final.revision }));
  reject(() => f.contract.submit(final, { ...f.submission, expectedRevision: final.revision }));
  const conflicting = finalOutcome(f.state);
  conflicting.usage.usage.outputTokens++;
  reject(() => f.contract.decide(final, conflicting, { expectedRevision: final.revision }));
});

test("stable preparation supports durable unique keys; pure copies do not claim global uniqueness", () => {
  const f = fixture();
  assert.deepEqual(f.contract.prepare(f.input), f.contract.prepare(clone(f.input)));
  const first = f.contract.prepare(f.input);
  // A pure function intentionally has no process-global registry: storage must use unique keys/CAS.
  const separateContract = createAccountingContract(clone(f.policy));
  assert.equal(separateContract.prepare(clone(f.input)).bindingFingerprint, first.bindingFingerprint);
  for (const field of ["ownerId", "conversationId", "runId", "attemptId"]) {
    const changed = { ...f.input, [field]: `different-${field}` };
    assert.notEqual(f.contract.prepare(changed).bindingFingerprint, first.bindingFingerprint);
  }
  for (const field of ["adapterVersion", "requestFormatVersion"]) {
    reject(() => f.contract.prepare({ ...f.input, [field]: `different-${field}` }));
  }
});

test("blocker 4: no default review, arbitrary bound version, reused provider bound or changed request", () => {
  const f = fixture();
  reject(() => createAccountingContract().prepare(f.input));
  const changes = [
    input => { input.bounds.strategyVersion = "unreviewed"; },
    input => { input.bounds.strategyId = "deepseek-only-bound"; },
    input => { input.provider = "deepseek"; },
    input => { input.bounds.requestHash = OTHER_HASH; },
    input => { input.adapterVersion = "other-adapter"; },
    input => { input.requestFormatVersion = "other-wire-format"; },
    input => { input.bounds.capabilities = ["server_tools"]; },
  ];
  for (const change of changes) {
    const input = clone(f.input); change(input);
    reject(() => f.contract.prepare(input));
  }
  const limited = createAccountingContract({ reviewedBounds: [{ ...f.review, capabilities: ["text"] }] });
  const input = clone(f.input); input.bounds.capabilities.push("images");
  reject(() => limited.prepare(input));
  const held = heldFixture();
  reject(() => held.contract.submit(held.state, { expectedRevision: held.state.revision,
    dispatchId: "synthetic-dispatch", requestHash: OTHER_HASH, submittedAt: AT }));
});

test("blocker 5: legacy wrapper misattributes response model; final identity mismatch is retained", async () => {
  const legacy = legacyMismatchedStream();
  for await (const chunk of meteredStream(legacy.client, legacy.params, legacy.billing, new AbortController().signal)) assert.ok(chunk);
  assert.equal(legacy.events.at(-1).call.model, "deepseek-flash");
  const f = submittedFixture({ modelId: "deepseek-flash" });
  const outcome = finalOutcome(f.state, deepseekUsage());
  outcome.usage.provenance.reportedModelId = "gpt-6-astra";
  retained(f, outcome);
});

test("complete normalized input, read/write and output counts cannot double-count reasoning", () => {
  const f = submittedFixture({ modelId: "gpt-6.1-sol" });
  const next = decide(f, finalOutcome(f.state, openaiUsage()));
  const usage = next.decision.candidate.usage;
  assert.equal(usage.inputMissTokens, 100);
  assert.equal(usage.cacheReadTokens, 600);
  assert.equal(usage.cacheWriteTokens, 300);
  assert.equal(usage.outputTokens, 100);
  assert.equal(costUsage(usage), 2_010_000);
});

test("a 5m nano quote cannot authorize 1h cost even when both whole-credit holds equal three", () => {
  const f = submittedFixture({ cacheTtl: "5m", budget: { inputTokens: 1000, maxInputTokens: 1000,
    outputTokens: 1, maxOutputTokens: 1 } });
  assert.equal(f.prepared.quote.reservationPriceNanoUsd, 12_550_000);
  assert.equal(f.prepared.quote.reservationCredits, 3);
  assert.equal(Math.round(costUsage(oneHourUsage()) * 2.5), 20_000_000);
  retained(f, finalOutcome(f.state, oneHourUsage()));
});

test("final usage exceeding input/output bounds cannot settle", () => {
  for (const key of ["totalInputTokens", "outputTokens"]) {
    const f = submittedFixture();
    const outcome = finalOutcome(f.state);
    if (key === "totalInputTokens") {
      outcome.usage.usage.inputMissTokens += 2000;
      outcome.usage.usage.totalInputTokens += 2000;
    } else outcome.usage.usage.outputTokens = 1001;
    retained(f, outcome);
  }
});

test("partial, unverified and absent usage never becomes a settlement candidate", () => {
  for (const usage of [
    { kind: "none" },
    { kind: "partial", usage: anthropicUsage() },
    { kind: "unverified_final", usage: anthropicUsage(), reason: "invalid_response" },
    { kind: "invalid", reason: "invalid_usage", reportHash: OTHER_HASH },
  ]) {
    const f = submittedFixture();
    retained(f, { ...finalOutcome(f.state), result: "failed", submission: "uncertain", usage });
  }
  const f = submittedFixture();
  retained(f, { ...finalOutcome(f.state), result: "failed" });
  reject(() => decide(f, { ...finalOutcome(f.state), usageComplete: true }));
});

test("existing Anthropic usageComplete=true can accompany failure; the contract retains it", async () => {
  let calls = 0;
  const adapter = createAnthropicAdapter({ executionEnabled: true, getApiKey: () => "synthetic-key",
    now: () => AT, fetch: async () => {
      calls++;
      // Complete protocol usage, followed by result-time bound failure.
      return new Response(JSON.stringify(jsonMessage({ usage: { input_tokens: 2001, output_tokens: 10 } })),
        { headers: { "Content-Type": "application/json" } });
    } });
  const result = await adapter.complete(request({ stream: false }));
  assert.equal(calls, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.usageComplete, true);
  assert.equal(result.submission, "uncertain");
  const f = submittedFixture({ modelId: "claude-haiku-4-5-20251001" });
  retained(f, { ...finalOutcome(f.state), result: "failed", submission: "uncertain",
    usage: { kind: "unverified_final", usage: result.usage, reason: "invalid_response" } });
});

test("cancellation before submission releases an unused hold, after submission retains uncertainty", () => {
  const f = heldFixture();
  const unused = { attemptId: f.prepared.attemptId, holdId: f.hold.holdId,
    bindingFingerprint: f.prepared.bindingFingerprint, submission: "not_submitted", result: "cancelled",
    observedAt: AT, usage: { kind: "none" } };
  const released = decide(f, unused);
  assert.equal(released.phase, "released");
  reject(() => f.contract.submit(released, { expectedRevision: released.revision,
    dispatchId: "late-dispatch", requestHash: REQUEST_HASH, submittedAt: AT }));
  const submitted = submittedFixture();
  const uncertain = retained(submitted, { ...unused, submission: "uncertain" });
  const noDowngrade = submitted.contract.decide(uncertain, unused, { expectedRevision: uncertain.revision });
  assert.equal(noDowngrade.phase, "retained");
});

test("retained incomplete evidence can reconcile once with later verified final usage", () => {
  const f = submittedFixture();
  const pending = retained(f, { ...finalOutcome(f.state), result: "cancelled", submission: "uncertain",
    usage: { kind: "partial", usage: anthropicUsage() } });
  const next = f.contract.decide(pending, finalOutcome(f.state), { expectedRevision: pending.revision });
  assert.equal(next.phase, "candidate");
  reject(() => f.contract.decide(next, finalOutcome(f.state), { expectedRevision: next.revision }));
});

test("all final provenance identities must match the held request and dispatch", () => {
  for (const [field, value] of Object.entries({ adapterVersion: "wrong-adapter", provider: "openai",
    reportedModelId: "gpt-6-astra", requestHash: OTHER_HASH, dispatchId: "wrong-dispatch",
    rateCardVersion: "unknown-card" })) {
    const f = submittedFixture();
    const outcome = finalOutcome(f.state); outcome.usage.provenance[field] = value;
    retained(f, outcome);
  }
  for (const field of ["attemptId", "holdId", "bindingFingerprint"]) {
    const f = submittedFixture();
    const outcome = finalOutcome(f.state); outcome[field] = field === "bindingFingerprint" ? OTHER_HASH : "wrong-identity";
    reject(() => decide(f, outcome));
  }
});

test("unreviewed pricing modifiers, usage identities and timestamps retain the reservation", () => {
  const mutations = [
    outcome => { outcome.usage.provenance.pricingProfile = "priority-us"; },
    outcome => { outcome.usage.provenance.unsupportedCharges = true; },
    outcome => { outcome.usage.usage.provider = "openai"; },
    outcome => { outcome.usage.usage.modelId = "claude-sonnet-5-5"; },
    outcome => { outcome.usage.usage.rateCardVersion = "future-card"; },
    outcome => { outcome.usage.usage.at = "2026-10-02T07:01:00.000Z"; },
  ];
  for (const mutate of mutations) {
    const f = submittedFixture(); const outcome = finalOutcome(f.state); mutate(outcome);
    retained(f, outcome);
  }
});

test("synchronous guest Chats retains a stable attempt binding without a background run ID", () => {
  const f = heldFixture({ input: { runId: null } });
  assert.equal(f.prepared.feature, "chat");
  assert.equal(f.prepared.runId, null);
  assert.ok(f.prepared.attemptId && f.prepared.conversationId && f.prepared.bindingFingerprint);
});

test("selection, quote and minimum hold cannot be silently changed", () => {
  const f = fixture();
  reject(() => f.contract.prepare({ ...f.input, selection: { mode: "explicit", modelId: "gpt-6-astra" } }));
  const auto = f.contract.prepare({ ...f.input, selection: { mode: "auto" } });
  assert.equal(auto.selection.mode, "auto");
  assert.equal(auto.modelId, OPUS);
  for (const mutate of [
    value => { value.quote.modelId = "gpt-6-astra"; },
    value => { value.quote.rateCardVersion = "unknown"; },
    value => { value.quote.reservationPriceNanoUsd--; },
    value => { value.quote.reservationCredits = 1; },
    value => { value.quote.minimumReservationCredits = 1; },
    value => { value.quote.cacheHitGuaranteed = true; },
  ]) {
    const changed = clone(f.input); mutate(changed); reject(() => f.contract.prepare(changed));
  }
  const held = heldFixture({ budget: { inputTokens: 1, maxInputTokens: 1, outputTokens: 1, maxOutputTokens: 1 } });
  assert.equal(held.prepared.quote.reservationCredits, 2);
  reject(() => held.contract.hold(held.prepared, { ...held.hold, reservedCredits: 1 }));
});

test("malformed usage cannot produce a candidate or erase the existing submitted state", () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100"]) {
    const f = submittedFixture();
    const outcome = finalOutcome(f.state); outcome.usage.usage.outputTokens = value;
    reject(() => decide(f, outcome));
    assert.equal(f.state.phase, "submitted");
  }
  const f = submittedFixture();
  const outcome = finalOutcome(f.state); outcome.usage.usage.totalInputTokens++;
  assert.equal(retained(f, outcome).decision.reason, "invalid_usage");
});

test("cumulative partial snapshots are replaced by a final total, never added", () => {
  const f = submittedFixture();
  let state = f.state;
  for (const outputTokens of [1, 7]) {
    const outcome = { ...finalOutcome(state), usage: { kind: "partial", usage: { ...anthropicUsage(), outputTokens } } };
    state = f.contract.decide(state, outcome, { expectedRevision: state.revision });
    assert.equal(state.phase, "retained");
  }
  const next = f.contract.decide(state, finalOutcome(state, { ...anthropicUsage(), outputTokens: 10 }), { expectedRevision: state.revision });
  assert.equal(next.phase, "candidate");
  assert.equal(next.decision.candidate.usage.outputTokens, 10);
  const regression = f.contract.decide(state, finalOutcome(state, { ...anthropicUsage(), outputTokens: 6 }), { expectedRevision: state.revision });
  assert.equal(regression.phase, "retained");
  assert.equal(regression.decision.reason, "conflicting_evidence");
  const smallerPartial = f.contract.decide(state, { ...finalOutcome(state),
    usage: { kind: "partial", usage: { ...anthropicUsage(), outputTokens: 6 } } }, { expectedRevision: state.revision });
  assert.equal(smallerPartial.decision.reason, "conflicting_evidence");
  const apparentRecovery = f.contract.decide(smallerPartial, finalOutcome(smallerPartial, { ...anthropicUsage(), outputTokens: 10 }),
    { expectedRevision: smallerPartial.revision });
  assert.equal(apparentRecovery.phase, "retained");
  assert.equal(apparentRecovery.decision.reason, "conflicting_evidence");
});

test("stored phase, revision, hold and derived candidate tampering are detected on reload", () => {
  const f = submittedFixture();
  const candidate = decide(f, finalOutcome(f.state));
  assert.deepEqual(f.contract.validateState(candidate), candidate);
  for (const mutate of [
    value => { value.phase = "held"; },
    value => { value.revision++; },
    value => { value.uncertain = false; },
    value => { value.held.reservedCredits++; },
    value => { value.decision.candidate.usage.outputTokens++; },
    value => { value.decision.candidate.authorizedPriceNanoUsd = 1; },
    value => { value.submission.dispatchId = "other-dispatch"; },
  ]) {
    const changed = clone(candidate); mutate(changed);
    reject(() => f.contract.validateState(changed));
  }
});

test("strict shape validation rejects accessors and extra fields without reading private getters", () => {
  const f = fixture(); let accessed = false;
  const getter = { ...f.input };
  Object.defineProperty(getter, "ownerId", { enumerable: true, get() { accessed = true; return "secret-owner"; } });
  reject(() => f.contract.prepare(getter));
  assert.equal(accessed, false);
  const outcome = finalOutcome(submittedFixture().state);
  outcome.usage.provenance.providerMessageId = "raw provider error with spaces";
  reject(() => decide(submittedFixture(), outcome));
});

test("immutable snapshots and strict DTOs keep private content out of accounting", () => {
  const f = fixture();
  const prepared = f.contract.prepare(f.input);
  f.input.bounds.budget.maxInputTokens = 1;
  f.input.quote.reservationCredits = 999;
  assert.equal(prepared.bounds.budget.maxInputTokens, 2000);
  assert.notEqual(prepared.quote.reservationCredits, 999);
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.bounds.budget));
  assert.throws(() => { prepared.quote.modelId = "gpt-6-astra"; }, TypeError);
  for (const field of ["prompt", "apiKey", "continuation", "privateToolResult"]) {
    const fresh = fixture(); reject(() => fresh.contract.prepare({ ...fresh.input, [field]: "must-not-persist" }));
  }
  const current = submittedFixture();
  const next = decide(current, finalOutcome(current.state));
  assert.ok(Object.isFrozen(next.decision.candidate.usage));
  const forged = clone(current.state); forged.held.prepared.ownerId = "another-owner";
  reject(() => current.contract.validateState(forged));
  assert.ok(!JSON.stringify(next).includes("synthetic-key"));
});

test("review policy is snapshotted; a changed strategy cannot validate an old prepared binding", () => {
  const f = fixture();
  const prepared = f.contract.prepare(f.input);
  f.policy.reviewedBounds[0].maxInputTokens = 1;
  assert.equal(f.contract.validatePrepared(prepared).bindingFingerprint, prepared.bindingFingerprint);
  const changed = createAccountingContract({ reviewedBounds: [{ ...f.review, maxInputTokens: 9000 }] });
  reject(() => changed.validatePrepared(prepared));
});

test("a cache-aware estimate never reduces the independently verified reservation", () => {
  const f = fixture();
  const binding = { ownerId: f.input.ownerId, conversationId: f.input.conversationId,
    provider: "anthropic", modelId: OPUS, prefixHash: REQUEST_HASH, toolSchemaHash: REQUEST_HASH, settingsHash: REQUEST_HASH };
  f.input.quote = quoteModel(OPUS, f.input.bounds.budget, { at: AT, cacheBinding: binding,
    cacheObservations: [{ binding, observedAt: "2026-10-02T06:59:00.000Z",
      expiresAt: "2026-10-02T07:04:00.000Z", cacheReadTokens: 600 }] });
  const prepared = f.contract.prepare(f.input);
  assert.equal(prepared.quote.estimateBasis, "compatible_cache_scenario");
  assert.equal(prepared.quote.reservationPriceNanoUsd, fixture().input.quote.reservationPriceNanoUsd);
});

test("module and synthetic review policy do not make frontier models executable", () => {
  submittedFixture();
  const readiness = readModelReadiness({ OPENAI_API_KEY: "synthetic", ANTHROPIC_API_KEY: "synthetic" }, {});
  assert.ok(readiness.filter(model => !model.modelId.startsWith("deepseek")).every(model => !model.executionEnabled && !model.selectable));
});
