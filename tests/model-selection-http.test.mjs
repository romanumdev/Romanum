import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const moduleUrl = relative => new URL(relative, new URL("../src/", import.meta.url)).href;
const virtual = code => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
const overrides = {
  "@/lib/history/database": "export async function historyDatabase(){globalThis.__modelHttp.storage++; if(globalThis.__modelHttp.fail)throw new Error('fixture-secret storage diagnostic'); return {};}",
  "@/lib/accounts/session": "export async function ensureOwner(){return 'fixture-owner';} export async function readOwner(){return 'fixture-owner';} export async function readAccount(){return globalThis.__modelHttp.queued?{id:'fixture-account',ownerId:'fixture-owner'}:null;}",
  "@/lib/credits/guest": "export async function welcomeGuest(){return {available:globalThis.__modelHttp.balance};}",
  "@/lib/credits/account": "export async function welcomeAccount(){return {available:globalThis.__modelHttp.balance};}",
  "@/lib/assistant/engine": `export {assistantRequest,runAssistant} from ${JSON.stringify(moduleUrl("lib/assistant/engine.ts"))}; export function assistantClient(){return globalThis.__modelHttp.client;}`,
  "@/lib/assistant/billing": "export function assistantBilling(){return globalThis.__modelHttp.billing;}",
  "@/lib/linked-games/assistant-tools": "export function privateAnalyticsTools(){return {definitions:[],checkAccess:async()=>{},execute:async()=>{throw new Error('Unexpected fixture tool');}};}",
  "@/lib/projects/conversation-tools": "export function conversationTools(){return {definitions:[],execute:async()=>{throw new Error('Unexpected fixture tool');}};}",
  "@/lib/linked-games/store": "export async function listLinkedGames(){return globalThis.__modelHttp.queued?[{aiAnalysis:true,collect:true,status:'active'}]:[];}",
  "@/lib/ad-reports/background": "export async function adReportBackgroundEnabled(){return false;}",
  "@/lib/chats/runs": `export {ChatRunBusyError} from ${JSON.stringify(moduleUrl("lib/chats/runs.ts"))};
    export async function failQueuedChatRun(){} export async function submitChatQuestion(db,input,accountId,prepare){
      const saved={chatId:'10000000-0000-4000-8000-000000000001',questionId:'10000000-0000-4000-8000-000000000002',question:input.question,history:[],attachments:[],images:[],project:null};
      const modelRoute=await prepare(saved);globalThis.__modelHttp.submitted={input,accountId,modelRoute};
      return {saved,modelRoute,runId:accountId?'10000000-0000-4000-8000-000000000003':null};}`,
  "@/lib/chats/store": `export {ChatError,isChatId,listChats,modelConversation,questionForModel,recordEvent} from ${JSON.stringify(moduleUrl("lib/chats/store.ts"))}; export async function saveAnswer(db,answer){globalThis.__modelHttp.answer=answer;}`,
  "next/server": "export function after(callback){globalThis.__modelHttp.after.push(callback);}",
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (overrides[specifier] && context.parentURL?.includes("/src/app/api/")) return virtual(overrides[specifier]);
  if (context.parentURL?.includes("/src/") && specifier.startsWith("next/") && !path.extname(specifier)) return next(`${specifier}.js`, context);
  if (specifier.startsWith("@/")) {
    const base = path.resolve(src, specifier.slice(2));
    const candidate = [base, `${base}.ts`].find(file => existsSync(file) && statSync(file).isFile());
    if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
  }
  if (context.parentURL?.startsWith(pathToFileURL(src).href) && specifier.startsWith(".") && !path.extname(specifier)) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(`${base}.ts`)) return { url: pathToFileURL(`${base}.ts`).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const ask = await import("../src/app/api/assistant/route.ts");
const chats = await import("../src/app/api/chats/route.ts");
hooks.deregister();

function fixture(t, extra = {}) {
  const keys = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.DEEPSEEK_API_KEY = "fixture-only";
  const f = { storage: 0, balance: 100, requests: [], holds: [], after: [], ...extra };
  f.client = { chat: { completions: { create: async request => {
    f.requests.push(request);
    return (async function* () {
      yield { choices: [{ delta: { content: "HTTP fixture answer" } }] };
      yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
    })();
  } } } };
  f.billing = { credits: 0, reserve: async ceiling => { f.holds.push(ceiling); return "fixture-hold"; }, settle: async () => {}, finish: async () => {}, tool: async (_, execute) => execute() };
  globalThis.__modelHttp = f;
  t.after(() => { delete globalThis.__modelHttp; for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return f;
}
function askRequest(selection, extra = {}) {
  return new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "HTTP fixture" }], ...(selection === undefined ? {} : { modelSelection: selection }), ...extra }) });
}
function chatRequest(selection) {
  const form = new FormData(); form.set("text", "HTTP fixture");
  if (selection !== undefined) form.set("modelSelection", typeof selection === "string" ? selection : JSON.stringify(selection));
  return new Request("http://localhost/api/chats", { method: "POST", body: form, headers: { "content-length": "1000" } });
}
const events = async response => (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

test("actual Ask/Chats routes reject injected/unknown choices before storage or provider access", async t => {
  const f = fixture(t);
  for (const selection of [null, { mode: "auto", configured: true }, { mode: "explicit", modelId: "invented" },
    { mode: "explicit", modelId: "deepseek-flash", executionEnabled: true }]) {
    for (const response of [await ask.POST(askRequest(selection)), await chats.POST(chatRequest(selection))]) {
      assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match((await response.json()).error, /valid model/);
    }
  }
  const duplicate = new FormData(); duplicate.set("text", "Fixture");
  duplicate.append("modelSelection", '{"mode":"auto"}'); duplicate.append("modelSelection", '{"mode":"auto"}');
  assert.equal((await chats.POST(new Request("http://localhost/api/chats", { method: "POST", body: duplicate, headers: { "content-length": "1000" } }))).status, 400);
  assert.equal((await chats.POST(chatRequest("not-json"))).status, 400);
  assert.equal(f.storage, 0); assert.equal(f.requests.length, 0);
});

test("unavailable frontier models and removed keys fail clearly without silently replacing explicit choices", async t => {
  const f = fixture(t);
  for (const modelId of ["gpt-6.1-sol", "claude-opus-5-5"]) {
    for (const response of [await ask.POST(askRequest({ mode: "explicit", modelId })), await chats.POST(chatRequest({ mode: "explicit", modelId }))]) {
      assert.equal(response.status, 409); assert.match((await response.json()).error, /unavailable/);
    }
  }
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal((await ask.POST(askRequest({ mode: "explicit", modelId: "deepseek-flash" }))).status, 409);
  assert.equal((await chats.POST(chatRequest({ mode: "auto" }))).status, 503);
  assert.equal(f.storage, 0); assert.equal(f.requests.length, 0);
});

test("foreground transport preserves explicit/Auto and ignores browser balance, readiness and quote claims", async t => {
  const f = fixture(t);
  for (const selection of [{ mode: "auto" }, { mode: "explicit", modelId: "deepseek-flash" }, undefined]) {
    for (const response of [await ask.POST(askRequest(selection, { quote: { reservationCredits: 0 }, availableCredits: 1_000_000, configured: true, model: "gpt-6-astra" })), await chats.POST(chatRequest(selection))]) {
      assert.equal(response.status, 200);
      const stream = await events(response);
      assert.deepEqual(stream[0].modelSelection, selection ?? { mode: "explicit", modelId: "deepseek-flash" });
      assert.equal(stream[0].decision.modelId, "deepseek-flash");
      assert.ok(stream[0].decision.quote.reservationCredits >= 2);
      assert.ok(stream.some(event => event.type === "model" && event.modelId === "deepseek-flash"));
      assert.ok(stream.some(event => event.type === "done"));
      assert.doesNotMatch(JSON.stringify(stream), /fixture-only|API_KEY/);
    }
  }
  assert.equal(f.requests.length, 6); assert.ok(f.requests.every(request => request.model === "deepseek-flash"));
  assert.ok(f.answer.events.some(({ e }) => e.type === "model_selection"));
});

test("queued route resolves once and carries the exact decision through its submission callback", async t => {
  const f = fixture(t, { queued: true });
  const response = await chats.POST(chatRequest({ mode: "auto" }));
  assert.equal(response.status, 202); await response.text();
  assert.ok(response.headers.get("x-chat-run-id"));
  assert.equal(f.after.length, 1); assert.equal(f.requests.length, 0);
  assert.deepEqual(f.submitted.modelRoute.modelSelection, { mode: "auto" });
  assert.equal(f.submitted.modelRoute.modelDecision.modelId, "deepseek-flash");
});

test("browser credits cannot bypass trusted balance; errors never expose storage diagnostics", async t => {
  const f = fixture(t, { balance: 1 });
  assert.equal((await ask.POST(askRequest({ mode: "auto" }, { availableCredits: 999999, quote: { reservationCredits: 0 } }))).status, 402);
  assert.equal((await chats.POST(chatRequest({ mode: "auto" }))).status, 402);
  assert.equal(f.requests.length, 0);
  f.balance = 100;
  for (const response of [await ask.POST(askRequest({ mode: "explicit", modelId: "deepseek-v4-pro" })), await chats.POST(chatRequest({ mode: "explicit", modelId: "deepseek-v4-pro" }))]) {
    assert.equal(response.status, 402, "enabled Pro still requires its full trusted reservation");
    assert.match((await response.json()).error, /Not enough credits/);
  }
  assert.equal(f.requests.length, 0, "insufficient balance cannot submit a Pro call");
  f.fail = true; f.balance = 100;
  for (const response of [await ask.POST(askRequest({ mode: "auto" })), await chats.POST(chatRequest({ mode: "auto" }))]) {
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /fixture-secret|diagnostic/);
  }
});
