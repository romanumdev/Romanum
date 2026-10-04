import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { providerAccountingAvailable, runtimeExecutionReviews } from "../src/lib/models/provider-schema.ts";
import { publicModels } from "../src/lib/models/readiness.ts";
import { grantCredits, getBalance, reserveCredits } from "../src/lib/credits/ledger.ts";
import { applyNativeProviderPrerequisite, checkReleaseEnvironment } from "../scripts/native-provider-release.mjs";

const environment = { DEEPSEEK_API_KEY: "fixture", OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture" };
const sql = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
test("missing or inaccessible provider accounting disables native choices while preserving Flash", async () => {
  for (const database of [null, { query: async () => { throw Error("private driver error"); } }, { query: async () => ({ rows: [{ ready: false }] }) }]) {
    assert.equal(await providerAccountingAvailable(database), false);
    const models = publicModels(environment, await runtimeExecutionReviews(database)).models;
    assert.deepEqual(models.filter(model => model.selectable).map(model => model.id), ["deepseek-flash"]);
    assert.ok(!JSON.stringify(models).includes("private driver error"));
  }
  const models = publicModels(environment, await runtimeExecutionReviews({ query: async () => ({ rows: [{ ready: true }] }) })).models;
  assert.equal(models.filter(model => model.selectable).length, 9);
  assert.equal(models.find(model => model.id === "deepseek-v4-pro").selectable, true);
});

test("release environment rejects an unintended context, commit or target before database access", () => {
  const release = "a".repeat(40), base = { NETLIFY: "true", SITE_ID: "da1614d6-1173-4d1b-9064-e829e1c70807",
    CONTEXT: "production", BRANCH: "main", COMMIT_REF: release, DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:55432/fixture" };
  for (const change of [{ CONTEXT: "deploy-preview" }, { COMMIT_REF: "b".repeat(40) }, { SITE_ID: "other" }, {}, { DATABASE_URL: "bad" }]) {
    assert.throws(() => checkReleaseEnvironment({ ...base, ...change }, release));
  }
});

test("023 prerequisite verifies history and role, preserves existing wallet state and is idempotent", async t => {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const database = { ...sql(engine), transaction: fn => engine.transaction(client => fn(sql(client))), close: () => engine.close() };
  await database.exec("CREATE TABLE romanum_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())");
  const directory = new URL("../db/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d{3}_.*\.sql$/.test(file)).sort();
  for (const file of files.slice(0, 22)) {
    const source = await readFile(new URL(file, directory), "utf8");
    await database.exec(source);
    await database.query("INSERT INTO romanum_migrations(version,checksum) VALUES($1,$2)", [Number(file.slice(0,3)), createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex")]);
  }
  await grantCredits(database, { ownerId: "fixture-release", amount: 100, operationId: "fixture-release-grant" });
  await reserveCredits(database, { ownerId: "fixture-release", amount: 5, operationId: "fixture-existing-reservation" });
  const before = await getBalance(database, { ownerId: "fixture-release" });
  const snapshot = async () => JSON.stringify(await database.query("SELECT owner_id,entry_type,amount,balance_after,reserved_after FROM credits_ledger ORDER BY id"));
  const ledger = await snapshot();
  const identity = (await database.query("SELECT current_user AS role,current_database() AS database")).rows[0];
  const role = createHash("sha256").update(`${identity.role}:${identity.database}`).digest("hex");
  assert.equal(await providerAccountingAvailable(database), false);
  if (files.length > 23) {
    // The one-off release must refuse later migrations rather than applying them under its old authorization.
    await assert.rejects(applyNativeProviderPrerequisite(database, undefined, role));
    assert.equal(await providerAccountingAvailable(database), false);
    assert.deepEqual(await getBalance(database, { ownerId: "fixture-release" }), before);
    assert.equal(await snapshot(), ledger);
    return;
  }
  await assert.rejects(applyNativeProviderPrerequisite(database, undefined, "0".repeat(64)));
  assert.equal(await providerAccountingAvailable(database), false);
  await database.query("UPDATE romanum_migrations SET checksum='changed' WHERE version=22");
  await assert.rejects(applyNativeProviderPrerequisite(database, undefined, role));
  const source22 = await readFile(new URL(files[21], directory), "utf8");
  await database.query("UPDATE romanum_migrations SET checksum=$1 WHERE version=22", [createHash("sha256").update(source22.replaceAll("\r\n", "\n")).digest("hex")]);
  for (let i = 0; i < 2; i++) {
    assert.equal((await applyNativeProviderPrerequisite(database, undefined, role)).accountingAvailable, true);
    assert.deepEqual(await getBalance(database, { ownerId: "fixture-release" }), before);
    assert.equal(await snapshot(), ledger);
    assert.equal((await database.query("SELECT count(*)::int AS n FROM provider_attempts")).rows[0].n, 0);
  }
});
