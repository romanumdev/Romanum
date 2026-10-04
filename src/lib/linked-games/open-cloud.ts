import { z } from "zod";

// Analytics queries support OAuth Bearer tokens with universe.analytics:read, confirmed in Roblox's
// reference/cloud/openapi.json. Previously saved owner keys remain supported during explicit reconnection.
// Bodies, polling allowlists and request bounds are identical for both credentials.

export const OPEN_CLOUD = {
  analytics: "https://apis.roblox.com/analytics-query-api/",
  introspect: "https://apis.roblox.com/api-keys/v1/introspect",
} as const;

const TIMEOUT_MS = 15_000;
/** Polls of a long-running query before giving up; with the backoff below, about a minute. */
const POLL_LIMIT = 10;

export type OpenCloudFailure = "key_rejected" | "rate_limited" | "bad_request" | "unavailable";

export class OpenCloudError extends Error {
  kind: OpenCloudFailure;
  constructor(kind: OpenCloudFailure, message: string) {
    super(message);
    this.name = "OpenCloudError";
    this.kind = kind;
  }
}

export type OpenCloudOptions = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal };
export type AnalyticsCredential = string | { accessToken: string };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function call(request: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await request(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    signal?.throwIfAborted();
    throw new OpenCloudError("unavailable", "Couldn't reach Roblox.");
  }
  if (response.status === 401 || response.status === 403) throw new OpenCloudError("key_rejected", "Roblox rejected this game's analytics access. Reconnect through Roblox.");
  if (response.status === 429) throw new OpenCloudError("rate_limited", "Roblox is rate limiting this connection. Try again in a minute.");
  if (response.status === 404) throw new OpenCloudError("bad_request", "Roblox couldn't find that game.");
  if (response.status === 400) throw new OpenCloudError("bad_request", "Roblox refused the query.");
  if (!response.ok) throw new OpenCloudError("unavailable", `Roblox returned ${response.status}.`);
  // Bound responses before parsing or sending them to a model. Never echo upstream bodies in errors.
  if (Number(response.headers.get("content-length")) > 1_048_576) throw new OpenCloudError("bad_request", "The response is too large. Narrow the date range or breakdown.");
  const reader = response.body?.getReader();
  if (!reader) throw new OpenCloudError("unavailable", "Roblox sent an empty answer.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new OpenCloudError("bad_request", "The response is too large. Narrow the date range or breakdown.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof OpenCloudError) throw error;
    throw new OpenCloudError("unavailable", "Roblox sent an unexpected answer.");
  } finally {
    reader.releaseLock();
  }
}

const operation = z.object({
  path: z.string().optional(),
  done: z.boolean(),
  response: z.unknown().optional(),
  error: z.object({ code: z.number().optional() }).optional(),
});

export type AnalyticsFilter = { dimension: string; values: string[]; operation: "In" | "NotIn" | "GreaterThan" | "GreaterThanOrEqual" | "LessThan" | "LessThanOrEqual" | "Match" };
export type AnalyticsQuery = { metric: string; granularity: string; startTime: string; endTime: string; breakdown?: string[]; filter?: AnalyticsFilter[]; limit?: number };
export type DimensionQuery = Omit<AnalyticsQuery, "granularity" | "breakdown"> & { dimensions: string[] };
const dimensionValue = z.object({ value: z.string().max(512), displayValue: z.string().max(512).nullish() });
const seriesSchema = z.object({
  values: z.array(z.object({
    breakdowns: z.array(dimensionValue.extend({ dimension: z.string().max(100) })).max(8).default([]),
    dataPoints: z.array(z.object({ time: z.iso.datetime({ offset: true }), value: z.number().nullish(), stringValues: z.array(z.string().max(512)).max(100).nullish(), status: z.string().max(80).nullish() })).max(50_000),
  })).max(1000),
});
const dimensionsSchema = z.object({ values: z.array(z.object({ dimension: z.string().max(100), values: z.array(dimensionValue).max(1000) })).max(8) });
export type AnalyticsSeries = z.infer<typeof seriesSchema>["values"][number];
export type AnalyticsDimension = z.infer<typeof dimensionsSchema>["values"][number];

async function queryOperation<T>(apiKey: AnalyticsCredential, universeId: number, endpoint: "metrics" | "dimension-values", body: AnalyticsQuery | DimensionQuery, schema: z.ZodType<T>, options: OpenCloudOptions): Promise<T> {
  if (!Number.isSafeInteger(universeId) || universeId <= 0) throw new OpenCloudError("bad_request", "Invalid universe ID.");
  const request = options.fetch ?? fetch;
  const signal = options.signal;
  const headers = { ...(typeof apiKey === "string" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey.accessToken}` }), "content-type": "application/json", accept: "application/json" };
  const pollPath = new RegExp(`^v1/universes/${universeId}/operations/${endpoint}/[\\w.~-]{1,200}$`);
  let result = operation.safeParse(await call(request, `${OPEN_CLOUD.analytics}v1/universes/${universeId}/${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) }, signal));
  for (let poll = 0; result.success && !result.data.done; poll++) {
    const path = result.data.path?.replace(/^\//, "");
    if (poll >= POLL_LIMIT || !path || !pollPath.test(path)) throw new OpenCloudError("unavailable", "Roblox took too long to answer or sent an invalid operation.");
    signal?.throwIfAborted();
    const delay = Math.min(1000 * 2 ** poll, 8000);
    if (options.sleep) await options.sleep(delay);
    else if (signal) await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, delay);
      signal.addEventListener("abort", aborted, { once: true });
    });
    else await wait(delay);
    result = operation.safeParse(await call(request, `${OPEN_CLOUD.analytics}${path}`, { headers }, signal));
  }
  if (!result.success) throw new OpenCloudError("unavailable", "Roblox sent an unexpected answer.");
  if (result.data.error) {
    const code = result.data.error.code;
    throw new OpenCloudError(code === 3000 ? "rate_limited" : code === 2001 ? "bad_request" : "unavailable", "Roblox couldn't answer the query. Check its supported dimensions and date range.");
  }
  const response = schema.safeParse(result.data.response);
  if (!response.success) throw new OpenCloudError("unavailable", "Roblox sent an unexpected answer.");
  return response.data;
}

/** Numeric or text-valued series, preserving every breakdown, missing value and point status. */
export async function queryAnalytics(apiKey: AnalyticsCredential, universeId: number, query: AnalyticsQuery, options: OpenCloudOptions = {}): Promise<AnalyticsSeries[]> {
  return (await queryOperation(apiKey, universeId, "metrics", query, seriesSchema, options)).values;
}

/** Raw values (used for filters) and human labels, including creator-defined funnel names and steps. */
export async function queryDimensionValues(apiKey: AnalyticsCredential, universeId: number, query: DimensionQuery, options: OpenCloudOptions = {}): Promise<AnalyticsDimension[]> {
  return (await queryOperation(apiKey, universeId, "dimension-values", query, dimensionsSchema, options)).values;
}

export type DailyValue = { day: string; value: number; status: string | null };

/**
 * One metric's daily values for a game, from `start` (inclusive) to `end` (exclusive), both UTC midnights. Polls
 * the query while Roblox runs it as a long-running operation.
 */
export async function queryDailyMetric(
  apiKey: AnalyticsCredential,
  universeId: number,
  metric: string,
  range: { start: Date; end: Date },
  options: OpenCloudOptions = {},
): Promise<DailyValue[]> {
  const values = await queryAnalytics(apiKey, universeId, { metric, granularity: "OneDay", startTime: range.start.toISOString(), endTime: range.end.toISOString() }, options);
  // Without a breakdown, the answer is a single series.
  return (values[0]?.dataPoints ?? []).flatMap((point) => {
    const day = point.time.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && typeof point.value === "number" && Number.isFinite(point.value)
      ? [{ day, value: point.value, status: point.status ?? null }]
      : [];
  });
}

const introspection = z.object({
  enabled: z.boolean().nullish(),
  expired: z.boolean().nullish(),
  expirationTimeUtc: z.string().nullish(),
  scopes: z
    .array(z.object({ name: z.string(), operations: z.array(z.string()).nullish(), universeIds: z.array(z.string()).nullish() }))
    .nullish(),
});

export type KeyInfo = {
  enabled: boolean | null;
  expired: boolean | null;
  expiresAt: string | null;
  /** The experiences the key can read analytics for ("*" for all), or null when Roblox doesn't say. */
  analyticsUniverseIds: string[] | null;
};

/**
 * What Roblox reports about an API key. Null when introspection fails or answers in an unfamiliar shape: linking then
 * relies on a test query instead.
 */
export async function introspectKey(apiKey: string, options: OpenCloudOptions = {}): Promise<KeyInfo | null> {
  try {
    const parsed = introspection.safeParse(
      await call(options.fetch ?? fetch, OPEN_CLOUD.introspect, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ apiKey }),
      }),
    );
    if (!parsed.success) return null;
    const scope = parsed.data.scopes?.find((item) => /analytics/i.test(item.name) && (item.operations ?? []).includes("read"));
    const expiry = parsed.data.expirationTimeUtc ? new Date(parsed.data.expirationTimeUtc) : null;
    return {
      enabled: parsed.data.enabled ?? null,
      expired: parsed.data.expired ?? null,
      expiresAt: expiry && !Number.isNaN(expiry.valueOf()) ? expiry.toISOString() : null,
      analyticsUniverseIds: scope?.universeIds ?? null,
    };
  } catch {
    return null;
  }
}
