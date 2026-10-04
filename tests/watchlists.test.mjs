import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { collectHistory } from "../src/lib/history/collector.ts";
import { evaluateRule, SLOT_MS } from "../src/lib/watchlists/rules.ts";
import { saveWatchlist, listWatchlists, deleteWatchlist, evaluateWatchlists, listNotifications, acknowledgeNotification, watchInput } from "../src/lib/watchlists/store.ts";
import { watchlistResponse } from "../src/lib/watchlists/http.ts";
const end=Date.parse("2026-10-03T12:00:00Z");
const iso=time=>new Date(time).toISOString();
const rule={universeId:1,peerIds:[],direction:"either",thresholdPercent:20,minimumPlayers:25,windowMinutes:30};
const game=id=>({universeId:id,rootPlaceId:id*100,name:`Fixture ${id}`,playing:100,visits:500,favorites:20,likes:10,dislikes:1,sponsored:false,rank:id});
const input=(id=1)=>({...rule,universeId:id,name:`Private ${id}`,enabled:true});
const load=async ids=>ids.map(game);
function samples(current=150,baseline=100,peerCurrent=100) {
  return [1,2].flatMap(universeId=>Array.from({length:6},(_,i)=>end-(5-i)*SLOT_MS).flatMap(time=>[{universeId,slot:iso(time),observedAt:iso(time+15_000),playing:universeId===1?current:peerCurrent},{universeId,slot:iso(time-86_400_000),observedAt:iso(time-86_400_000+15_000),playing:baseline}]));
}
async function database(t) {
  const engine=await PGlite.create();t.after(()=>engine.close());
  const sql=client=>({query:(text,values)=>client.query(text,values),exec:async text=>{await client.exec(text);}});
  const db={...sql(engine),transaction:operation=>engine.transaction(client=>operation(sql(client))),close:()=>engine.close()};await migrateHistory(db);return db;
}
async function seed(db,points) {
  for(const time of [...new Set(points.map(p=>p.slot))]) {
    const runId=randomUUID();await db.query("INSERT INTO history_runs(id,slot,started_at,status) VALUES($1,$2,$2,'complete') ON CONFLICT(slot) DO NOTHING",[runId,time]);
    const id=(await db.query("SELECT id FROM history_runs WHERE slot=$1",[time])).rows[0].id;
    for(const point of points.filter(p=>p.slot===time)) {
      await db.query("INSERT INTO history_targets(run_id,universe_id,status) VALUES($1,$2,'observed') ON CONFLICT DO NOTHING",[id,point.universeId]);
      await db.query("INSERT INTO history_observations(run_id,universe_id,observed_at,playing) VALUES($1,$2,$3,$4) ON CONFLICT(run_id,universe_id) DO UPDATE SET playing=EXCLUDED.playing,observed_at=EXCLUDED.observed_at",[id,point.universeId,point.observedAt,point.playing]);
    }
  }
}
test("paired public windows, peers, real zero and unavailable/future evidence behave conservatively",()=>{
  let result=evaluateRule(rule,samples(),iso(end),end+30_000);assert.equal(result.crossed,true);assert.equal(result.evidence.pairs,6);assert.equal(result.evidence.changePercent,50);
  result=evaluateRule({...rule,peerIds:[2]},samples(150,100,150),iso(end),end+30_000);assert.equal(result.crossed,false);assert.equal(result.evidence.signalPercent,0);
  assert.equal(evaluateRule(rule,samples(0),iso(end),end+30_000).crossed,true,"actual public zero is valid evidence");
  for(const points of [samples().slice(1),samples(150,0),samples().map(p=>p.slot===iso(end)?{...p,observedAt:iso(end+60_000)}:p),samples().map(p=>({...p,observedAt:iso(Date.parse(p.slot)+SLOT_MS)}))]) { const evaluated=evaluateRule(rule,points,iso(end),end+30_000);assert.notEqual(evaluated.coverage,"ready");assert.equal(evaluated.crossed,false);assert.equal(evaluated.recovered,false); }
  assert.equal(evaluateRule(rule,samples(),iso(end),end+SLOT_MS*3).coverage,"unavailable");
  assert.equal(evaluateRule({...rule,direction:"down"},samples(),iso(end),end+30_000).crossed,false);
});
test("private ownership, revision, caps and parent closure guards hold",async t=>{
  const db=await database(t);const watch=await saveWatchlist(db,"owner:a",input(),{load});
  assert.equal((await listWatchlists(db,"owner:b")).length,0);
  await assert.rejects(saveWatchlist(db,"owner:b",input(),{id:watch.id,revision:1,load}),e=>e.code==="not_found");
  await assert.rejects(saveWatchlist(db,"owner:a",input(),{id:watch.id,revision:9,load}),e=>e.code==="conflict");
  assert.equal(watchInput.safeParse({...input(),peerIds:[1]}).success,false);
  assert.equal(watchInput.safeParse({...input(),ownerId:"owner:b"}).success,false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM history_observations")).rows[0].n,0,"saving metadata never invents an observation");
  for(let id=2;id<=20;id++) await saveWatchlist(db,"owner:a",input(id),{load});
  await assert.rejects(saveWatchlist(db,"owner:a",input(21),{load}),e=>e.code==="limit");
  await db.query("INSERT INTO account_closures(owner_id,account_id) VALUES($1,$2)",["closed",randomUUID()]);
  await assert.rejects(saveWatchlist(db,"closed",input(),{load}),e=>e.code==="55000");
  await assert.rejects(db.query("INSERT INTO analytics_watchlist_state(watchlist_id,owner_id,revision) VALUES($1,'owner:b',1)",[watch.id]),e=>e.code==="23503");
});
test("persistent episode latch, deterministic retry, acknowledgment and deletion are owner scoped",async t=>{
  const db=await database(t);const watch=await saveWatchlist(db,"owner:a",{...input(),peerIds:[2]},{load});
  await seed(db,samples());assert.equal(await evaluateWatchlists(db,iso(end),end+30_000),1);
  assert.equal(await evaluateWatchlists(db,iso(end),end+30_000),0);
  let alerts=await listNotifications(db,"owner:a");assert.equal(alerts.length,1);assert.equal((await listNotifications(db,"owner:b")).length,0);
  await assert.rejects(acknowledgeNotification(db,"owner:b",alerts[0].id),e=>e.code==="not_found");
  await acknowledgeNotification(db,"owner:a",alerts[0].id);assert.ok((await listNotifications(db,"owner:a"))[0].acknowledged_at);
  // Gap must not reset the stored episode; repairing a later complete high window
  // remains suppressed until an actual complete below-threshold window arrives.
  await evaluateWatchlists(db,iso(end+SLOT_MS),end+SLOT_MS+30_000);
  let state=(await db.query("SELECT * FROM analytics_watchlist_state")).rows[0];assert.equal(state.latched,true);assert.equal(state.coverage,"waiting");
  const later=points=>points.map(p=>({...p,slot:iso(Date.parse(p.slot)+2*SLOT_MS),observedAt:iso(Date.parse(p.observedAt)+2*SLOT_MS)}));
  await seed(db,later(samples()));assert.equal(await evaluateWatchlists(db,iso(end+2*SLOT_MS),end+2*SLOT_MS+30_000),0);
  const recovered=samples(100).map(p=>({...p,slot:iso(Date.parse(p.slot)+3*SLOT_MS),observedAt:iso(Date.parse(p.observedAt)+3*SLOT_MS)}));
  await seed(db,recovered);await evaluateWatchlists(db,iso(end+3*SLOT_MS),end+3*SLOT_MS+30_000);assert.equal((await db.query("SELECT latched FROM analytics_watchlist_state")).rows[0].latched,false);
  const high=samples().map(p=>({...p,slot:iso(Date.parse(p.slot)+4*SLOT_MS),observedAt:iso(Date.parse(p.observedAt)+4*SLOT_MS)}));await seed(db,high);assert.equal(await evaluateWatchlists(db,iso(end+4*SLOT_MS),end+4*SLOT_MS+30_000),1);
  // Even lost latch state cannot duplicate an already persisted deterministic event.
  await db.query("DELETE FROM analytics_watchlist_state");assert.equal(await evaluateWatchlists(db,iso(end+4*SLOT_MS),end+4*SLOT_MS+30_000),0);
  await deleteWatchlist(db,"owner:a",watch.id);assert.equal((await listNotifications(db,"owner:a")).length,0);assert.equal((await db.query("SELECT count(*)::int AS n FROM analytics_watchlist_state")).rows[0].n,0);
});
test("free HTTP creation uses pending identity only after safe validation; cross-site writes stop early",async t=>{
  let identities=0;const deps={owner:async()=>null,ensureIdentity:async()=>{identities++;return "guest:test";},database:async()=>null,isCrossSite:r=>r.headers.get("sec-fetch-site")==="cross-site"};
  const req=(payload,headers={})=>new Request("https://romanum.test/api/watchlists",{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(payload)});
  assert.equal((await watchlistResponse(req(input(),{origin:"https://evil.test"}),deps)).status,403);
  assert.equal((await watchlistResponse(req({...input(),ownerId:"other"}),deps)).status,400);
  assert.equal((await watchlistResponse(req(input()),deps)).status,503);assert.equal(identities,0);
  const read=await watchlistResponse(new Request("https://romanum.test/api/watchlists"),{...deps,database:async()=>({})});assert.deepEqual(await read.json(),{watchlists:[]});assert.equal(read.headers.get("cache-control"),"private, no-store");
  const db=await database(t);const created=await watchlistResponse(req(input()),{...deps,database:async()=>db,loadGames:load});assert.equal(created.status,201);assert.equal(identities,1);assert.equal((await listWatchlists(db,"guest:test")).length,1);assert.equal((await db.query("SELECT count(*)::int AS n FROM credits_accounts")).rows[0].n,0,"free guest saving grants no credits");
});
test("saved public games enroll within the original collector cap and rotate attempted targets",async t=>{
  const db=await database(t);for(let id=1001;id<=1060;id++) {await db.query("INSERT INTO history_games VALUES($1,$2,$3,NULL,now(),now())",[id,id*100,`Saved ${id}`]);await db.query("INSERT INTO analytics_watchlists(id,owner_id,name,universe_id,enabled) VALUES($1,$2,$3,$4,false)",[randomUUID(),`fixture:${id}`,`Saved ${id}`,id]);}
  const charts=Array.from({length:300},(_,i)=>game(i+1));const requested=[];
  const loaders={getRobloxChart:async()=>charts,getGameStats:async ids=>{requested.push(...ids);return ids.map(game);}};
  const first=await collectHistory(db,{loaders,now:()=>end+15_000});assert.equal(first.targeted,300);assert.equal(requested.filter(id=>id>1000).length,50);assert.equal(requested.filter(id=>id<=1000).length,250);
  requested.length=0;await collectHistory(db,{loaders,now:()=>end+SLOT_MS+15_000});assert.ok(requested.includes(1060),"previously untargeted saves rotate ahead of attempted saves");assert.equal(requested.length,300);
});
