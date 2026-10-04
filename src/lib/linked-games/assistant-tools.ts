import { randomUUID } from "node:crypto";
import { z } from "zod";
import type OpenAI from "openai";
import type { Database } from "../history/database.ts";
import type { ToolCall, ToolOutcome } from "../assistant/tools.ts";
import type { ChartSpec } from "../charts/spec.ts";
import { colorHex, PALETTE_ORDER } from "../charts/spec.ts";
import { secretsKey } from "../secrets.ts";
import { analyticsAccess, listLinkedGames, openAnalyticsCredential, readGameMetrics } from "./store.ts";
import { queryAnalytics, queryDimensionValues, OpenCloudError, type AnalyticsCredential, type AnalyticsSeries, type OpenCloudOptions } from "./open-cloud.ts";
import { ANALYTICS_CATEGORIES, ANALYTICS_METRICS, CATEGORY_NOTES, CATALOG_CHECKED_AT, CATALOG_SOURCE, type AnalyticsMetric } from "./catalog.ts";

const DAY = 86_400_000;
const MAX_QUERIES = 24;
const MAX_SERIES = 24;
const MAX_POINTS = 1800;
const ACCESS_ERROR = "Private analytics unavailable. In Profile > Games, enable AI analysis and Collect analytics for your linked game. Reconnect if its key was rejected or expired.";
const filter = z.object({
  dimension: z.string().min(1).max(100),
  values: z.array(z.string().min(1).max(256)).min(1).max(20),
  operation: z.enum(["In", "NotIn", "GreaterThan", "GreaterThanOrEqual", "LessThan", "LessThanOrEqual", "Match"]).default("In"),
}).strict();
const date = z.iso.datetime({ offset: true });
const common = {
  gameId: z.uuid(),
  metric: z.string().min(1).max(100),
  startTime: date.optional().describe("Inclusive UTC timestamp; defaults to 14 days before the last UTC midnight."),
  endTime: date.optional().describe("Exclusive UTC timestamp; defaults to the last UTC midnight, excluding today's partial bucket."),
  filter: z.array(filter).max(5).default([]),
};
const schemas = {
  list_my_linked_games: z.object({}).strict(),
  get_private_analytics_catalog: z.object({ category: z.enum(ANALYTICS_CATEGORIES).optional(), metric: z.string().max(100).optional() }).strict(),
  get_private_game_overview: z.object({ gameId: z.uuid() }).strict(),
  get_private_analytics_dimensions: z.object({ ...common, dimensions: z.array(z.string().min(1).max(100)).min(1).max(3) }).strict(),
  query_private_analytics: z.object({ ...common, granularity: z.enum(["None", "OneMinute", "HalfHour", "OneHour", "OneDay", "OneWeek", "OneMonth"]).optional(), breakdown: z.array(z.string().min(1).max(100)).max(2).default([]) }).strict(),
  create_private_analytics_chart: z.object({ queryId: z.uuid(), type: z.enum(["line", "bar"]), title: z.string().trim().min(1).max(80) }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  list_my_linked_games: "List only the signed-in account's linked games and private-analysis availability. Use first for 'my game'; never ask for a key in chat or use a public game ID as authorisation. If more than one game could fit, ask which one. Disabled games need AI analysis enabled in Profile > Games.",
  get_private_analytics_catalog: "Discover all Roblox owner Analytics Query API categories and metrics, or one category/metric's supported dimensions, granularities and history window. Catalog metadata describes capability, not game measurements. Use before unfamiliar queries. Includes funnels, client/server performance, monetization, engagement, retention, acquisition, economy, custom events, thumbnails and platform service metrics.",
  get_private_game_overview: "Read this authorised game's eight cached daily metrics (players, sessions, playtime, retention and measured revenue), with sync time and original point statuses. A useful baseline for a comprehensive review. It is cached, not a fresh Roblox query; drill down with query_private_analytics.",
  get_private_analytics_dimensions: "Discover actual raw dimension values and display labels for a linked game, e.g. FunnelName, FunnelStep, Platform, PlaceVersion, CustomEventName, CurrencyType or ProductKey. Do not guess these values. Filter FunnelName before discovering its steps. Up to three dimensions; the same bounded UTC date range and filters apply as metric queries.",
  query_private_analytics: "Read one private metric for this account's AI-enabled linked game, optionally by up to two supported dimensions and five filters using discovered raw values. Preserves missing values and projected/noisy statuses. Dates are inclusive start/exclusive end; default last 14 completed UTC days. Defaults to OneDay if supported, otherwise None. Maximum 366-day range and metric-specific retention; OneMinute max 6 hours, HalfHour/OneHour max 7 days. At most 24 upstream queries per answer. Funnel totals/churn need None, a FunnelName filter and FunnelStep breakdown. Returned queryId can render a private chart. Numeric values keep Roblox's native scale; do not guess percentage scaling or metric units. These are measured owner analytics, separate from public estimates.",
  create_private_analytics_chart: "Render a line or bar chart from a successful numeric private query in this answer, identified by queryId. Values come exclusively from that query, never from model arguments. Line needs time buckets; bar needs granularity None. Shows up to eight breakdown series and preserves gaps. Native API numeric scale is unchanged; it does not infer percentage units. Text-valued metrics cannot be plotted.",
};
type Snapshot = { universeId: number; version: number };
type ReadQuery = { gameId: string; metric: string; startTime?: string; endTime?: string; filter: z.infer<typeof filter>[] };
type SavedQuery = { gameId: string; access: Snapshot; metric: AnalyticsMetric; granularity: string; series: AnalyticsSeries[]; startTime: string; endTime: string; truncated: boolean };
export type PrivateAnalyticsTools = {
  definitions: OpenAI.Chat.ChatCompletionFunctionTool[];
  execute: (call: ToolCall, callId: string) => Promise<ToolOutcome>;
  /** Recheck consent immediately before retrieved information is sent to the provider again. */
  checkAccess: () => Promise<void>;
};

function queryRange(input: ReadQuery, metric: AnalyticsMetric, now: Date, granularity?: string) {
  const today = Math.floor(now.getTime() / DAY) * DAY;
  const end = input.endTime ? Date.parse(input.endTime) : today;
  const start = input.startTime ? Date.parse(input.startTime) : end - 14 * DAY;
  const maximumDays = Math.min(366, metric.retentionDays);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > now.getTime() || start < today - metric.retentionDays * DAY || end - start > maximumDays * DAY) {
    throw new OpenCloudError("bad_request", `Use a past range up to ${maximumDays} days, within this metric's ${metric.retentionDays}-day history window.`);
  }
  if (granularity === "OneMinute" && end - start > 6 * 3_600_000) throw new OpenCloudError("bad_request", "Minute queries are limited to six hours.");
  if (["HalfHour", "OneHour"].includes(granularity ?? "") && end - start > 7 * DAY) throw new OpenCloudError("bad_request", "Half-hour and hourly queries are limited to seven days.");
  const dimensions = input.filter.map(item => item.dimension);
  if (new Set(dimensions).size !== dimensions.length || dimensions.some(dimension => !metric.dimensions.includes(dimension))) throw new OpenCloudError("bad_request", "Choose distinct filters from this metric's supported dimensions.");
  for (const item of input.filter) {
    if (!["In", "NotIn"].includes(item.operation) && item.values.length !== 1) throw new OpenCloudError("bad_request", "Comparison and pattern filters take one value.");
  }
  return { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() };
}

function boundedSeries(input: AnalyticsSeries[], startTime: string, endTime: string, granularity: string) {
  let remaining = MAX_POINTS; let truncated = input.length > MAX_SERIES;
  const start = Date.parse(startTime), end = Date.parse(endTime);
  const series = input.slice(0, MAX_SERIES).map(value => {
    // Roblox labels buckets by their UTC start, which can precede an unaligned query window.
    // Keep overlapping buckets; None is the API's aggregate for the requested range.
    const points = value.dataPoints.filter(point => {
      if (granularity === "None") return true;
      const at = Date.parse(point.time);
      const span = ({ OneMinute: 60_000, HalfHour: 1_800_000, OneHour: 3_600_000, OneDay: DAY, OneWeek: 7 * DAY } as Record<string, number>)[granularity];
      const bucketEnd = granularity === "OneMonth" ? Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, 1) : at + span;
      return at < end && bucketEnd > start;
    }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const dataPoints = points.slice(0, remaining).map(point => ({
      time: point.time, value: point.stringValues != null ? null : point.value ?? null,
      ...(point.stringValues ? { stringValues: point.stringValues } : {}), status: point.status ?? null,
    }));
    truncated ||= points.length > dataPoints.length;
    remaining -= dataPoints.length;
    return { breakdowns: value.breakdowns, dataPoints };
  });
  return { series, truncated };
}

/** Construct only after the route has verified that accountId belongs to the credit owner. No keys leave this closure. */
export function privateAnalyticsTools(database: Database, accountId: string, signal: AbortSignal, options: OpenCloudOptions & { secretsKey?: Buffer; now?: Date } = {}): PrivateAnalyticsTools {
  const snapshots = new Map<string, Snapshot>();
  const queries = new Map<string, SavedQuery>();
  let queryCount = 0;
  let lastQueryAt = 0;
  // Sequential requests avoid bursts when the model asks for several metrics together.
  let queue: Promise<unknown> = Promise.resolve();
  const access = async (gameId: string, expected?: Snapshot): Promise<Snapshot> => {
    signal.throwIfAborted();
    const current = await analyticsAccess(database, accountId, gameId);
    if (!current || (expected && (current.version !== expected.version || current.universeId !== expected.universeId))) throw new OpenCloudError("key_rejected", ACCESS_ERROR);
    return current;
  };
  const checkAccess = async () => { for (const [id, snapshot] of snapshots) await access(id, snapshot); };
  const upstream = async <T>(gameId: string, run: (apiKey: AnalyticsCredential, universeId: number, options: OpenCloudOptions) => Promise<T>) => {
    if (++queryCount > MAX_QUERIES) throw new OpenCloudError("bad_request", "This answer reached its 24-query limit. Summarise the available evidence and continue in a follow-up.");
    const execute = async () => {
      options.signal?.throwIfAborted();
      const delay = Math.max(0, lastQueryAt + 2500 - Date.now());
      if (delay) {
        if (options.sleep) await options.sleep(delay);
        else await new Promise<void>((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, delay);
          signal.addEventListener("abort", aborted, { once: true });
        });
      }
      const snapshot = await access(gameId);
      const apiKey = await openAnalyticsCredential(database, accountId, gameId, snapshot.version, options.secretsKey ?? await secretsKey(), { fetch: options.fetch, signal });
      if (!apiKey) throw new OpenCloudError("key_rejected", ACCESS_ERROR);
      await access(gameId, snapshot);
      lastQueryAt = Date.now();
      const value = await run(apiKey, snapshot.universeId, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
      // A deletion, relink, opt-out or collection change while Roblox answers discards the result.
      await access(gameId, snapshot);
      snapshots.set(gameId, snapshot);
      return { value, snapshot };
    };
    const pending = queue.then(execute);
    queue = pending.catch(() => {});
    return pending;
  };
  const names = Object.keys(schemas) as (keyof typeof schemas)[];
  return {
    definitions: names.map(name => ({ type: "function", function: { name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name], { target: "draft-7", io: "input" }) } })),
    checkAccess,
    async execute(call) {
      if (signal.aborted) return { ok: false, error: "Stopped." };
      const name = call.name as keyof typeof schemas;
      if (!names.includes(name)) return { ok: false, error: "Unknown private analytics tool." };
      const parsed = schemas[name].safeParse(call.args);
      if (!parsed.success) return { ok: false, error: "Invalid private analytics arguments. Check the catalog and use UTC timestamps." };
      try {
        if (options.signal?.aborted && (name === "query_private_analytics" || name === "get_private_analytics_dimensions")) return { ok: false, error: "This live request has reached its lookup time limit. Continue the full review in Chats, which runs in the background." };
        if (name === "list_my_linked_games") {
          const linked = await listLinkedGames(database, accountId);
          const games = linked.map(game => ({ gameId: game.id, universeId: game.universeId, aiAnalysis: game.aiAnalysis, collect: game.collect, connectionStatus: game.status, syncedAt: game.syncedAt, available: game.aiAnalysis && game.collect && game.status === "active" && (!game.keyExpiresAt || Date.parse(game.keyExpiresAt) > Date.now()) }));
          return { ok: true, result: { scope: "private_owner", games, settings: "/profile#games" }, summary: `${games.length} linked games` };
        }
        if (name === "get_private_analytics_catalog") {
          const { category, metric } = parsed.data as z.infer<typeof schemas.get_private_analytics_catalog>;
          const found = metric ? ANALYTICS_METRICS.get(metric) : null;
          if (metric && !found) return { ok: false, error: "Unknown metric. Read the catalog for its exact identifier." };
          const metrics = found ? [found] : [...ANALYTICS_METRICS.values()].filter(item => !category || item.category === category);
          return { ok: true, result: { source: CATALOG_SOURCE, checkedAt: CATALOG_CHECKED_AT, categories: ANALYTICS_CATEGORIES, notes: category ? CATEGORY_NOTES[category] : CATEGORY_NOTES, metrics: category || metric ? metrics : metrics.map(item => ({ id: item.id, label: item.label, category: item.category })) }, summary: `${metrics.length} supported metrics` };
        }
        if (name === "get_private_game_overview") {
          const { gameId } = parsed.data as { gameId: string };
          const snapshot = await access(gameId);
          const metrics = await readGameMetrics(database, accountId, gameId);
          const linked = (await listLinkedGames(database, accountId)).find(game => game.id === gameId);
          await access(gameId, snapshot);
          snapshots.set(gameId, snapshot);
          const recent = Object.fromEntries(Object.entries(metrics).map(([id, points]) => [id, points.slice(-30)]));
          return { ok: true, result: { scope: "private_owner", source: "Roblox Analytics Query API · cached", gameId, universeId: snapshot.universeId, syncedAt: linked?.syncedAt, syncError: linked?.syncError, metrics: recent, numericScale: "Roblox native; percentage scale is not inferred", available: Object.values(recent).some(points => points.length > 0) }, summary: "Private daily overview" };
        }
        if (name === "create_private_analytics_chart") {
          const input = parsed.data as z.infer<typeof schemas.create_private_analytics_chart>;
          const saved = queries.get(input.queryId);
          if (!saved) return { ok: false, error: "Query not found in this answer. Fetch private analytics first." };
          await access(saved.gameId, saved.access);
          const chart = buildPrivateChart(saved, input.type, input.title);
          if (!chart) return { ok: false, error: "Use line for at least two time buckets or bar for a None query, with numeric observations. Do not plot text metrics." };
          return { ok: true, result: { rendered: true, scope: "private_owner", queryId: input.queryId }, chart, summary: input.title };
        }
        const input = parsed.data as z.infer<typeof schemas.query_private_analytics> & z.infer<typeof schemas.get_private_analytics_dimensions>;
        const metric = ANALYTICS_METRICS.get(input.metric);
        if (!metric) return { ok: false, error: "Unknown metric. Read the private catalog for its exact identifier." };
        const granularity = input.granularity ?? (metric.granularities.includes("OneDay") ? "OneDay" : "None");
        if (name === "query_private_analytics" && !metric.granularities.includes(granularity)) return { ok: false, error: `${input.metric} supports ${metric.granularities.join(", ")}.` };
        const range = queryRange(input, metric, options.now ?? new Date(), name === "query_private_analytics" ? granularity : undefined);
        const chosen = name === "query_private_analytics" ? input.breakdown : input.dimensions;
        if (new Set(chosen).size !== chosen.length || chosen.some(dimension => !metric.dimensions.includes(dimension))) return { ok: false, error: "Use distinct dimensions supported by this metric. Read its catalog entry." };
        const commonQuery = { metric: input.metric, ...range, ...(input.filter.length ? { filter: input.filter } : {}) };
        if (name === "get_private_analytics_dimensions") {
          const { value, snapshot } = await upstream(input.gameId, (key, universeId, opts) => queryDimensionValues(key, universeId, { ...commonQuery, dimensions: input.dimensions, limit: 50 }, opts));
          const dimensions = value.filter(dimension => chosen.includes(dimension.dimension)).map(dimension => ({ ...dimension, values: dimension.values.slice(0, 50) }));
          return { ok: true, result: { scope: "private_owner", source: "Roblox Analytics Query API", universeId: snapshot.universeId, gameId: input.gameId, metric: input.metric, ...range, dimensions, limitedTo: 50, truncated: value.some(dimension => dimension.values.length > 50), empty: dimensions.every(dimension => dimension.values.length === 0), note: "Use value for filters, displayValue for labels. Empty results mean no reported values in this window, not zero activity or proof that events were never instrumented." }, summary: "Private dimensions discovered" };
        }
        const { value, snapshot } = await upstream(input.gameId, (key, universeId, opts) => queryAnalytics(key, universeId, { ...commonQuery, granularity, ...(input.breakdown.length ? { breakdown: input.breakdown } : {}), ...(granularity === "None" && input.breakdown.length ? { limit: MAX_SERIES } : {}) }, opts));
        const bounded = boundedSeries(value, range.startTime, range.endTime, granularity);
        const queryId = randomUUID();
        const saved = { gameId: input.gameId, access: snapshot, metric, granularity, ...bounded, ...range };
        queries.set(queryId, saved);
        return { ok: true, result: { scope: "private_owner", source: "Roblox Analytics Query API", fetchedAt: (options.now ?? new Date()).toISOString(), gameId: input.gameId, universeId: snapshot.universeId, queryId, metric: input.metric, label: metric.label, granularity, ...range, filter: input.filter, breakdown: input.breakdown, ...bounded, numericScale: "Roblox native; percentage scale and units are not inferred", empty: bounded.series.every(series => series.dataPoints.every(point => point.value == null && !point.stringValues?.length)), notes: CATEGORY_NOTES[metric.category], limits: { series: MAX_SERIES, points: MAX_POINTS, topSeriesLimit: granularity === "None" && input.breakdown.length ? MAX_SERIES : null } }, summary: `${metric.label} · ${bounded.series.length} series` };
      } catch (error) {
        if (signal.aborted) return { ok: false, error: "Stopped." };
        if (options.signal?.aborted) return { ok: false, error: "This live request has reached its lookup time limit. Continue the full review in Chats, which runs in the background." };
        return { ok: false, error: error instanceof OpenCloudError ? error.message : "Private analytics unavailable. Try again later." };
      }
    },
  };
}

function buildPrivateChart(query: SavedQuery, kind: "line" | "bar", title: string): ChartSpec | null {
  if (!query.series.length || query.metric.id === "ThumbnailWinningSegments" || query.series.some(series => series.dataPoints.some(point => point.stringValues != null))) return null;
  const selected = query.series.slice(0, 8);
  const name = (series: AnalyticsSeries) => series.breakdowns.map(value => `${value.dimension}: ${value.displayValue ?? value.value}`).join(" · ") || query.metric.label;
  const source = `Roblox private analytics · UTC · ${query.metric.id} · native numeric scale${query.truncated || query.series.length > 8 ? " · partial results" : ""}${query.series.some(series => series.dataPoints.some(point => point.status && point.status !== "Valid")) ? " · includes provisional/noisy points" : ""}`;
  if (kind === "bar") {
    if (query.granularity !== "None" || selected.some(series => series.dataPoints.length > 1) || !selected.some(series => series.dataPoints[0]?.value != null)) return null;
    return { kind, title, source, categories: selected.map((series, index) => ({ key: String(index), label: name(series) })), series: [{ key: query.metric.id, label: query.metric.label, format: "full", values: selected.map(series => series.dataPoints[0]?.value ?? null) }], colors: { [query.metric.id]: colorHex("blue") }, colorBy: "series", size: "large" };
  }
  if (query.granularity === "None") return null;
  const times = [...new Set(selected.flatMap(series => series.dataPoints.map(point => Date.parse(point.time))))].sort((a, b) => a - b);
  // Include absent fixed-size buckets so the renderer does not bridge gaps as continuous observations.
  const step = ({ OneMinute: 60_000, HalfHour: 1_800_000, OneHour: 3_600_000, OneDay: DAY, OneWeek: 7 * DAY } as Record<string, number>)[query.granularity];
  if (step && times.length) {
    for (let at = times[0]; at <= times.at(-1)! && times.length < MAX_POINTS; at += step) if (!times.includes(at)) times.push(at);
    times.sort((a, b) => a - b);
  }
  if (query.granularity === "OneMonth" && times.length) {
    const end = times.at(-1)!;
    const month = new Date(times[0]);
    for (; month.getTime() <= end && times.length < MAX_POINTS; month.setUTCMonth(month.getUTCMonth() + 1)) if (!times.includes(month.getTime())) times.push(month.getTime());
    times.sort((a, b) => a - b);
  }
  if (times.length < 2 || !selected.some(series => series.dataPoints.filter(point => point.value != null).length >= 2)) return null;
  return { kind, title, source, categories: times.map(time => ({ key: String(time), label: new Date(time).toISOString().replace("T", " ").replace(".000Z", " UTC") })), series: selected.map((series, index) => {
    const values = new Map(series.dataPoints.map(point => [Date.parse(point.time), point.value ?? null]));
    return { key: String(index), label: name(series), format: "full", values: times.map(time => values.get(time) ?? null) };
  }), colors: Object.fromEntries(selected.map((_, index) => [String(index), colorHex(PALETTE_ORDER[index])])), colorBy: "series", size: "large" };
}
