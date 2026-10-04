import { isIP } from "node:net";
import { createMcpHandler, hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import { createRomanumServer } from "./server.ts";
import { createToolGate, RequestLimiter } from "./limits.ts";
import { publicData, type PublicDataService } from "../public-data.ts";
import type { McpToolUsageRecorder } from "./usage.ts";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function configuredUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
    throw new Error("MCP URLs must use HTTPS (HTTP is allowed on loopback only).");
  }
  return url;
}

export function createMcpEndpoint(options: {
  publicUrl?: string;
  allowedOrigins?: string[];
  clientIpHeader?: string;
  requestLimit?: number;
  now?: () => number;
  service?: PublicDataService;
  recordToolUsage?: McpToolUsageRecorder;
} = {}) {
  const publicUrl = options.publicUrl ? configuredUrl(options.publicUrl) : undefined;
  const allowedHosts = publicUrl ? [publicUrl.hostname] : LOOPBACK_HOSTS;
  const extraOrigins = (options.allowedOrigins ?? []).map((value) => configuredUrl(value).origin);
  const globalLimit = new RequestLimiter(options.requestLimit ?? 300, options.now);
  const clientLimit = new RequestLimiter(60, options.now);
  const withSlot = createToolGate(8);
  const handler = createMcpHandler(() => createRomanumServer(options.service ?? publicData, withSlot, options.recordToolUsage), {
    legacy: "stateless", responseMode: "json", maxRequestBodySize: 16 * 1024, maxSubscriptions: 0,
  });

  const fetch = async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin", "X-Content-Type-Options": "nosniff" });
    const reply = (message: string, status: number, extra?: HeadersInit) => new Response(message, { status, headers: new Headers({ ...Object.fromEntries(headers), ...Object.fromEntries(new Headers(extra)) }) });

    const hostError = hostHeaderValidationResponse(request, allowedHosts);
    if (hostError) return reply("Host not allowed.", 403);
    const ownOrigin = publicUrl?.origin ?? new URL(request.url).origin;
    if (origin && origin !== ownOrigin && !extraOrigins.includes(origin)) return reply("Origin not allowed.", 403);
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Expose-Headers", "MCP-Protocol-Version, Retry-After");
    }

    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") return reply("Use an MCP client to connect.", 405, { Allow: "POST, OPTIONS" });

    // Proxy headers are untrusted unless the operator explicitly configures an overwritten header.
    const rawIp = options.clientIpHeader ? request.headers.get(options.clientIpHeader) : null;
    const ip = rawIp && isIP(rawIp) ? rawIp : null;
    const retry = globalLimit.take("all") || (ip ? clientLimit.take(ip) : 0);
    if (retry) return reply("Too many requests. Try again shortly.", 429, { "Retry-After": String(retry) });

    const response = await handler.fetch(request);
    headers.forEach((value, key) => response.headers.set(key, value));
    return response;
  };
  return { fetch, close: handler.close };
}
