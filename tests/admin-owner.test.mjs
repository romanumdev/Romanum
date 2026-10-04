import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { adminOwnerConfig, isAdminOwner } from "../src/lib/admin/owner.ts";
import { createOwnerAdminService } from "../src/lib/admin/service.ts";
import { adminResponse } from "../src/lib/admin/http.ts";
import { adminPage } from "../src/lib/admin/query.ts";

const owner={accountId:"b90e15ba-7711-437d-b0ce-4f563197da20",robloxUserId:142277800};
const other="00000000-0000-4000-8000-000000000001";
const empty="00000000-0000-4000-8000-000000000002";
const tokens={owner:"a".repeat(43),other:"b".repeat(43),expired:"c".repeat(43),ended:"d".repeat(43)};
const hash=token=>createHash("sha256").update(token).digest("hex");

test("owner configuration requires the exact approved ID pair and cannot broaden through environment",()=>{
  const environment={ROMANUM_ADMIN_ACCOUNT_ID:owner.accountId,ROMANUM_ADMIN_ROBLOX_USER_ID:String(owner.robloxUserId)};
  assert.deepEqual(adminOwnerConfig(environment),owner);
  for(const env of [{},{ROMANUM_ADMIN_ACCOUNT_ID:owner.accountId},{...environment,ROMANUM_ADMIN_ACCOUNT_ID:other},{...environment,ROMANUM_ADMIN_ROBLOX_USER_ID:"1"}]) assert.equal(adminOwnerConfig(env),null);
  assert.equal(isAdminOwner({id:owner.accountId,robloxUserId:owner.robloxUserId},owner),true);
  assert.equal(isAdminOwner({id:other,robloxUserId:owner.robloxUserId},owner),false);
  assert.equal(isAdminOwner({id:owner.accountId,robloxUserId:1},owner),false);
  for(const value of ["0","-1","NaN","2.4",null,"9999999"]) assert.equal(adminPage(value),1);
  assert.equal(adminPage("2"),2);
});

test("real SQL reporting enforces session ownership, read-only transactions and data isolation",async t=>{
  const engine=await PGlite.create();
  t.after(()=>engine.close());
  let queries=[];
  const adapt=client=>({query:async(text,values)=>{queries.push(text);return client.query(text,values);},exec:async text=>{queries.push(text);await client.exec(text);}});
  const db={...adapt(engine),transaction:operation=>engine.transaction(client=>operation(adapt(client))),close:()=>engine.close()};
  await migrateHistory(db);
  const now=Date.now();
  const ago=hours=>new Date(now-hours*3_600_000).toISOString();
  const ids=Array.from({length:8},(_,index)=>`10000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`);
  // Test fixture writes below run only inside the isolated PGlite engine.
  for(const [id,roblox,name] of [[owner.accountId,owner.robloxUserId,"Approved fixture owner"],[other,2,"Other fixture user"],[empty,3,"No credit row"]]) {
    await engine.query("INSERT INTO accounts(id,roblox_user_id,owner_id,username,display_name,created_at) VALUES($1,$2,$3,$4,$4,$5)",[id,roblox,id,name,ago(100)]);
  }
  for(const [id,balance,reserved] of [[owner.accountId,200,20],[other,0,0],["guest:fixture",10,0],["closed:fixture",10,0]]) await engine.query("INSERT INTO credits_accounts(owner_id,balance,reserved) VALUES($1,$2,$3)",[id,balance,reserved]);
  for(const [token,id,expires] of [[tokens.owner,owner.accountId,ago(-24)],[tokens.other,other,ago(-24)],[tokens.expired,owner.accountId,ago(1)]]) await engine.query("INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES($1,$2,$3)",[hash(token),id,expires]);
  for(const [id,user] of [[ids[0],owner.accountId],[ids[1],other]]) await engine.query("INSERT INTO chats(id,owner_id,title,history) VALUES($1,$2,'PRIVATE TITLE','[{\"secret\":\"PRIVATE HISTORY\"}]')",[id,user]);
  for(const [id,chat,role,hours] of [[ids[2],ids[0],"user",2],[ids[3],ids[0],"assistant",1],[ids[4],ids[1],"user",3],[ids[5],ids[1],"assistant",2],[ids[6],ids[0],"user",30]]) await engine.query("INSERT INTO chat_messages(id,chat_id,role,content,events,created_at) VALUES($1,$2,$3,'PRIVATE CONTENT','[{\"secret\":\"PRIVATE EVENT\"}]',$4)",[id,chat,role,ago(hours)]);
  for(const [who,type,amount,change,hours] of [[owner.accountId,"capture",12,-12,2],[other,"capture",8,-8,3],["guest:fixture","capture",3,-3,4],["closed:fixture","capture",4,-4,5],[owner.accountId,"capture",10,-10,25],[owner.accountId,"release",20,0,1],[owner.accountId,"adjust",2,2,1],[owner.accountId,"adjust",1,-1,1],[owner.accountId,"grant",1000,1000,1],[owner.accountId,"reserve",99,0,1]]) await engine.query("INSERT INTO credits_ledger(owner_id,entry_type,status,amount,balance_change,reserved_change,balance_after,reserved_after,created_at) VALUES($1,$2,'fixture',$3,$4,0,0,0,$5)",[who,type,amount,change,ago(hours)]);
  await engine.query("INSERT INTO usage_charges(id,owner_id,feature,calls,cost_nano_usd,price_nano_usd,credits_charged,created_at) VALUES($1,$2,'chat',$3,170000000,281700000,27,$4)",[ids[7],owner.accountId,JSON.stringify([{input:7,output:3,secret:"PRIVATE CALL FIELD"},{input:4,output:2}]),ago(1)]);
  await engine.query("INSERT INTO insights(day,status,finished_at,cost_nano_usd) VALUES('2026-01-01','failed',$1,10000000)",[ago(1)]);
  await engine.query("SET timezone='Pacific/Auckland'");
  await engine.query("INSERT INTO mcp_tool_usage_daily(day,tool_name,successful_calls,failed_calls) VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,'search_games',3,1)");
  let token=tokens.owner;
  const service=createOwnerAdminService({token:async()=>token,database:async()=>db,owner:()=>owner});
  const clear=()=>{queries=[];};
  const onlySessionRead=()=>{
    assert.ok(queries.every(sql=>sql.startsWith("SET TRANSACTION") || sql.includes("FROM account_sessions")),"denied requests performed a global query");
  };
  await t.test("valid owner session returns accurate live metadata only and bounded user pages",async()=>{
    clear();
    const result=await service();
    assert.equal(result.status,"ok");
    const report=result.report;
    assert.equal(report.registeredUsers,3);
    assert.equal(report.activeUsers24h,2);
    assert.equal(report.savedMessages,5);
    assert.equal(report.userMessages,3);
    assert.equal(report.assistantMessages,2);
    assert.equal(report.messages24h,4);
    assert.equal(report.creditsSpent24h,27);
    assert.equal(report.users.reduce((sum,user)=>sum+user.spent24h,0),20);
    assert.equal(report.days.reduce((sum,day)=>sum+day.credits,0),37);
    assert.equal(report.days.at(-1).day,new Date(report.asOf).toISOString().slice(0,10));
    assert.equal(report.releasedHolds24h,20);
    assert.equal(report.positiveAdjustments24h,2);
    assert.equal(report.negativeAdjustments24h,1);
    assert.equal(report.providerCostNanoUsd,180000000);
    assert.equal(report.usagePriceNanoUsd,281700000);
    assert.equal(report.modelCalls,2);
    assert.equal(report.inputTokens,11);
    assert.equal(report.outputTokens,5);
    assert.equal(report.users.find(user=>user.id===owner.accountId).available,180);
    assert.equal(report.users.find(user=>user.id===other).available,0);
    assert.equal(report.users.find(user=>user.id===empty).available,null);
    assert.equal(report.publicUsage.available,false);
    assert.equal(report.mcpUsage.available,true);
    assert.equal(report.mcpUsage.totalCalls,4);
    assert.equal(report.mcpUsage.successRate,0.75);
    assert.equal(report.mcpUsage.popularTools[0].name,"search_games");
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE|token|ownerId|content|events|payload|history|calls\":/);
    assert.ok(queries[0].includes("REPEATABLE READ, READ ONLY"));
    assert.ok(queries.some(sql=>sql.includes("LIMIT $3 OFFSET $4")));
    assert.ok(queries.every(sql=>sql.startsWith("SET TRANSACTION") || sql.startsWith("SELECT")));
    assert.ok(queries.every(sql=>!/(?:\bcontent\b|\bpayload\b|\bevents\b|\bhistory\b|SELECT \*)/i.test(sql)));
    const response=adminResponse(result);
    assert.equal(response.status,200);
    assert.equal((await response.json()).mode,"live");
    assert.equal(response.headers.get("cache-control"),"private, no-store, max-age=0");
    assert.equal(response.headers.get("vary"),"Cookie");
  });
  for(const [label,value] of [["anonymous",null],["malformed", "admin"],["ordinary account",tokens.other],["expired session",tokens.expired],["ended session",tokens.ended]]) await t.test(`${label} is denied before global reporting`,async()=>{
    clear(); token=value;
    const result=await service();
    assert.deepEqual(result,{status:"denied"});
    assert.equal(adminResponse(result).status,404);
    onlySessionRead();
  });
  await t.test("missing configuration does not even read cookies or database",async()=>{
    const denied=createOwnerAdminService({owner:()=>null,token:async()=>assert.fail("cookie read"),database:async()=>assert.fail("database read")});
    assert.deepEqual(await denied(),{status:"denied"});
  });
  await t.test("both immutable identity fields must match the active session",async()=>{
    token=tokens.owner;
    for(const mismatch of [{...owner,accountId:other},{...owner,robloxUserId:2}]) {
      clear();
      const denied=createOwnerAdminService({owner:()=>mismatch,token:async()=>token,database:async()=>db});
      assert.deepEqual(await denied(),{status:"denied"});
      onlySessionRead();
    }
  });
  await t.test("a prior owner report never leaks into later ordinary requests",async()=>{
    token=tokens.owner; assert.equal((await service()).status,"ok");
    token=tokens.other; const result=await service();
    assert.deepEqual(await adminResponse(result).json(),{error:"Not found."});
  });
  await t.test("authorised query failure is unavailable, not a fixture, stale data or zero report",async()=>{
    token=tokens.owner;
    const failed={...db,transaction:operation=>db.transaction(sql=>operation({...sql,query:(text,values)=>text.includes("FROM account_sessions") ? sql.query(text,values) : Promise.reject(new Error("PRIVATE ERROR"))}))};
    const load=createOwnerAdminService({owner:()=>owner,token:async()=>token,database:async()=>failed});
    const result=await load();
    assert.deepEqual(result,{status:"unavailable"});
    const response=adminResponse(result);
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{error:"Reporting unavailable."});
  });
  await t.test("database enforces read-only reporting transactions",async()=>{
    await assert.rejects(db.transaction(async sql=>{
      await sql.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await sql.query("UPDATE credits_accounts SET balance=balance+1 WHERE owner_id=$1",[owner.accountId]);
    }),error=>error.code==="25006");
    assert.equal((await engine.query("SELECT balance FROM credits_accounts WHERE owner_id=$1",[owner.accountId])).rows[0].balance,200);
  });
  await t.test("missing MCP storage stays unavailable while the existing owner report remains usable",async()=>{
    token=tokens.owner;
    await engine.exec("DROP TABLE mcp_tool_usage_daily");
    const result=await service();
    assert.equal(result.status,"ok");
    assert.equal(result.report.mcpUsage.available,false);
    assert.equal(result.report.creditsSpent24h,27);
  });
  await t.test("deleted account loses access even if an old browser retains its cookie",async()=>{
    await engine.query("DELETE FROM accounts WHERE id=$1",[owner.accountId]);
    clear(); token=tokens.owner;
    assert.deepEqual(await service(),{status:"denied"});
    onlySessionRead();
  });
});
