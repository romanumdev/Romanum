import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

// Exercise the real server pages and readiness code without sessions, network or
// database access. UI boundaries stay as elements so their actual props can be checked.
const root = fileURLToPath(new URL("../src/", import.meta.url));
const componentNames = {
  "chats/chat-view": ["ChatView"], "projects/project-sign-in": ["ProjectSignIn"],
  "analytics/inline-tool": ["InlineAnalyticsTool"], "history/competitor-comparison": ["CompetitorComparison"],
  "watchlists/watchlists-workspace": ["WatchlistsWorkspace"], "experiments/experiments-panel": ["ExperimentsPanel"],
  "assistant/assistant": ["Assistant"], "market/overview": ["MarketOverview"],
  "history/player-history": ["PlayerHistory"], "games/game-search": ["GameSearch"],
  "analytics/chart-invitation": ["ChartInvitation"], "analytics/sections": ["GamesSection", "GenresSection", "TrendsSection"],
  "analytics/earnings-calculator": ["EarningsCalculator"], "analytics/revenue": ["RevenueControls", "GameEarningsPanel"],
  "account/private-analytics": ["PrivateAnalytics"], "game-icon": ["GameIcon"],
  "watchlists/save-watchlist-button": ["SaveWatchlistButton"],
};
const mocks = {
  "next/server": "export async function connection() {}",
  "next/navigation": "export function notFound(){throw new Error('not found');}",
  "next/link": "export default function Link(){return null;}",
  "@/components/analytics/navigation": "export const ANALYTICS_VIEWS=['overview','games','charts','trends','genres','earnings']; export function AnalyticsNavigation(){return null;}",
  "@/lib/accounts/session": "export async function readOwner(){return 'account:fixture';} export async function readAccount(){return {id:'fixture',ownerId:'account:fixture'};}",
  "@/lib/history/database": "export async function historyDatabase(){return {};}",
  "@/lib/chats/store": "export async function listChats(){return [];} export async function readChat(){return {id:'fixture-chat',title:'Fixture',messages:[],projectId:null};}",
  "@/lib/chats/runs": "export async function activeChatRun(){return null;}",
  "@/lib/projects/store": "export async function readProject(){return null;} export async function listProjects(){return [];}",
  "@/lib/linked-games/store": "export async function linkedGameForUniverse(){return null;} export async function readGameMetrics(){return [];}",
  "@/lib/skill-catalog": "export const SKILL_CATALOG=[];",
  "@/lib/game-discovery": `export function parseUniverseId(value){return Number(value);} export async function loadPublicGame(){return {game:{universeId:42,rootPlaceId:43,name:'Fixture game',creator:{name:'Fixture'},playing:1,visits:2,favorites:3,likeRatio:1,created:'2026-10-01',updated:'2026-10-01'},fetchedAt:'2026-10-01T00:00:00Z',source:'https://games.roblox.com/v1/games'};}`,
  "@/lib/roblox-icons": "export async function getGameIcons(){return new Map();}",
  "@/lib/charts/spec": "export function formatValue(value){return String(value);}",
  "@/lib/analytics/game-analysis": "export function gameAnalysisPrompt(){return 'Fixture review';}",
  "@/lib/public-discovery": "export function analyticsPageMetadata(){return {};} export function publicGameMetadata(){return {};} export function utcObservationTime(){return 'Fixture time';}",
};
for (const [suffix, names] of Object.entries(componentNames)) {
  mocks[`@/components/${suffix}`] = names.map(name => `export function ${name}(){return null;}`).join("\n");
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier in mocks) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const base = path.resolve(root, specifier.slice(2));
      const candidate = [`${base}.ts`, `${base}.tsx`].find(file => existsSync(file));
      if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    }).outputText };
    return next(url, context);
  },
});
const { default: ChatsPage } = await import("../src/app/chats/page.tsx");
const { default: ChatPage } = await import("../src/app/chats/[id]/page.tsx");
const { default: AnalyticsPage } = await import("../src/app/analytics/page.tsx");
const { default: GamePage } = await import("../src/app/analytics/games/[universeId]/page.tsx");
hooks.deregister();

function connectedElements(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(connectedElements);
  if (!node.props) return [];
  return [...(Object.hasOwn(node.props, "connected") ? [node] : []), ...connectedElements(node.props.children)];
}

test("new/reopened Chats and every analytics invitation accept native-only providers and observe key removal", async t => {
  const keys = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const pages = [
    ["New chat", () => ChatsPage({ searchParams: Promise.resolve({}) }), ["ChatView"]],
    ["Saved chat", () => ChatPage({ params: Promise.resolve({ id: "fixture-chat" }), searchParams: Promise.resolve({}) }), ["ChatView"]],
    ["Analytics", () => AnalyticsPage({ searchParams: Promise.resolve({}) }), ["Assistant", "ChartInvitation", "MarketOverview"]],
    ["Trends", () => AnalyticsPage({ searchParams: Promise.resolve({ view: "trends" }) }), ["Assistant", "ChartInvitation", "TrendsSection"]],
    ["Game analysis", () => GamePage({ params: Promise.resolve({ universeId: "42" }), searchParams: Promise.resolve({}) }), ["Assistant"]],
  ];
  for (const configured of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", null]) {
    for (const key of keys) delete process.env[key];
    if (configured) process.env[configured] = "fixture-never-a-real-key";
    for (const [label, draw, names] of pages) {
      const elements = connectedElements(await draw());
      assert.deepEqual(elements.map(element => element.type.name), names, label);
      for (const element of elements) assert.equal(element.props.connected, Boolean(configured), `${label}: ${configured ?? "keys removed"}`);
      assert.ok(!JSON.stringify(elements.map(element => element.props)).includes("fixture-never-a-real-key"));
    }
  }
});
