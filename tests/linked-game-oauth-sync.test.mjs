import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ANALYTICS_SCOPE, saveGameOAuthGrant } from "../src/lib/linked-games/oauth.ts";
import { saveLinkedGame, setCollect } from "../src/lib/linked-games/store.ts";
import { syncLinkedGame } from "../src/lib/linked-games/sync.ts";
import { SYNCED_METRICS } from "../src/lib/linked-games/metrics.ts";

async function fixture(t, oauth = true) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const adapter = client => ({ query: (sql, values) => client.query(sql, values), exec: sql => client.exec(sql) });
  const db = { ...adapter(engine), transaction: fn => engine.transaction(client => fn(adapter(client))), close: () => engine.close() };
  for (const file of ["012_accounts.sql","013_linked_games.sql","020_private_analytics_ai.sql","027_linked_game_oauth.sql"]) await db.exec(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),"utf8"));
  const accountId = randomUUID(), key = randomBytes(32);
  await db.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name) VALUES($1,42,$2,'Fixture','Fixture')",[accountId,`account:${accountId}`]);
  const game = await saveLinkedGame(db,{ accountId,universeId:100,apiKey:"legacy-fixture-key-1234567890",keyExpiresAt:null },key);
  if (oauth) await saveGameOAuthGrant(db,accountId,game.id,{ access_token:"near-expiry",refresh_token:"original-refresh",scopes:[ANALYTICS_SCOPE],expiresAt:new Date(Date.now()+61000).toISOString(),subject:"42",universeId:100,resourceOwners:[{id:"42",type:"User"}] },key);
  for (const [name,value] of Object.entries({ROBLOX_CLIENT_ID:"fixture-client",ROBLOX_CLIENT_SECRET:"fixture-secret"})) {
    const previous=process.env[name]; process.env[name]=value;
    t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous;});
  }
  return { db,accountId,game,key };
}
function upstream(legacy = false) {
  const calls=[];
  const fetch=async(url,init={})=>{
    calls.push(String(url));
    if (String(url).endsWith("/oauth/v1/token")) {
      assert.equal(new URLSearchParams(init.body).get("refresh_token"),"original-refresh");
      return Response.json({access_token:"rotated-access",refresh_token:"rotated-refresh",token_type:"Bearer",expires_in:900,scope:ANALYTICS_SCOPE});
    }
    if (String(url).endsWith("/token/resources")) {
      assert.equal(new URLSearchParams(init.body).get("token"),"rotated-access");
      return Response.json({resource_infos:[{owner:{id:"42",type:"User"},resources:{universe:{ids:["100"]}}}]});
    }
    assert.match(String(url),/analytics-query-api\/v1\/universes\/100\/metrics$/);
    const headers=new Headers(init.headers);
    assert.equal(headers.get("authorization"),legacy?null:"Bearer rotated-access");
    assert.equal(headers.get("x-api-key"),legacy?"legacy-fixture-key-1234567890":null);
    return Response.json({done:true,response:{values:[{breakdowns:[],dataPoints:[{time:"2026-10-01T00:00:00Z",value:100}]}]}});
  };
  return {fetch,calls};
}

test("61-second OAuth token refreshes before sync and resource access is rechecked between metrics",async t=>{
  const {db,game,key}=await fixture(t),mock=upstream();
  const result=await syncLinkedGame(db,game.id,{secretsKey:key,fetch:mock.fetch,sleep:async()=>{}});
  assert.equal(result.outcome,"synced");assert.equal(result.stored,SYNCED_METRICS.length);
  assert(mock.calls[0].endsWith("/oauth/v1/token"));
  assert.equal(mock.calls.filter(url=>url.endsWith("/oauth/v1/token")).length,1);
  assert.equal(mock.calls.filter(url=>url.endsWith("/token/resources")).length,SYNCED_METRICS.length);
  assert.equal(mock.calls.filter(url=>url.endsWith("/metrics")).length,SYNCED_METRICS.length);
});
test("OAuth sync stops further requests and discards results when consent changes between metrics",async t=>{
  const {db,accountId,game,key}=await fixture(t),mock=upstream();let changed=false;
  const result=await syncLinkedGame(db,game.id,{secretsKey:key,fetch:mock.fetch,sleep:async()=>{if(!changed){changed=true;await setCollect(db,accountId,game.id,false);}}});
  assert.deepEqual(result,{outcome:"discarded",stored:0});
  assert.equal(mock.calls.filter(url=>url.endsWith("/metrics")).length,1);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM linked_game_metrics WHERE game_id=$1",[game.id])).rows[0].count,0);
});
test("legacy sync keeps one stored API key and performs no OAuth requests",async t=>{
  const {db,game,key}=await fixture(t,false),mock=upstream(true);
  const result=await syncLinkedGame(db,game.id,{secretsKey:key,fetch:mock.fetch,sleep:async()=>{}});
  assert.equal(result.outcome,"synced");assert.equal(mock.calls.length,SYNCED_METRICS.length);
  assert(mock.calls.every(url=>url.includes("analytics-query-api")));
});
