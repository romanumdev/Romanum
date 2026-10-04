import type OpenAI from "openai";
import { z } from "zod";
import { CHART_KINDS, type ChartSpec, METRIC_KEYS, PALETTE_ORDER } from "../charts/spec.ts";
import { ROBLOX_CHARTS, type RobloxChartId } from "../roblox.ts";
import { PUBLIC_TOOLS, isPublicTool, runPublicTool, publicToolError } from "../public-tools.ts";
import { buildChart } from "./chart-tool.ts";
import type { FetchedData } from "./fetched-data";
import type { SavedPlanCard } from "./types";
import type { ProjectBrief } from "../projects/store.ts";
import { implementationBriefSchema, type ImplementationBrief } from "../implementation/brief.ts";

const chatOfferSchema = z.object({ reason: z.string().trim().min(1).max(240) }).strict();

export const TOOLS: OpenAI.Chat.ChatCompletionFunctionTool[] = [
  { type: "function", function: { name: "create_implementation_brief", description: "Show a copyable AI coding brief for the user's agreed Roblox idea or analytics recommendation. Include relevant game context, requested requirements and concrete acceptance criteria. Preserve uncertainty and label proposed design assumptions. This prepares text only; it does not run code.", parameters: z.toJSONSchema(implementationBriefSchema, { target: "draft-7", io: "input" }) } },
  { type: "function", function: { name: "offer_chat_continuation", description: "Offer a user-clicked Take this to chat button when an analytics conversation is ready for deeper design or implementation. Supply a short reason. The application chooses the existing saved conversation; this never navigates, creates a chat, sends a message or executes code.", parameters: z.toJSONSchema(chatOfferSchema, { target: "draft-7", io: "input" }) } },
  ...Object.entries(PUBLIC_TOOLS).map(([name, tool]): OpenAI.Chat.ChatCompletionFunctionTool => ({
    type: "function",
    function: { name, description: tool.description, parameters: z.toJSONSchema(tool.schema, { target: "draft-7", io: "input" }) },
  })),
  {
    type: "function",
    function: {
      name: "create_chart",
      description:
        "Show a chart or stat tiles in the chat. Values are filled in from data your other tools already fetched in this conversation, so fetch first. Forms: line (one game and one metric over time; fetch get_game_history first, requires at least two observations, keeps gaps), bar (horizontal, best for rankings and long names), column, stacked_bar (parts of a total per game), donut (share of one metric, up to 6 slices), treemap (share across many games), scatter (metrics[0] on x, metrics[1] on y, optional metrics[2] as bubble size), radar (3+ metrics for up to 3 games, each axis relative to the highest value), stat_tiles (headline numbers for up to 3 games).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: CHART_KINDS },
          title: { type: "string", description: "Short title, up to 80 characters." },
          subtitle: { type: "string", description: "Optional one-line context." },
          universeIds: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 30 },
          metrics: { type: "array", items: { type: "string", enum: METRIC_KEYS }, minItems: 1, maxItems: 6 },
          colors: {
            type: "object",
            description: `Optional colours keyed by universe ID (as a string) or metric name. Values: ${[...PALETTE_ORDER, "gray"].join(", ")}. Scatter and radar allow only blue, orange, aqua and gray.`,
            additionalProperties: { type: "string", enum: [...PALETTE_ORDER, "gray"] },
          },
          highlight: { type: "integer", description: "Universe ID to emphasise; other games turn gray." },
          sort: { type: "string", enum: ["desc", "asc", "none"] },
          logScale: { type: "boolean", description: "Log value axis, for values spanning several orders of magnitude." },
          showValues: { type: "boolean", description: "Label bars or points with their values." },
          format: { type: "string", enum: ["compact", "full", "percent"] },
          size: { type: "string", enum: ["small", "medium", "large"] },
        },
        required: ["type", "title", "universeIds", "metrics"],
        additionalProperties: false,
      },
    },
  },
];

const LABELS: Record<string, string> = {
  create_implementation_brief: "Prepare implementation brief",
  offer_chat_continuation: "Offer chat continuation",
  list_ad_reports: "Find imported ads reports",
  read_ad_report: "Read imported ads evidence",
  compare_ad_reports: "Compare ads evidence",
  read_ad_learning_history: "Read private learning history",
  prepare_ad_thumbnail_brief: "Prepare thumbnail test brief",
  list_my_linked_games: "Find your linked games",
  get_private_analytics_catalog: "Read private analytics catalog",
  get_private_game_overview: "Read your game analytics",
  get_private_analytics_dimensions: "Find analytics breakdowns",
  query_private_analytics: "Read private game data",
  create_private_analytics_chart: "Chart private analytics",
  save_project_context: "Save project context",
  save_asset_plan: "Save asset plan",
  list_asset_plans: "Find saved plans",
  read_asset_plan: "Read asset plan",
  estimate_game_earnings: "Estimate earnings",
  research_game_idea: "Check similar games",
  get_game_history: "Read game history",
  compare_game_history: "Compare recorded game activity",
  suggest_game_peers: "Find comparable games",
  get_market_analysis: "Analyze market patterns",
  load_skill: "Read skill guide",
  get_metric_definitions: "Read metric definitions",
  search_games: "Search games",
  get_game_stats: "Get game stats",
  resolve_game_link: "Resolve game link",
  get_roblox_charts: "Get Roblox chart",
  create_chart: "Create chart",
};

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  label: string;
  /** What's happening, in words, while the call runs. */
  activity: string;
  detail: string;
};

export type ToolOutcome =
  | { ok: true; result: unknown; summary: string; chart?: ChartSpec; plan?: SavedPlanCard; project?: ProjectBrief; brief?: ImplementationBrief; chatOffer?: { reason: string } }
  | { ok: false; error: string };

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function describe(name: string, args: Record<string, unknown>): { activity: string; detail: string } {
  switch (name) {
    case "create_implementation_brief":
      return { activity: "Preparing a copyable implementation brief", detail: String(args.title ?? "") };
    case "offer_chat_continuation":
      return { activity: "Preparing chat continuation", detail: "" };
    case "list_my_linked_games":
      return { activity: "Finding your linked games", detail: "" };
    case "get_private_analytics_catalog":
      return { activity: "Checking supported private analytics", detail: String(args.metric ?? args.category ?? "all categories") };
    case "get_private_game_overview":
      return { activity: "Reading your private daily analytics", detail: "" };
    case "get_private_analytics_dimensions":
      return { activity: "Discovering your game's analytics breakdowns", detail: String(args.metric ?? "") };
    case "query_private_analytics":
      return { activity: "Reading your game's private data", detail: String(args.metric ?? "") };
    case "create_private_analytics_chart":
      return { activity: "Charting your private analytics", detail: String(args.title ?? "") };
    case "save_project_context":
      return { activity: "Saving the game plan", detail: String(args.name ?? "") };
    case "save_asset_plan":
      return { activity: "Saving a written asset plan", detail: String(args.title ?? "") };
    case "list_asset_plans":
      return { activity: "Finding this project's plans", detail: "" };
    case "read_asset_plan":
      return { activity: "Reading a saved plan", detail: "" };
    case "estimate_game_earnings":
      return { activity: "Estimating earnings from CCU and genre", detail: `${args.days ?? 30} days` };
    case "research_game_idea":
      return { activity: "Checking existing games", detail: String(args.title ?? "") };
    case "get_market_analysis":
      return { activity: "Comparing genres and game patterns", detail: String(args.pattern ?? "all patterns") };
    case "load_skill":
      return { activity: "Reading the assistant's skill guide", detail: String(args.skill ?? "") };
    case "search_games": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      return { activity: `Searching for "${query}"`, detail: `"${query}"` };
    }
    case "get_game_stats": {
      const ids = Array.isArray(args.universeIds) ? args.universeIds : [];
      return {
        activity: `Getting stats for ${ids.length} ${ids.length === 1 ? "game" : "games"}`,
        detail: `universe ${ids.join(", ")}`,
      };
    }
    case "resolve_game_link": {
      const link = typeof args.link === "string" ? args.link : "";
      return { activity: "Resolving the game link", detail: link.length > 60 ? `${link.slice(0, 57)}…` : link };
    }
    case "get_roblox_charts": {
      const name = ROBLOX_CHARTS[args.chart as RobloxChartId] ?? String(args.chart ?? "");
      return { activity: `Checking Roblox's ${name} chart`, detail: name };
    }
    case "create_chart": {
      const kind = typeof args.type === "string" ? args.type.replace("_", " ") : "chart";
      const title = typeof args.title === "string" ? args.title : "";
      return { activity: `Building a ${kind} chart`, detail: title };
    }
    default:
      return { activity: `Running ${name}`, detail: "" };
  }
}

/** Parses the model's arguments and describes the call, so it can be shown before it runs. */
export function prepareCall(name: string, rawArgs: string): ToolCall {
  const args = parseArgs(rawArgs);
  return { name, args, label: LABELS[name] ?? name, ...describe(name, args) };
}

/** The assistant and MCP share validated data tools; chart rendering stays local to chat. */
export async function runTool({ name, args }: ToolCall, data: FetchedData): Promise<ToolOutcome> {
  try {
    if (name === "create_implementation_brief") {
      const parsed = implementationBriefSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: "Supply a title, context, goal, requirements and acceptance criteria within the brief limits." };
      return { ok: true, result: { prepared: true, title: parsed.data.title }, summary: "Implementation brief ready to copy", brief: parsed.data };
    }
    if (name === "offer_chat_continuation") {
      const parsed = chatOfferSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: "Supply a short reason only." };
      return { ok: true, result: { offered: true }, summary: "Chat continuation offered", chatOffer: parsed.data };
    }
    if (isPublicTool(name)) return { ok: true, ...await runPublicTool(name, args) };
    if (name !== "create_chart") return { ok: false, error: "Unknown tool." };
    const built = buildChart(args, data);
    if (!built.ok) return { ok: false, error: built.error };
    return {
      ok: true,
      result: { rendered: true, type: built.chart.kind, title: built.chart.title, chartColors: built.chartColors },
      summary: built.summary,
      chart: built.chart,
    };
  } catch (error) {
    return { ok: false, error: publicToolError(error) };
  }
}
