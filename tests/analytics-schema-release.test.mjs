import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { checkAnalyticsReleaseEnvironment, verifyAnalyticsSchema } from "../scripts/analytics-schema-release.mjs";

const release = "a".repeat(40);
const environment = { NETLIFY: "true", SITE_ID: "da1614d6-1173-4d1b-9064-e829e1c70807", CONTEXT: "production",
  BRANCH: "main", COMMIT_REF: release, DATABASE_URL: "postgres://test:secret@127.0.0.1:5432/untrusted" };

test("production schema check rejects other contexts, targets and mismatched release identities", () => {
  for (const change of [{ NETLIFY: "false" }, { SITE_ID: "another-site" }, { CONTEXT: "deploy-preview" },
    { BRANCH: "another-branch" }, { COMMIT_REF: "b".repeat(40) }, {}]) {
    assert.throws(() => checkAnalyticsReleaseEnvironment({ ...environment, ...change }, release));
  }
});

test("CLI failures expose neither database credentials nor assertion details", () => {
  const marker = "NEVER_PRINT_DATABASE_SECRET";
  const run = spawnSync(process.execPath, ["scripts/analytics-schema-release.mjs", release], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...environment,
      DATABASE_URL: `postgres://secret-user:${marker}@127.0.0.1:5432/untrusted` },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Analytics production schema verification failed/);
  assert.doesNotMatch(run.stdout + run.stderr, /NEVER_PRINT_DATABASE_SECRET|secret-user|postgres:\/\//);
});

test("read-only check validates the migrated schema and rejects missing or changed prerequisites", async t => {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
  const database = { ...sql(engine), transaction: operation => engine.transaction(client => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(database);
  const identity = (await database.query("SELECT current_user AS role, current_database() AS database")).rows[0];
  const role = createHash("sha256").update(`${identity.role}:${identity.database}`).digest("hex");
  const before = (await database.query("SELECT version, checksum, applied_at FROM romanum_migrations ORDER BY version")).rows;
  const commands = [];
  const observed = { transaction: operation => database.transaction(client => operation({
    query: (text, values) => { commands.push(text); return client.query(text, values); },
    exec: text => { commands.push(text); return client.exec(text); },
  })) };
  await t.test("only metadata is read, and migration history is untouched", async () => {
    assert.deepEqual(await verifyAnalyticsSchema(observed, undefined, role), {
      targetRoleVerified: true, migration027: "verified", migrationChecksumsVerified: true,
      analyticsPrivilegesVerified: true, oauthSchemaVerified: true, providerAccountingAvailable: true,
    });
    assert.equal(commands[0], "SET TRANSACTION READ ONLY");
    assert.ok(commands.every(text => /^(SELECT|SET)\b/.test(text)));
    assert.ok(commands.every(text => !/\bFROM\s+(?:public\.)?(?:linked_games|linked_game_oauth|linked_game_metrics|linked_game_consents|accounts)\b/i.test(text)));
    assert.deepEqual((await database.query("SELECT version, checksum, applied_at FROM romanum_migrations ORDER BY version")).rows, before);
  });
  await t.test("the expected role must match", async () => {
    await assert.rejects(verifyAnalyticsSchema(database, undefined, "0".repeat(64)));
  });
  await t.test("an altered historical checksum is rejected", async () => {
    await database.query("UPDATE romanum_migrations SET checksum=$1 WHERE version=1", ["0".repeat(64)]);
    await assert.rejects(verifyAnalyticsSchema(database, undefined, role));
    await database.query("UPDATE romanum_migrations SET checksum=$1 WHERE version=1", [before[0].checksum]);
  });
  await t.test("migration 027 must be recorded", async () => {
    await database.query("DELETE FROM romanum_migrations WHERE version=27");
    await assert.rejects(verifyAnalyticsSchema(database, undefined, role));
    await database.query("INSERT INTO romanum_migrations(version,checksum,applied_at) VALUES($1,$2,$3)", [27, before[26].checksum, before[26].applied_at]);
  });
  await t.test("a missing credential column is rejected even with a complete ledger", async () => {
    await database.exec("ALTER TABLE linked_game_oauth DROP COLUMN expires_at");
    await assert.rejects(verifyAnalyticsSchema(database, undefined, role));
  });
});
