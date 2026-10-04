import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { closeAccount } from "../src/lib/accounts/closure.ts";
import { readExportPage } from "../src/lib/accounts/data-export.ts";

test("private analytics records export by owner, close with the account, and reject stale writes", async (t) => {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  const sql = (client) => ({ query: (text, values) => client.query(text, values), exec: async (text) => { await client.exec(text); } });
  const db = { ...sql(engine), transaction: (operation) => engine.transaction((client) => operation(sql(client))), close: () => engine.close() };
  await migrateHistory(db);
  await db.query("INSERT INTO history_games(universe_id,root_place_id,name,first_seen,last_seen) VALUES(101,201,'Public fixture',now(),now())");
  const owners = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID(), ownerId = `account:${id}`, watchId = randomUUID(), experimentId = randomUUID();
    await db.query("INSERT INTO accounts(id,owner_id,roblox_user_id,username,display_name) VALUES($1,$2,$3,'fixture','Fixture')", [id, ownerId, 101 + i]);
    await db.query("INSERT INTO analytics_watchlists(id,owner_id,name,universe_id) VALUES($1,$2,$3,101)", [watchId, ownerId, `Owner ${i} watch`]);
    await db.query("INSERT INTO analytics_watchlist_state(watchlist_id,owner_id,revision) VALUES($1,$2,1)", [watchId, ownerId]);
    await db.query("INSERT INTO analytics_notifications(id,owner_id,watchlist_id,dedupe_key,observed_at,title,evidence) VALUES($1,$2,$3,$4,now(),$5,'{}')", [randomUUID(), ownerId, watchId, `fixture:${i}`, `Owner ${i} alert`]);
    await db.query("INSERT INTO analytics_experiments(id,owner_id,title,brief,evidence,intended_metric) VALUES($1,$2,$3,'{}','{}','public_playing')", [experimentId, ownerId, `Owner ${i} experiment`]);
    owners.push({ id, ownerId, watchId, experimentId });
  }
  const [a, b] = owners;
  const sections = ["analytics_watchlists", "analytics_watchlist_state", "analytics_notifications", "analytics_experiments"];
  for (const section of sections) {
    const page = await readExportPage(db, a, section);
    assert.equal(page.records.length, 1, `${section} excludes the other owner's row`);
    assert.ok(!JSON.stringify(page).includes(b.watchId));
    assert.ok(!JSON.stringify(page).includes(b.experimentId));
    assert.ok(!("dedupe_key" in page.records[0]), "internal notification identity is excluded");
  }
  await assert.rejects(readExportPage(db, { id: a.id, ownerId: b.ownerId }, "analytics_experiments"), (error) => error.code === "not_found");
  await closeAccount(db, { id: a.id, ownerId: a.ownerId });
  for (const table of sections) {
    const rows = (await db.query(`SELECT owner_id FROM ${table}`)).rows;
    assert.deepEqual(rows.map((row) => row.owner_id), [b.ownerId], `${table} deletes only the closing owner's records`);
  }
  assert.equal((await db.query("SELECT count(*)::int AS n FROM history_games")).rows[0].n, 1, "public observations are independent of ownership");
  await assert.rejects(db.query("INSERT INTO analytics_watchlists(id,owner_id,name,universe_id) VALUES($1,$2,'Stale',101)", [randomUUID(), a.ownerId]), (error) => error.code === "55000");
  await assert.rejects(db.query("INSERT INTO analytics_experiments(id,owner_id,title,brief,evidence,intended_metric) VALUES($1,$2,'Stale','{}','{}','public_playing')", [randomUUID(), a.ownerId]), (error) => error.code === "55000");
});
