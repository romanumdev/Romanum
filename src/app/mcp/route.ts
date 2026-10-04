import { createMcpEndpoint } from "@/lib/mcp/http";
import { createMcpUsageRecorder } from "@/lib/mcp/usage";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const endpoint = createMcpEndpoint({
  publicUrl: process.env.MCP_PUBLIC_URL,
  allowedOrigins: process.env.MCP_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean),
  clientIpHeader: process.env.MCP_CLIENT_IP_HEADER,
  recordToolUsage: createMcpUsageRecorder(historyDatabase),
});

export const POST = endpoint.fetch;
export const GET = endpoint.fetch;
export const DELETE = endpoint.fetch;
export const OPTIONS = endpoint.fetch;
