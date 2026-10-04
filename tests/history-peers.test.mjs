import test from "node:test";
import assert from "node:assert/strict";
import { rankRecordedPeers, createHistoryPeerService } from "../src/lib/analytics/peer-selection.ts";
const entry = (id, genre, playing, chart = "popular") => ({ universe_id: String(id), name: `Game ${id}`, genre, playing: String(playing), chart_id: chart, rank: id, slot: "2026-10-01T00:00:00Z", observed_at: "2026-10-01T00:00:10Z" });
test("recorded peers prefer genre then size, deduplicate and disclose fallbacks", () => {
  const result = rankRecordedPeers([entry(1, "RPG", 10), entry(2, "Action", 10), entry(3, "rpg", 15), entry(3, "rpg", 15, "earning"), entry(4, null, 0)], 1);
  assert.equal(result.peers[0].universeId, 3);
  assert.equal(result.peers[0].placements.length, 2);
  assert.equal(result.peers[0].sameGenre, true);
  assert.equal(result.peers[0].similarSize, true);
  assert.equal(result.peers[1].sameGenre, false);
  assert.match(result.peers[1].reason, /differs or is unavailable/);
  assert.equal(result.peers.length, 3);
  assert.deepEqual(rankRecordedPeers([], 1), { target: null, peers: [] });
});
test("peer reads are bounded, anonymous, fixed-cutoff and need no providers", async () => {
  let reads = 0, clocks = 0;
  const service = createHistoryPeerService(async () => ({ query: async (sql, values) => { reads++; assert.match(sql, /^WITH anchor/); assert.match(sql, /NOT e.sponsored/); assert.equal(values[0], 1); return { rows: [entry(1, null, 0), entry(2, null, 0)] }; } }), () => { clocks++; return Date.parse("2026-10-02T00:00:00Z"); });
  const result = await service.peers({ universeId: 1, days: 1 });
  assert.equal(reads, 1); assert.equal(clocks, 1);
  assert.equal(result.peers[0].sizeDistance, 0);
  assert.equal(result.cutoff, "2026-10-02T00:00:00.000Z");
  await assert.rejects(service.peers({ universeId: 1, days: 31 }));
  assert.equal(reads, 1);
  const offline = await createHistoryPeerService(async () => null).peers({ universeId: 1 });
  assert.equal(offline.available, false); assert.deepEqual(offline.peers, []);
});


test("peer query executes against migrated isolated storage and excludes sponsored entries", async t => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { migrateHistory } = await import("../src/lib/history/migrate.ts");
  const engine = await PGlite.create(); t.after(() => engine.close());
  const adapter = client => ({ query: (sql, values) => client.query(sql, values), exec: async sql => { await client.exec(sql); } });
  const db = { ...adapter(engine), transaction: callback => engine.transaction(client => callback(adapter(client))), close: () => engine.close() };
  await migrateHistory(db);
  await db.exec(`INSERT INTO history_games(universe_id,root_place_id,name,first_seen,last_seen) VALUES (1,10,'Target','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z'),(2,20,'Peer','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z'),(3,30,'Ad','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
    INSERT INTO history_runs(id,slot,started_at,status) VALUES ('00000000-0000-0000-0000-000000000001','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','complete');
    INSERT INTO history_chart_fetches(run_id,chart_id,observed_at,status) VALUES ('00000000-0000-0000-0000-000000000001','popular','2026-10-01T00:00:10Z','complete');
    INSERT INTO history_chart_entries(run_id,chart_id,universe_id,rank,name,genre,playing,sponsored) VALUES
    ('00000000-0000-0000-0000-000000000001','popular',1,1,'Target','RPG',10,false),
    ('00000000-0000-0000-0000-000000000001','popular',2,2,'Peer','RPG',15,false),
    ('00000000-0000-0000-0000-000000000001','popular',3,3,'Ad','RPG',10,true);`);
  const result = await createHistoryPeerService(async () => db, () => Date.parse("2026-10-01T01:00:00Z")).peers({ universeId: 1 });
  assert.equal(result.target.universeId, 1);
  assert.deepEqual(result.peers.map(peer => peer.universeId), [2]);
  assert.equal(result.slot, "2026-10-01T00:00:00.000Z");
});
