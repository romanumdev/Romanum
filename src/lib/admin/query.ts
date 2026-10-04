import type { Sql } from "../history/database.ts";
import type { AdminReport } from "./report.ts";
import { queryMcpUsage } from "../mcp/usage.ts";

export const ADMIN_PAGE_SIZE = 100;
export type OwnerAdminReport = AdminReport & { pagination: { page: number; pageSize: number; totalPages: number } };
export function adminPage(value: unknown) {
  return typeof value === "string" && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : 1;
}
function amount(value: unknown) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(number) || number < 0) throw new Error("Reporting amount unavailable.");
  return number;
}
function iso(value: string | Date) { return new Date(value).toISOString(); }

/** Called only after session/owner verification in the same read-only snapshot. SELECTs return metadata/aggregates, never bodies. */
export async function queryAdminReport(sql: Sql, requestedPage = 1): Promise<OwnerAdminReport> {
  const { rows: snapshots } = await sql.query<{ as_of: Date | string }>("SELECT transaction_timestamp() AS as_of");
  const asOf = iso(snapshots[0].as_of);
  const end = Date.parse(asOf);
  const from = new Date(end - 86_400_000).toISOString();
  const values = [from, asOf];
  const { rows: totals } = await sql.query<Record<string, unknown>>(`SELECT count(*) AS registered,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chat_messages m JOIN chats c ON c.id=m.chat_id WHERE c.owner_id=a.owner_id AND m.role='user' AND m.created_at >= $1 AND m.created_at < $2)
      OR EXISTS (SELECT 1 FROM usage_charges u WHERE u.owner_id=a.owner_id AND u.created_at >= $1 AND u.created_at < $2)) AS active
    FROM accounts a WHERE a.created_at < $2`, values);
  const registeredUsers = amount(totals[0].registered);
  const totalPages = Math.max(1, Math.ceil(registeredUsers / ADMIN_PAGE_SIZE));
  const page = Math.max(1, Math.min(totalPages, Math.floor(requestedPage) || 1));
  type UserRow = { id: string; username: string; display_name: string; created_at: Date | string; balance: unknown; reserved: unknown; spent: unknown; last_activity: Date | string | null };
  const { rows: users } = await sql.query<UserRow>(`SELECT a.id,a.username,a.display_name,a.created_at,b.balance,b.reserved,
    (SELECT coalesce(sum(l.amount),0) FROM credits_ledger l WHERE l.owner_id=a.owner_id AND l.entry_type='capture' AND l.created_at >= $1 AND l.created_at < $2) AS spent,
    greatest((SELECT max(m.created_at) FROM chat_messages m JOIN chats c ON c.id=m.chat_id WHERE c.owner_id=a.owner_id AND m.role='user' AND m.created_at < $2),
      (SELECT max(u.created_at) FROM usage_charges u WHERE u.owner_id=a.owner_id AND u.created_at < $2)) AS last_activity
    FROM accounts a LEFT JOIN credits_accounts b ON b.owner_id=a.owner_id WHERE a.created_at < $2 ORDER BY a.created_at DESC,a.id LIMIT $3 OFFSET $4`, [...values, ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE]);
  const { rows: messages } = await sql.query<Record<string, unknown>>(`SELECT count(*) AS total,count(*) FILTER (WHERE role='user') AS questions,
    count(*) FILTER (WHERE role='assistant') AS answers,count(*) FILTER (WHERE created_at >= $1) AS recent FROM chat_messages WHERE created_at < $2`, values);
  const { rows: ledger } = await sql.query<Record<string, unknown>>(`SELECT
    coalesce(sum(amount) FILTER (WHERE entry_type='capture'),0) AS spent,
    coalesce(sum(amount) FILTER (WHERE entry_type='release'),0) AS released,
    coalesce(sum(balance_change) FILTER (WHERE entry_type='adjust' AND balance_change>0),0) AS positive,
    coalesce(sum(-balance_change) FILTER (WHERE entry_type='adjust' AND balance_change<0),0) AS negative
    FROM credits_ledger WHERE created_at >= $1 AND created_at < $2`, values);
  const today = Math.floor(end / 86_400_000) * 86_400_000;
  const { rows: daily } = await sql.query<{ day: string; credits: unknown }>(`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,sum(amount) AS credits
    FROM credits_ledger WHERE entry_type='capture' AND created_at >= $1 AND created_at < $2 GROUP BY 1`, [new Date(today - 6 * 86_400_000).toISOString(), asOf]);
  const { rows: usage } = await sql.query<Record<string, unknown>>(`SELECT coalesce(sum(cost_nano_usd),0) AS cost,coalesce(sum(price_nano_usd),0) AS price,
    coalesce(sum(credits_charged),0) AS charged FROM usage_charges WHERE created_at >= $1 AND created_at < $2`, values);
  // Extract numeric token counters in SQL; never return the stored calls JSON.
  const { rows: calls } = await sql.query<Record<string, unknown>>(`SELECT count(*) AS calls,
    coalesce(sum(CASE WHEN call->>'input' ~ '^[0-9]+$' THEN (call->>'input')::numeric ELSE 0 END),0) AS input,
    coalesce(sum(CASE WHEN call->>'output' ~ '^[0-9]+$' THEN (call->>'output')::numeric ELSE 0 END),0) AS output
    FROM usage_charges u CROSS JOIN LATERAL jsonb_array_elements(u.calls) AS call WHERE u.created_at >= $1 AND u.created_at < $2`, values);
  const { rows: insights } = await sql.query<{ cost: unknown }>("SELECT coalesce(sum(cost_nano_usd),0) AS cost FROM insights WHERE finished_at >= $1 AND finished_at < $2", values);
  const { rows: tools } = await sql.query<Record<string, unknown>>(`SELECT count(*) FILTER (WHERE status='settled') AS settled,count(*) FILTER (WHERE status='released') AS released,
    count(*) FILTER (WHERE status='reserved') AS pending FROM tool_usage WHERE created_at >= $1 AND created_at < $2`, values);
  const { rows: runs } = await sql.query<Record<string, unknown>>(`SELECT count(*) FILTER (WHERE status='complete') AS complete,count(*) FILTER (WHERE status='failed') AS failed,
    count(*) FILTER (WHERE status='cancelled') AS cancelled FROM chat_runs WHERE finished_at >= $1 AND finished_at < $2`, values);
  const hostedCostNanoUsd = amount(usage[0].cost);
  const insightCostNanoUsd = amount(insights[0].cost);
  return {
    asOf, from, registeredUsers, activeUsers24h: amount(totals[0].active),
    users: users.map(user => { const balance=user.balance === null ? null : amount(user.balance); const reserved=user.reserved === null ? null : amount(user.reserved); const lastActivityAt=user.last_activity ? iso(user.last_activity) : null;
      return { id:user.id,username:user.username,displayName:user.display_name,joinedAt:iso(user.created_at),balance,reserved,
        available:balance === null || reserved === null ? null : balance-reserved,active:!!lastActivityAt && lastActivityAt >= from,lastActivityAt,spent24h:amount(user.spent) }; }),
    days:Array.from({length:7},(_,index)=>{ const day=new Date(today-(6-index)*86_400_000).toISOString().slice(0,10); return {day,partial:index===6,credits:amount(daily.find(row=>row.day===day)?.credits ?? 0)}; }),
    savedMessages:amount(messages[0].total),userMessages:amount(messages[0].questions),assistantMessages:amount(messages[0].answers),messages24h:amount(messages[0].recent),
    creditsSpent24h:amount(ledger[0].spent),releasedHolds24h:amount(ledger[0].released),positiveAdjustments24h:amount(ledger[0].positive),negativeAdjustments24h:amount(ledger[0].negative),
    hostedCostNanoUsd,insightCostNanoUsd,providerCostNanoUsd:amount(hostedCostNanoUsd+insightCostNanoUsd),usagePriceNanoUsd:amount(usage[0].price),usageCreditsCharged:amount(usage[0].charged),
    modelCalls:amount(calls[0].calls),inputTokens:amount(calls[0].input),outputTokens:amount(calls[0].output),
    meteredTools:{settled:amount(tools[0].settled),released:amount(tools[0].released),pending:amount(tools[0].pending)},
    backgroundRuns:{complete:amount(runs[0].complete),failed:amount(runs[0].failed),cancelled:amount(runs[0].cancelled)},
    publicUsage:{available:false,reason:"Public API, crawler and referral usage is not measured."},
    mcpUsage:await queryMcpUsage(sql,asOf),
    pagination:{page,pageSize:ADMIN_PAGE_SIZE,totalPages},
  };
}
