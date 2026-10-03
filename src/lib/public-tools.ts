import { z } from "zod";
import { publicData, MARKET_CHARTS, type PublicDataService } from "./public-data.ts";
import { ROBLOX_CHART_IDS, ROBLOX_CHARTS } from "./roblox.ts";
import { PATTERNS } from "./market-analysis.ts";
import { SKILL_CATALOG } from "./skill-catalog.ts";
import { loadSkill } from "./assistant/skills.ts";
import { METRIC_DEFINITIONS } from "./metric-definitions.ts";
import { HISTORY_INPUT } from "./history/service.ts";
import { IDEA_RESEARCH_INPUT, researchGameIdea } from "./idea-research.ts";
import { currentEarnings, EARNINGS_MODEL_VERSION, GENRE_RATES } from "./analytics/earnings.ts";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const PUBLIC_TOOLS = {
  estimate_game_earnings: {
    description: "Calculate low/high NET Earned Robux and pre-tax standard DevEx USD estimates from current public CCU and Romanum's published genre assumptions over 1–366 days. This is a constant-CCU projection, not actual revenue, historical earnings or a confidence interval. No database, private data or paid model call is needed. Use this before charting estimatedRobuxLow and estimatedRobuxHigh together.",
    schema: z.object({ universeIds: z.array(positiveId).min(1).max(10), days: z.number().int().min(1).max(366).default(30) }).strict(),
  },
  research_game_idea: {
    description: "Research possible competitors when the user requests research or a recommendation depends on novelty, competition or market opportunity. Search a proposed title and one or two mechanic/fantasy phrases for existing Roblox games. Pure brainstorming and brief corrections do not require this lookup. Returns candidate competitors, query coverage, sponsored status and observation timestamps. Search is incomplete and cannot prove novelty, demand, causes of success or that existing games are worse. Reuse relevant results; avoid repeating failed searches without a material new question. No AI/model cost.",
    schema: IDEA_RESEARCH_INPUT,
  },
  get_game_history: {
    description: "Read Romanum's recorded public player counts, visits, votes and chart positions for a universe over 1–30 days. Actual retrieval timestamps only; null points identify collection gaps or games not sampled. No data exists before collection began. Never infer retention or revenue from these observations.",
    schema: HISTORY_INPUT,
  },
  search_games: {
    description: "Search public Roblox experiences by name. Up to 10 matches with IDs, current players, votes, icons and sponsored status.",
    schema: z.object({ query: z.string().trim().min(1).max(80) }).strict(),
  },
  get_game_stats: {
    description: "Fetch public statistics for 1–10 universe IDs, including players, visits, votes, favorites, genre and icons. Use multiple IDs for comparisons. No private metrics or history.",
    schema: z.object({ universeIds: z.array(positiveId).min(1).max(10) }).strict(),
  },
  resolve_game_link: {
    description: "Resolve a roblox.com/games/<placeId> URL or numeric place ID to an experience's universe ID.",
    schema: z.object({ link: z.string().trim().min(1).max(300) }).strict(),
  },
  get_roblox_charts: {
    description: "Retrieve a current Roblox chart in its original order. Top Earning is a ranking without revenue figures; sponsored status is included.",
    schema: z.object({ chart: z.enum(ROBLOX_CHART_IDS), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  },
  get_market_analysis: {
    description: "Summarize genres and title patterns across four deduplicated Roblox chart samples. Includes coverage, concentration and per-chart freshness. Title matches are heuristic, not verified gameplay or historical growth.",
    schema: z.object({ pattern: z.enum(["all", ...PATTERNS.map((pattern) => pattern.id)]).default("all") }).strict(),
  },
  load_skill: {
    description: "Read a registered Romanum guide for genre research, game design, teardowns, economy, onboarding, thumbnails or UI workflows. Guides define methods, not live statistics or authority to spend or publish.",
    schema: z.object({ skill: z.enum(SKILL_CATALOG.map((skill) => skill.id)) }).strict(),
  },
  get_metric_definitions: {
    description: "Read metric units, ID definitions, data freshness semantics and coverage limitations before interpreting Roblox statistics.",
    schema: z.object({}).strict(),
  },
} as const;

export type PublicToolName = keyof typeof PUBLIC_TOOLS;
export function isPublicTool(name: string): name is PublicToolName {
  return Object.hasOwn(PUBLIC_TOOLS, name);
}

export class PublicInputError extends Error {}

export function parsePlaceId(link: string): number {
  let raw = link;
  if (!/^\d+$/.test(raw)) {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`); } catch { throw new PublicInputError("Use a Roblox game URL or numeric place ID."); }
    if (!["https:", "http:"].includes(url.protocol) || !["roblox.com", "www.roblox.com"].includes(url.hostname) || url.username || url.password || url.port) {
      throw new PublicInputError("Use a roblox.com game URL.");
    }
    raw = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d+)(?:\/|$)/i)?.[1] ?? "";
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new PublicInputError("Use a valid positive place ID.");
  return id;
}

export async function runPublicTool(name: PublicToolName, input: unknown, service: PublicDataService = publicData): Promise<{ result: Record<string, unknown>; summary: string }> {
  switch (name) {
    case "estimate_game_earnings": {
      const { universeIds, days } = PUBLIC_TOOLS[name].schema.parse(input);
      const observation = await service.stats(universeIds);
      const games = observation.games.map((game) => {
        const estimate = currentEarnings(game, days);
        return { ...game, estimatedEarnings: estimate, estimatedRobuxLow: estimate?.robux.low ?? null, estimatedRobuxHigh: estimate?.robux.high ?? null };
      });
      return { result: { ...observation, kind: "estimate", modelVersion: EARNINGS_MODEL_VERSION, estimateDays: days,
        method: "/analytics/earnings-method", genreRates: GENRE_RATES,
        assumptions: "Current CCU held constant for the entire period. Genre rates are uncalibrated heuristic net Robux/player-hour bands, not measured averages or confidence intervals. Standard DevEx only. No actual/private earnings are disclosed.", games },
        summary: `${games.length} game earnings estimates · ${days} days` };
    }
    case "research_game_idea": {
      const result = await researchGameIdea(input, service);
      return { result, summary: `${result.games.length} candidate competitors; search ${result.status}` };
    }
    case "get_game_history": {
      const args = PUBLIC_TOOLS[name].schema.parse(input);
      const result = await service.history(args);
      return { result, summary: `${result.sampleCount} historical observations` };
    }
    case "search_games": {
      const { query } = PUBLIC_TOOLS[name].schema.parse(input);
      const result = await service.search(query);
      return { result, summary: `${result.games.length} games found` };
    }
    case "get_game_stats": {
      const { universeIds } = PUBLIC_TOOLS[name].schema.parse(input);
      const result = await service.stats(universeIds);
      return { result, summary: `${result.games.length} games retrieved` };
    }
    case "resolve_game_link": {
      const { link } = PUBLIC_TOOLS[name].schema.parse(input);
      const result = await service.resolve(parsePlaceId(link));
      return { result, summary: `Place ${result.placeId} → universe ${result.universeId}` };
    }
    case "get_roblox_charts": {
      const { chart, limit } = PUBLIC_TOOLS[name].schema.parse(input);
      const observation = await service.chart(chart);
      const result = { ...observation, chart: ROBLOX_CHARTS[chart], totalAvailable: observation.games.length, games: observation.games.slice(0, limit) };
      return { result, summary: `${result.chart}: ${result.games.length} games` };
    }
    case "get_market_analysis": {
      const { pattern } = PUBLIC_TOOLS[name].schema.parse(input);
      const { analysis, observations } = await service.market();
      if (!observations.length) throw new Error("Roblox charts are unavailable.");
      const selected = analysis.patterns.filter((item) => pattern === "all" || item.id === pattern);
      const examples = selected.flatMap((item) => item.games.slice(0, 8));
      const games = [...new Map(examples.map((game) => [game.universeId, game])).values()];
      return {
        result: {
          source: "https://www.roblox.com/charts", assembledAt: analysis.assembledAt,
          fetchedAt: observations.map((item) => item.fetchedAt).sort()[0], expiresAt: observations.map((item) => item.expiresAt).sort()[0],
          cacheWindowSeconds: 120, requestedCharts: MARKET_CHARTS, observations,
          availableCharts: analysis.availableCharts, unavailableCharts: analysis.unavailableCharts,
          sampleSize: analysis.sampleSize, samplePlayers: analysis.samplePlayers, genres: analysis.genres,
          patterns: selected.map(({ games: members, ...item }) => ({ ...item, exampleUniverseIds: members.slice(0, 8).map((game) => game.universeId) })),
          games, limitations: `${METRIC_DEFINITIONS.coverage} No historical growth, revenue, retention or demographics. Examples are limited to eight games per pattern. Shares are fractions from 0 to 1.`,
        },
        summary: `${selected.length} patterns across ${analysis.sampleSize} games`,
      };
    }
    case "load_skill": {
      const { skill: id } = PUBLIC_TOOLS[name].schema.parse(input);
      const skill = await loadSkill(id);
      return { result: { id: skill.id, name: skill.name, instructions: skill.instructions, source: `skills/${skill.id}/SKILL.md`, license: "Romanum Source-Available License 1.0", licenseUrl: "https://github.com/romanumdev/Romanum/blob/main/LICENSE" }, summary: `${skill.name} guide loaded` };
    }
    case "get_metric_definitions": {
      PUBLIC_TOOLS[name].schema.parse(input);
      return { result: METRIC_DEFINITIONS, summary: "Metric definitions loaded" };
    }
  }
}

export function publicToolError(error: unknown): string {
  if (error instanceof z.ZodError) return "Invalid arguments. Check the tool's input schema.";
  if (error instanceof PublicInputError) return error.message;
  return "Couldn't retrieve the requested data. Try again.";
}
