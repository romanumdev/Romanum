import type { McpUsage } from "../mcp/usage.ts";

export type AdminAccount = { id: string; ownerId: string; username: string; displayName: string; createdAt: string; balance: number | null; reserved: number | null };
type Message = { ownerId: string; role: "user" | "assistant"; createdAt: string };
type LedgerEntry = { ownerId: string; entryType: "grant" | "reserve" | "capture" | "release" | "adjust"; amount: number; balanceChange: number; createdAt: string };
type Usage = { ownerId: string; createdAt: string; costNanoUsd: number; priceNanoUsd: number; creditsCharged: number; modelCalls: number; inputTokens: number; outputTokens: number };
type Tool = { status: "settled" | "released" | "reserved"; createdAt: string };
type Run = { status: "complete" | "failed" | "cancelled"; finishedAt: string };
type Insight = { costNanoUsd: number; finishedAt: string };
export type AdminProjection = { accounts: AdminAccount[]; messages: Message[]; ledger: LedgerEntry[]; usage: Usage[]; tools: Tool[]; runs: Run[]; insights: Insight[]; mcpUsage?: McpUsage };

export function adminUtc(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? "Unavailable" : `${time.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
export function adminUsd(nanoUsd: number) {
  return (nanoUsd / 1_000_000_000).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });
}
function sum(values: number[]) {
  const total = values.reduce((value, next) => value + next, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Reporting amount is outside the safe range.");
  return total;
}

/** Aggregate metadata only. No message bodies, events, prompts, credentials or writes. */
export function buildAdminReport(data: AdminProjection, asOf: string) {
  const end = Date.parse(asOf);
  if (!Number.isFinite(end)) throw new Error("Invalid reporting snapshot.");
  const start = end - 86_400_000;
  const recorded = (value: string) => Date.parse(value) < end;
  const inWindow = (value: string) => Date.parse(value) >= start && Date.parse(value) < end;
  const accounts = data.accounts.filter(account => recorded(account.createdAt));
  const messages = data.messages.filter(message => recorded(message.createdAt));
  const ledger = data.ledger.filter(entry => inWindow(entry.createdAt));
  const usage = data.usage.filter(row => inWindow(row.createdAt));
  const tools = data.tools.filter(row => inWindow(row.createdAt));
  const runs = data.runs.filter(row => inWindow(row.finishedAt));
  const captures = ledger.filter(entry => entry.entryType === "capture");
  const activeOwners = new Set([...messages.filter(message => message.role === "user" && inWindow(message.createdAt)).map(message => message.ownerId), ...usage.map(row => row.ownerId)]);
  const userRows = accounts.map(account => {
    const activity = [...messages.filter(message => message.role === "user" && message.ownerId === account.ownerId).map(message => message.createdAt), ...data.usage.filter(row => row.ownerId === account.ownerId && recorded(row.createdAt)).map(row => row.createdAt)].sort((a, b) => Date.parse(b) - Date.parse(a));
    return { id: account.id, username: account.username, displayName: account.displayName, joinedAt: account.createdAt, balance: account.balance, reserved: account.reserved,
      available: account.balance === null || account.reserved === null ? null : account.balance - account.reserved,
      active: activeOwners.has(account.ownerId), lastActivityAt: activity.length ? activity[0] : null,
      spent24h: sum(captures.filter(entry => entry.ownerId === account.ownerId).map(entry => entry.amount)) };
  });
  const today = Math.floor(end / 86_400_000) * 86_400_000;
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = today - (6 - index) * 86_400_000;
    return { day: new Date(day).toISOString().slice(0, 10), partial: index === 6, credits: sum(data.ledger.filter(entry => entry.entryType === "capture" && Date.parse(entry.createdAt) >= day && Date.parse(entry.createdAt) < Math.min(day + 86_400_000, end)).map(entry => entry.amount)) };
  });
  const hostedCostNanoUsd = sum(usage.map(row => row.costNanoUsd));
  const insightCostNanoUsd = sum(data.insights.filter(row => inWindow(row.finishedAt)).map(row => row.costNanoUsd));
  return { asOf, from: new Date(start).toISOString(), users: userRows, days,
    registeredUsers: accounts.length, activeUsers24h: userRows.filter(user => user.active).length,
    savedMessages: messages.length, userMessages: messages.filter(message => message.role === "user").length,
    assistantMessages: messages.filter(message => message.role === "assistant").length,
    messages24h: messages.filter(message => inWindow(message.createdAt)).length,
    creditsSpent24h: sum(captures.map(entry => entry.amount)),
    releasedHolds24h: sum(ledger.filter(entry => entry.entryType === "release").map(entry => entry.amount)),
    positiveAdjustments24h: sum(ledger.filter(entry => entry.entryType === "adjust" && entry.balanceChange > 0).map(entry => entry.balanceChange)),
    negativeAdjustments24h: sum(ledger.filter(entry => entry.entryType === "adjust" && entry.balanceChange < 0).map(entry => -entry.balanceChange)),
    meteredTools: { settled: tools.filter(tool => tool.status === "settled").length, released: tools.filter(tool => tool.status === "released").length, pending: tools.filter(tool => tool.status === "reserved").length },
    backgroundRuns: { complete: runs.filter(run => run.status === "complete").length, failed: runs.filter(run => run.status === "failed").length, cancelled: runs.filter(run => run.status === "cancelled").length },
    hostedCostNanoUsd, insightCostNanoUsd, providerCostNanoUsd: sum([hostedCostNanoUsd, insightCostNanoUsd]),
    usagePriceNanoUsd: sum(usage.map(row => row.priceNanoUsd)), usageCreditsCharged: sum(usage.map(row => row.creditsCharged)),
    modelCalls: sum(usage.map(row => row.modelCalls)), inputTokens: sum(usage.map(row => row.inputTokens)), outputTokens: sum(usage.map(row => row.outputTokens)),
    publicUsage: { available: false as const, reason: "Public API, crawler and referral usage is not measured." },
    mcpUsage: data.mcpUsage ?? ({ available: false, reason: "MCP aggregate recording is unavailable." } as McpUsage),
  };
}
export type AdminReport = ReturnType<typeof buildAdminReport>;
