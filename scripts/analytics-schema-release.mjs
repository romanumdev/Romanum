import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { postgresDatabase } from "../src/lib/history/database.ts";
import { providerAccountingAvailable } from "../src/lib/models/provider-schema.ts";
import { checkReleaseEnvironment } from "./native-provider-release.mjs";

// Opt-in, read-only verification inside the existing production build context.
// Reuse the previously verified site/database target; never export credentials.
const ROLE = "47c6715113831f84afc28425b9fe3cf12865e798ecbb362283148b98c27ab888";
const COLUMNS = ["game_id", "key_version", "iv", "ciphertext", "tag", "subject", "expires_at",
  "reconnect_required", "created_at", "updated_at"].sort();

export function checkAnalyticsReleaseEnvironment(environment, release) {
  checkReleaseEnvironment(environment, release);
  assert.notEqual(environment.ROBLOX_ANALYTICS_OAUTH_ENABLED, "true");
}

export async function verifyAnalyticsSchema(database, directory = path.join(process.cwd(), "db", "migrations"), expectedRole = ROLE) {
  const files = (await readdir(directory)).filter(file => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
  assert.equal(files.length, 27);
  assert.equal(files.at(-1), "027_linked_game_oauth.sql");
  const checksums = await Promise.all(files.map(async (file, index) => {
    assert.equal(Number(file.slice(0, 3)), index + 1);
    return createHash("sha256").update((await readFile(path.join(directory, file), "utf8")).replaceAll("\r\n", "\n")).digest("hex");
  }));
  return database.transaction(async sql => {
    await sql.exec("SET TRANSACTION READ ONLY");
    await sql.exec("SET LOCAL statement_timeout = '5s'");
    const identity = (await sql.query("SELECT current_user AS role, current_database() AS database, current_schema() AS schema")).rows[0];
    assert.equal(createHash("sha256").update(`${identity.role}:${identity.database}`).digest("hex"), expectedRole);
    assert.equal(identity.schema, "public");
    const { rows } = await sql.query("SELECT version, checksum FROM public.romanum_migrations ORDER BY version");
    assert.equal(rows.length, 27);
    for (const [index, row] of rows.entries()) {
      assert.equal(row.version, index + 1);
      assert.equal(row.checksum, checksums[index]);
    }
    const privileges = (await sql.query(`SELECT count(*) = 4 AND bool_and(
      has_table_privilege(to_regclass(name), 'SELECT') AND
      has_table_privilege(to_regclass(name), 'INSERT') AND
      has_table_privilege(to_regclass(name), 'UPDATE') AND
      has_table_privilege(to_regclass(name), 'DELETE')) AS ready
      FROM (VALUES ('public.linked_games'), ('public.linked_game_metrics'),
        ('public.linked_game_consents'), ('public.linked_game_oauth')) AS required(name)
      WHERE to_regclass(name) IS NOT NULL`)).rows[0];
    assert.equal(privileges.ready, true);
    const columns = (await sql.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='linked_game_oauth' ORDER BY column_name")).rows;
    assert.deepEqual(columns.map(row => row.column_name), COLUMNS);
    const cascade = (await sql.query(`SELECT count(*) = 1 AS ready FROM pg_constraint
      WHERE contype='f' AND conrelid='public.linked_game_oauth'::regclass
        AND confrelid='public.linked_games'::regclass AND confdeltype='c'`)).rows[0];
    assert.equal(cascade.ready, true);
    assert.equal(await providerAccountingAvailable(sql), true);
    return { targetRoleVerified: true, migration027: "verified", migrationChecksumsVerified: true,
      analyticsPrivilegesVerified: true, oauthSchemaVerified: true, providerAccountingAvailable: true };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let database;
  try {
    checkAnalyticsReleaseEnvironment(process.env, process.argv[2]);
    database = postgresDatabase(process.env.DATABASE_URL);
    const result = await verifyAnalyticsSchema(database);
    console.log(JSON.stringify({ analyticsSchemaRelease: result, commit: process.env.COMMIT_REF }));
  } catch {
    // Assertions and driver errors can contain connection details or private data.
    console.error("Analytics production schema verification failed. No migrations or private data were changed.");
    process.exitCode = 1;
  } finally { await database?.close(); }
}
