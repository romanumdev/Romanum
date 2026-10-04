import type { Sql } from "../history/database.ts";
import { PUBLIC_TOOLS, type PublicToolName } from "../public-tools.ts";

export type McpToolUsageRecorder = (name: PublicToolName, successful: boolean) => Promise<unknown>;
type ToolCount = { name: string; totalCalls: number; successfulCalls: number; failedCalls: number; successRate: number | null };
export type McpUsage = { available: false; reason: string } | {
  available: true; fromDay: string; throughDay: string; totalCalls: number;
  successfulCalls: number; failedCalls: number; successRate: number | null; popularTools: ToolCount[];
};
export function unavailableMcpUsage(): McpUsage {
  return { available: false, reason: "MCP aggregate recording is unavailable." };
}

/** Await one atomic counter update; missing storage must not break the free public tool. */
export function createMcpUsageRecorder(database: () => Promise<Sql | null>): McpToolUsageRecorder {
  return async (name, successful) => {
    if (!Object.hasOwn(PUBLIC_TOOLS, name)) return false;
    try {
      const sql = await database();
      if (!sql) return false;
      await sql.query(`INSERT INTO mcp_tool_usage_daily(day,tool_name,successful_calls,failed_calls)
        VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,$1,$2,$3)
        ON CONFLICT (day,tool_name) DO UPDATE SET
          successful_calls=mcp_tool_usage_daily.successful_calls+EXCLUDED.successful_calls,
          failed_calls=mcp_tool_usage_daily.failed_calls+EXCLUDED.failed_calls`, [name, successful ? 1 : 0, successful ? 0 : 1]);
      return true;
    } catch { return false; }
  };
}

function count(value: unknown): number {
  const number = Number(value);
  if (value == null || !Number.isSafeInteger(number) || number < 0) throw new Error("MCP reporting count unavailable.");
  return number;
}
function totals(successfulCalls: number, failedCalls: number) {
  const totalCalls = count(successfulCalls + failedCalls);
  return { totalCalls, successfulCalls, failedCalls, successRate: totalCalls ? successfulCalls / totalCalls : null };
}

/** Read within the existing owner-verified snapshot; daily buckets cannot claim rolling 24-hour precision. */
export async function queryMcpUsage(sql: Sql, asOf: string): Promise<McpUsage> {
  const { rows: storage } = await sql.query<{ available: boolean }>(
    `SELECT coalesce(has_table_privilege(to_regclass('mcp_tool_usage_daily'),'SELECT') AND
      has_table_privilege(to_regclass('mcp_tool_usage_daily'),'INSERT') AND
      has_table_privilege(to_regclass('mcp_tool_usage_daily'),'UPDATE'),false) AS available`);
  if (storage[0]?.available !== true) return unavailableMcpUsage();
  const throughDay = new Date(asOf).toISOString().slice(0, 10);
  const fromDay = new Date(Date.parse(throughDay + "T00:00:00Z") - 6 * 86_400_000).toISOString().slice(0, 10);
  const { rows } = await sql.query<{ tool_name: string; successful: unknown; failed: unknown }>(
    `SELECT tool_name,sum(successful_calls) AS successful,sum(failed_calls) AS failed
      FROM mcp_tool_usage_daily WHERE day >= $1::date AND day <= $2::date GROUP BY tool_name`, [fromDay, throughDay]);
  const tools = rows.map(row => ({ name: row.tool_name, ...totals(count(row.successful), count(row.failed)) }));
  return { available: true, fromDay, throughDay,
    ...totals(count(tools.reduce((sum, tool) => sum + tool.successfulCalls, 0)), count(tools.reduce((sum, tool) => sum + tool.failedCalls, 0))),
    popularTools: tools.sort((a, b) => b.totalCalls - a.totalCalls || a.name.localeCompare(b.name)).slice(0, 5) };
}
