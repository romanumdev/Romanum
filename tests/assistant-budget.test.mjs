import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { assistantBilling, quoteAssistantCall } from "../src/lib/assistant/billing.ts";
import { assistantRequest, runAssistant } from "../src/lib/assistant/engine.ts";
import { fundedFinalAnswer, requestFitsCredits } from "../src/lib/assistant/request-budget.ts";
import { resolveAssistantModel } from "../src/lib/assistant/model-selection.ts";
import { CreditsError, getBalance, grantCredits } from "../src/lib/credits/ledger.ts";
import { finishUnreportedUsage, reserveUsage, settleUsage } from "../src/lib/credits/usage-holds.ts";
import { CURRENT_PRICING_POLICY, LEGACY_PRICING_POLICY } from "../src/lib/credits/pricing-policy.ts";
import { reservationCredits } from "../src/lib/models/estimate.ts";

const ownerId="budget-fixture", signal=()=>new AbortController().signal;
async function database(t,amount=10) {
  const engine=await PGlite.create();t.after(()=>engine.close());
  const sql=client=>({query:(text,values)=>client.query(text,values),exec:text=>client.exec(text)});
  const db={...sql(engine),transaction:fn=>engine.transaction(client=>fn(sql(client))),close:()=>engine.close()};
  for(const file of ["002_credits.sql","010_usage.sql","014_usage_holds.sql","018_tool_usage.sql"]) await db.exec(await readFile(`db/migrations/${file}`,"utf8"));
  await grantCredits(db,{ownerId,amount,operationId:"fixture-grant"});
  return db;
}
function environment(t) {
  const saved=process.env.DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY="fixture-only";
  t.after(()=>{if(saved===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=saved;});
}
function transport(replies) {
  const requests=[];
  const client={chat:{completions:{create:async request=>{
    const index=requests.length;requests.push(request);
    return(async function*(){yield {choices:[{delta:replies(index,request),finish_reason:"stop"}]};yield {choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}};})();
  }}}};
  return {client,requests};
}
const textQuestion=[{role:"user",content:"Suggest a game idea using the upcoming games."}];

test("10-credit wallet with 0.46 fractional spend funds a bounded answer after research growth",async t=>{
  environment(t);const db=await database(t);
  const seed=await reserveUsage(db,{ownerId,feature:"ask",maxPriceNanoUsd:5_000_000});
  const prior=await settleUsage(db,{ownerId,id:seed.id,call:{model:"deepseek-flash",at:new Date("2026-10-02T02:00:00Z"),input:4000,cachedInput:0,output:533}});
  assert.equal(prior.credits,0.4599);
  assert.deepEqual(await getBalance(db,{ownerId}),{ownerId,balance:10,reserved:0,available:10});
  const conversation=[...textQuestion,{role:"assistant",content:"",reasoning_content:"",tool_calls:[{id:"research",type:"function",function:{name:"get_roblox_charts",arguments:'{"chart":"up_and_coming","limit":15}'}}]},
    {role:"tool",tool_call_id:"research",content:JSON.stringify({games:Array.from({length:15},(_,i)=>({universeId:i+1,name:`Observed game ${i+1}`,playing:100+i,description:"x".repeat(4000)}))})}];
  const old=assistantRequest(conversation,{systemPrompt:"Fixture instructions"});
  assert(reservationCredits(quoteAssistantCall(old))>10);
  await assert.rejects(reserveUsage(db,{ownerId,feature:"ask",maxPriceNanoUsd:quoteAssistantCall(old)}),error=>error instanceof CreditsError&&error.code==="insufficient_balance");
  const modelRoute=resolveAssistantModel({mode:"auto"},old,10,{DEEPSEEK_API_KEY:"fixture-only",OPENAI_API_KEY:"fixture-only"});
  assert.equal(modelRoute.modelDecision.modelId,"deepseek-flash");
  assert.equal(modelRoute.modelDecision.reason,"auto_affordable");
  const f=transport(()=>({content:"Prototype one short round based on the observed games; retention was not measured."})),events=[];
  await runAssistant({...f,conversation,systemPrompt:"Fixture instructions",modelRoute,billing:assistantBilling(db,ownerId,"ask"),signal:signal(),send:event=>events.push(event)});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].tools,undefined);
  assert(f.requests[0].max_tokens>=1024&&f.requests[0].max_tokens<=4096);
  assert.equal(quoteAssistantCall(f.requests[0]),modelRoute.modelDecision.quote.reservationPriceNanoUsd);
  assert(!events.some(event=>event.type==="error"));assert.equal(events.at(-1).type,"done");
  assert.equal((await getBalance(db,{ownerId})).reserved,0);
  const holds=(await db.query("SELECT status,max_price_nano_usd,settled_price_nano_usd FROM usage_holds")).rows;
  assert(holds.every(hold=>hold.status==="settled"&&Number(hold.settled_price_nano_usd)<=Number(hold.max_price_nano_usd)));
});

test("growing guide and 15-game tool results finish on the pinned model without spending on another lookup",async t=>{
  environment(t);const db=await database(t),base=assistantBilling(db,ownerId,"ask"),events=[];
  const names=["load_skill","get_roblox_charts","get_market_analysis"],executed=[];
  const billing={...base,get credits(){return base.credits;},tool:(name,_execute,requestSignal)=>base.tool(name,async()=>{
    executed.push(name);return {ok:true,summary:"Local research fixture",result:name==="load_skill"?{skill:"game-design",guide:"x".repeat(15_000)}:{games:Array.from({length:15},(_,i)=>({universeId:i+1,name:`Observed game ${i+1}`,playing:i+100,description:"x".repeat(4000)}))}};
  },requestSignal)};
  const f=transport((index,request)=>request.tools?{tool_calls:[{index:0,id:`lookup-${index}`,function:{name:names[index],arguments:index===0?'{"skill":"game-design"}':'{}'}}]}:{content:"Use a short cooperative round. This recommendation uses current public observations, not measured retention."});
  const modelRoute=resolveAssistantModel({mode:"auto"},assistantRequest(textQuestion),10,{DEEPSEEK_API_KEY:"fixture-only"});
  await runAssistant({...f,conversation:textQuestion,modelRoute,billing,signal:signal(),send:event=>events.push(event)});
  assert.deepEqual(executed,["load_skill","get_roblox_charts"]);
  assert.equal(f.requests.length,3);assert(f.requests.every(request=>request.model==="deepseek-flash"));
  assert.equal(f.requests.at(-1).tools,undefined);assert(f.requests.at(-1).max_tokens<=4096);
  assert(!events.some(event=>event.type==="error"));assert.equal(events.at(-1).type,"done");
  assert.equal((await getBalance(db,{ownerId})).reserved,0);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM usage_charges WHERE jsonb_array_length(tools)>0")).rows[0].count,2);
});

test("available budget excludes uncertain holds and truly unfunded requests do not call a provider",async t=>{
  environment(t);const db=await database(t);
  const held=await reserveUsage(db,{ownerId,feature:"ask",maxPriceNanoUsd:70_000_000});
  await finishUnreportedUsage(db,{ownerId,id:held.id,uncertain:true});
  const billing=assistantBilling(db,ownerId,"ask");assert.equal(await billing.availableCredits(),2);
  const f=transport(()=>assert.fail("Unfunded provider call")),events=[];
  await runAssistant({...f,conversation:[{role:"user",content:"x".repeat(60_000)}],systemPrompt:"Fixture",billing,signal:signal(),send:event=>events.push(event)});
  assert.equal(f.requests.length,0);assert.equal(events.at(-1).type,"error");assert.match(events.at(-1).message,/available credits/);
  assert.deepEqual(await getBalance(db,{ownerId}),{ownerId,balance:10,reserved:8,available:2});
  assert.equal((await db.query("SELECT status FROM usage_holds WHERE id=$1",[held.id])).rows[0].status,"uncertain");
});

test("a failed atomic reservation gets one funded recalculation before dispatch; transport failures never retry",async()=>{
  let reserves=0,availableReads=0;const f=transport(()=>({content:"A bounded answer."})),events=[];
  const billing={credits:0,availableCredits:async()=>++availableReads===1?100:3,reserve:async()=>{if(++reserves===1)throw new CreditsError("insufficient_balance","Concurrent hold");return "held";},settle:async()=>{},finish:async()=>assert.fail("Reported usage must settle")};
  await runAssistant({...f,conversation:textQuestion,systemPrompt:"Fixture",billing,signal:signal(),send:event=>events.push(event)});
  assert.equal(reserves,2);assert.equal(f.requests.length,1);assert.equal(f.requests[0].tools,undefined);assert.equal(events.at(-1).type,"done");
  let sent=0,finished=false;const failing={chat:{completions:{create:async()=>{sent++;throw new Error("Ambiguous transport failure");}}}};
  await runAssistant({client:failing,conversation:textQuestion,systemPrompt:"Fixture",billing:{...billing,availableCredits:async()=>100,reserve:async()=>"uncertain",finish:async(_id,uncertain)=>{finished=uncertain;}},signal:signal(),send:()=>{}});
  assert.equal(sent,1);assert.equal(finished,true);
});

test("low remaining budget declines paid research and funds the final response with matched tool messages",async()=>{
  let reads=0;const events=[];
  const f=transport(index=>index===0?{tool_calls:["load_skill","get_game_stats"].map((name,index)=>({index,id:`declined-${index}`,function:{name,arguments:"{}"}}))}:{content:"Here is a short proposal. The requested lookups were not run, so game-specific activity is unchecked."});
  const billing={credits:0,availableCredits:async()=>++reads===1?100:3,reserve:async()=>"held",settle:async()=>{},finish:async()=>assert.fail("Usage must settle"),tool:async()=>assert.fail("Unfunded research must not run")};
  await runAssistant({...f,conversation:textQuestion,systemPrompt:"Fixture",billing,signal:signal(),send:event=>events.push(event)});
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].tools,undefined);
  assert.equal(f.requests[1].messages.filter(message=>message.role==="tool").length,2);
  assert(f.requests[1].messages.filter(message=>message.role==="tool").every(message=>/not run/.test(message.content)));
  assert(!events.some(event=>event.type==="tool_start"||event.type==="error"));assert.equal(events.at(-1).type,"done");
});

test("budgeting retains both pricing policies, carry headroom and an explicit incomplete response",async()=>{
  const request=assistantRequest([{role:"user",content:"x".repeat(60_000)}],{systemPrompt:"Fixture"});
  for(const policy of [CURRENT_PRICING_POLICY,LEGACY_PRICING_POLICY]) {
    const bounded=fundedFinalAnswer(request,7,policy);assert(bounded);assert(requestFitsCredits(bounded,7,policy));
    assert.equal(reservationCredits(quoteAssistantCall(bounded,policy)),Math.ceil(quoteAssistantCall(bounded,policy)/10_000_000)+1);
  }
  const events=[],client={chat:{completions:{create:async()=>(async function*(){yield {choices:[{delta:{content:"Partial answer",tool_calls:[{index:0,id:"partial-tool",function:{name:"get_game_stats",arguments:"{}"}}]},finish_reason:"length"}]};yield {choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100}};})()}}};
  await runAssistant({client,conversation:textQuestion,billing:{credits:0,availableCredits:async()=>100,reserve:async()=>"held",settle:async()=>{},finish:async()=>assert.fail("Usage must settle"),tool:async()=>assert.fail("Truncated tool calls must not execute")},signal:signal(),send:event=>events.push(event)});
  assert(events.some(event=>event.type==="error"&&/incomplete/.test(event.message)));assert.equal(events.at(-1).type,"done");
});
