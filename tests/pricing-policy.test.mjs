import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CURRENT_PRICING_POLICY as CURRENT, LEGACY_PRICING_POLICY as LEGACY, markedUpPrice, quotePricingPolicy, tokenCost } from "../src/lib/credits/pricing-policy.ts";
import { pricingHoldId, holdPricingPolicy } from "../src/lib/credits/hold-policy.ts";
import { grantCredits, getBalance } from "../src/lib/credits/ledger.ts";
import { reserveUsage, settleUsage, finishUnreportedUsage } from "../src/lib/credits/usage-holds.ts";
import { reserveToolUsage, finishToolUsage } from "../src/lib/credits/tool-usage.ts";
import { NANO_USD_PER_CREDIT, priceCalls } from "../src/lib/credits/pricing.ts";
import { quoteModel } from "../src/lib/models/estimate.ts";
import { MODEL_CATALOG, ratesAt } from "../src/lib/models/catalog.ts";
import { costUsage, normalizeUsage } from "../src/lib/models/usage.ts";
import { createAccountingContract } from "../src/lib/models/execution-accounting/decision.ts";
import { readModelReadiness } from "../src/lib/models/readiness.ts";

const AT = "2026-10-02T07:00:00.000Z";
const call = { model: "deepseek-flash", at: new Date(AT), input: 10_000, cachedInput: 20_000, output: 500 };

test("2.5x prices once, keeps the credit unit, and rejects unknown or unsafe prices", () => {
  assert.equal(NANO_USD_PER_CREDIT, 10_000_000);
  assert.deepEqual(priceCalls([call]), { cost: 3_720_000, price: 9_300_000 });
  assert.deepEqual(priceCalls([call], LEGACY), { cost: 3_720_000, price: 6_138_000 });
  assert.equal(markedUpPrice(1), 3);
  assert.equal(markedUpPrice(2), 5);
  assert.equal(markedUpPrice(0), 0);
  assert.equal(tokenCost([{ tokens: 1, rate: 0.003 }, { tokens: 1, rate: 0.006 }]), 9);
  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => markedUpPrice(value));
  assert.throws(() => markedUpPrice(10, "unapproved-policy"));
  assert.throws(() => quotePricingPolicy({ pricingPolicyVersion: "unapproved-policy" }));
  assert.equal(quotePricingPolicy({}), LEGACY);
});

test("new holds carry their durable policy in a PostgreSQL-compatible UUID, old UUIDv4 holds stay legacy", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = pricingHoldId(); ids.add(id);
    assert.match(id, /^2502[0-9a-f]{4}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(holdPricingPolicy(id), CURRENT);
    assert.equal(holdPricingPolicy(pricingHoldId(LEGACY)), LEGACY);
  }
  assert.equal(ids.size, 1000);
  assert.throws(() => pricingHoldId("unknown"));
  assert.throws(() => holdPricingPolicy("00000000-0000-8000-8000-000000000001"));
});

test("the actual pre-change quote and accounting snapshots retain every historical fingerprint", async () => {
  const saved = JSON.parse(await readFile("tests/fixtures/legacy-pricing-v1.json", "utf8"));
  const contract = createAccountingContract(saved.policy);
  assert.deepEqual(contract.prepare(saved.input), saved.prepared);
  assert.deepEqual(contract.validateState(saved.submitted), saved.submitted);
  assert.deepEqual(contract.decide(saved.submitted, saved.outcome, { expectedRevision: saved.submitted.revision }), saved.candidate);
  assert.deepEqual(contract.validateState(saved.candidate), saved.candidate);
  const old = quoteModel(saved.input.modelId, saved.input.bounds.budget, { at: saved.input.preparedAt, pricingPolicyVersion: LEGACY });
  assert.deepEqual(old, saved.input.quote);
  const current = quoteModel(saved.input.modelId, saved.input.bounds.budget, { at: saved.input.preparedAt });
  assert.equal(current.pricingPolicyVersion, CURRENT);
  assert.equal(current.reservationPriceNanoUsd, 2.5 * old.reservationPriceNanoUsd / 1.65);
  const forged = structuredClone(saved.input); forged.quote.pricingPolicyVersion = CURRENT;
  assert.throws(() => contract.prepare(forged));
});

test("current normalized pricing matches an independent integer oracle across cache splits and long-context thresholds", () => {
  let checked = 0;
  for (const model of MODEL_CATALOG) for (const at of [AT, "2026-10-03T12:00:00.000Z"]) {
    const rates = ratesAt(model, at);
    for (const input of [0, 1, 7, 31, 1000, 272000, 272001]) {
      for (const read of [...new Set([0, Math.floor(input / 3), input])]) {
        for (const category of ["inputMissTokens", ...["cacheWriteTokens", "cacheWrite5mTokens", "cacheWrite1hTokens"].filter(key => rates[{ cacheWriteTokens: "cacheWrite", cacheWrite5mTokens: "cacheWrite5m", cacheWrite1hTokens: "cacheWrite1h" }[key]] !== undefined)]) {
          const u = { provider: model.provider, modelId: model.id, at, rateCardVersion: model.rateCardVersion,
            inputMissTokens: 0, cacheReadTokens: read, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
            totalInputTokens: input, outputTokens: 17, [category]: input - read };
          const long = model.longContext && input > model.longContext.overInputTokens ? model.longContext : null;
          const units = rate => BigInt(Math.round(rate * 1000));
          const inputCost = BigInt(u.inputMissTokens) * units(rates.input) + BigInt(read) * units(rates.cacheRead)
            + BigInt(u.cacheWriteTokens) * units(rates.cacheWrite ?? 0) + BigInt(u.cacheWrite5mTokens) * units(rates.cacheWrite5m ?? 0)
            + BigInt(u.cacheWrite1hTokens) * units(rates.cacheWrite1h ?? 0);
          const hundredths = inputCost * BigInt(Math.round((long?.inputMultiplier ?? 1) * 100))
            + BigInt(u.outputTokens) * units(rates.output) * BigInt(Math.round((long?.outputMultiplier ?? 1) * 100));
          const expected = Number((hundredths + BigInt(99)) / BigInt(100));
          assert.equal(costUsage(u), expected, `${model.id} ${at} ${input} ${read} ${category}`);
          assert.equal(markedUpPrice(expected), Number((BigInt(expected) * BigInt(5) + BigInt(1)) / BigInt(2)));
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 700);
});

test("old holds settle at 1.65x alongside 2.5x holds and flat tools without migration 023, double charges or repriced carry", async t => {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: text => client.exec(text) });
  const db = { ...sql(engine), transaction: fn => engine.transaction(client => fn(sql(client))), close: () => engine.close() };
  for (const file of ["002_credits.sql", "010_usage.sql", "014_usage_holds.sql", "018_tool_usage.sql"]) await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
  assert.equal((await db.query("SELECT to_regclass('provider_attempts') AS name")).rows[0].name, null);
  const ownerId = "pricing-release-owner";
  await grantCredits(db, { ownerId, amount: 20, operationId: "grant" });
  const old = await reserveUsage(db, { ownerId, feature: "chat", maxPriceNanoUsd: 6_138_000, pricingPolicyVersion: LEGACY });
  const fresh = await reserveUsage(db, { ownerId, feature: "chat", maxPriceNanoUsd: 9_300_000 });
  await finishUnreportedUsage(db, { ownerId, id: old.id, uncertain: true });
  assert.deepEqual(await settleUsage(db, { ownerId, id: old.id, call }), { credits: 0.6138, charged: 0 });
  assert.deepEqual(await settleUsage(db, { ownerId, id: fresh.id, call }), { credits: 0.93, charged: 1 });
  const lookup = await reserveToolUsage(db, { ownerId, feature: "chat", tool: "load_skill" });
  assert.equal(await finishToolUsage(db, { ownerId, id: lookup, success: true }), 0.06);
  const rows = (await db.query("SELECT calls,price_nano_usd FROM usage_charges ORDER BY created_at,id")).rows;
  assert.deepEqual(rows.map(row => Number(row.price_nano_usd)).sort((a,b) => a-b), [600_000, 6_138_000, 9_300_000]);
  assert.deepEqual(rows.flatMap(row => row.calls).map(row => row.pricingPolicyVersion).sort(), [CURRENT, LEGACY].sort());
  const snapshots = JSON.stringify(rows);
  await settleUsage(db, { ownerId, id: old.id, call });
  await settleUsage(db, { ownerId, id: fresh.id, call });
  await finishToolUsage(db, { ownerId, id: lookup, success: true });
  assert.equal(JSON.stringify((await db.query("SELECT calls,price_nano_usd FROM usage_charges ORDER BY created_at,id")).rows), snapshots);
  assert.equal(Number((await db.query("SELECT carry_nano_usd FROM usage_carry WHERE owner_id=$1", [ownerId])).rows[0].carry_nano_usd), 6_038_000);
  assert.deepEqual(await getBalance(db, { ownerId }), { ownerId, balance: 19, reserved: 0, available: 19 });
  const cancelled = await reserveUsage(db, { ownerId, feature: "ask", maxPriceNanoUsd: 9_300_000 });
  await finishUnreportedUsage(db, { ownerId, id: cancelled.id, uncertain: false });
  await assert.rejects(settleUsage(db, { ownerId, id: cancelled.id, call }), { code: "invalid_operation" });
  const uncertain = await reserveUsage(db, { ownerId, feature: "ask", maxPriceNanoUsd: 9_300_000 });
  await finishUnreportedUsage(db, { ownerId, id: uncertain.id, uncertain: true });
  await finishUnreportedUsage(db, { ownerId, id: uncertain.id, uncertain: false });
  await assert.rejects(settleUsage(db, { ownerId, id: uncertain.id, call: { ...call, input: 20_000 } }), { code: "conflict" });
  assert.equal((await getBalance(db, { ownerId })).reserved, 2);
  await settleUsage(db, { ownerId, id: uncertain.id, call });
  assert.equal((await getBalance(db, { ownerId })).reserved, 0);
  const readiness = readModelReadiness({ DEEPSEEK_API_KEY: "fixture", OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture" },
    { "deepseek-flash": { adapterSupported: true, executionEnabled: true } });
  assert.deepEqual(readiness.filter(model => model.executionEnabled).map(model => model.modelId), ["deepseek-flash"]);
  assert.equal(normalizeUsage("deepseek-flash", { prompt_tokens: 1, completion_tokens: 1 }, { at: AT }).modelId, "deepseek-flash");
});
