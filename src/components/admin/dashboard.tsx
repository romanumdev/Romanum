"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, ArrowLeft, Coins, MessageSquare, Search, ShieldCheck, Users } from "lucide-react";
import { adminUsd, adminUtc, type AdminReport } from "@/lib/admin/report";
import type { AdminPreviewState } from "@/lib/admin/fixtures";

const CARD = "rounded-2xl border border-line bg-surface p-5";
const count = (value: number) => value.toLocaleString("en-US");

export function AdminDashboard({ report, state, mode = "fixture" }: { report: (AdminReport & { pagination?: { page: number; pageSize: number; totalPages: number } }) | null; state: AdminPreviewState; mode?: "fixture" | "live" }) {
  const fixture = mode === "fixture";
  const [query, setQuery] = useState("");
  const users = report?.users.filter(user => `${user.displayName} ${user.username}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const maximum = Math.max(1, ...(report?.days.map(day => day.credits) ?? []));
  return <div className="mx-auto max-w-6xl space-y-6 pb-12">
    <header>
      <Link href="/analytics" prefetch={false} className="inline-flex min-h-10 items-center gap-2 text-xs text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" />Romanum</Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-xs tracking-widest text-fg-muted">READ-ONLY OPERATIONS</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Admin overview</h1></div>
        <span className="inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-amber-300/5 px-3 py-2 text-xs text-amber-200"><ShieldCheck className="size-3.5" />{fixture ? "Local fixture preview" : "Owner-only · read-only"}</span>
      </div>
      <p className="mt-4 max-w-3xl text-sm leading-6 text-fg-muted">{fixture ? "Users, balances and recorded usage in one place. Every value here is synthetic fixture data. No live users or balances are loaded." : "Current registered users, balances and recorded usage from Romanum. Access is restricted to the approved signed-in owner."}</p>
      {fixture && <nav aria-label="Fixture states" className="mt-4 flex flex-wrap gap-2">{(["overview", "empty", "unavailable"] as const).map(item => <Link prefetch={false} key={item} href={`/admin/preview${item === "overview" ? "" : `?state=${item}`}`} aria-current={state === item ? "page" : undefined} className={`min-h-9 rounded-full border px-3 py-2 text-xs capitalize ${state === item ? "border-fg bg-fg text-canvas" : "border-line text-fg-muted hover:text-fg"}`}>{item === "overview" ? "Sample data" : item === "empty" ? "Empty state" : "Error state"}</Link>)}</nav>}
    </header>

    {!report ? <section className={`${CARD} py-10`} role="status"><h2 className="text-lg font-semibold">Reporting unavailable</h2><p className="mt-3 text-sm leading-6 text-fg-muted">{fixture ? "This demonstrates a fixture error state. Missing reporting data stays unavailable; it is not replaced with zero counts." : "The reporting snapshot could not be loaded. No stale report or zero counts have been substituted."}</p><Link prefetch={false} href={fixture ? "/admin/preview" : "/admin"} className="mt-5 inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm">{fixture ? "Return to sample data" : "Retry reporting"}</Link></section> : <>
      <div className="rounded-xl border border-line px-4 py-3 text-xs leading-5 text-fg-muted"><p>{fixture ? "Fixed fixture snapshot:" : "Database snapshot:"} <time dateTime={report.asOf} className="text-fg">{adminUtc(report.asOf)}</time></p><p>Rolling 24 hours: {adminUtc(report.from)} → {adminUtc(report.asOf)}. End time excluded.</p></div>
      <section aria-label="Overview metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<Users className="size-4" />} label="Registered users" value={count(report.registeredUsers)} detail="Current account rows; guests are separate." />
        <Stat icon={<Activity className="size-4" />} label="Active users · 24h" value={count(report.activeUsers24h)} detail="Saved question or hosted usage record; excludes browsing." />
        <Stat icon={<MessageSquare className="size-4" />} label="Total saved messages" value={count(report.savedMessages)} detail={`${count(report.userMessages)} user · ${count(report.assistantMessages)} assistant · retained Chats`} />
        <Stat icon={<Coins className="size-4" />} label="Credits spent · 24h" value={count(report.creditsSpent24h)} detail="Captures across all owners, including guests and closed accounts." />
      </section>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className={CARD} aria-labelledby="spend-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="spend-heading" className="text-base font-semibold">Daily credits spent</h2><span className="text-xs text-fg-muted">7 UTC days{fixture ? " · fixture" : ""}</span></div>
          <div className="mt-6 flex h-44 items-end gap-2 sm:gap-4" role="img" aria-label={report.days.map(day => `${day.day}: ${day.credits} credits${day.partial ? ", partial day" : ""}`).join("; ")}>
            {report.days.map(day => <div key={day.day} className="flex h-full min-w-0 flex-1 flex-col justify-end text-center"><span className="mb-2 text-[11px] tabular-nums text-fg-muted">{day.credits}</span><div className={`mx-auto w-full max-w-12 rounded-t-md ${day.partial ? "bg-fg/40" : "bg-fg/85"}`} style={{ height: `${Math.max(day.credits ? 3 : 1, day.credits / maximum * 110)}px` }} /><time dateTime={day.day} className="mt-2 text-[10px] text-fg-muted">{day.day.slice(5).replace("-", "/")}</time></div>)}
          </div>
          <p className="mt-4 text-xs leading-5 text-fg-muted">Calendar-day captures; the final day is partial. The rolling 24-hour total spans two UTC dates.</p>
          <details className="mt-4 border-t border-line pt-3 text-xs"><summary className="cursor-pointer text-fg-muted">Exact daily values</summary><ul className="mt-3 space-y-2">{report.days.map(day => <li key={day.day} className="flex justify-between gap-3"><span>{day.day}{day.partial ? " · partial" : ""}</span><span className="tabular-nums">{count(day.credits)} credits</span></li>)}</ul></details>
        </section>
        <section className={CARD} aria-labelledby="cost-heading">
          <h2 id="cost-heading" className="text-base font-semibold">Recorded cost · 24h</h2>
          <dl className="mt-5 space-y-4 text-sm"><Pair label="Provider cost · USD" value={adminUsd(report.providerCostNanoUsd)} /><Pair label="Hosted Ask / Chats" value={adminUsd(report.hostedCostNanoUsd)} /><Pair label="Platform-funded insight" value={adminUsd(report.insightCostNanoUsd)} /><Pair label="Hosted usage price · USD" value={adminUsd(report.usagePriceNanoUsd)} /><Pair label="Whole usage credits deducted" value={count(report.usageCreditsCharged)} /></dl>
          <p className="mt-5 border-t border-line pt-4 text-xs leading-5 text-fg-muted">Usage price is recorded metering, not cash revenue or profit. Fractional carry can make priced usage differ from whole credits deducted. Provider cost includes recorded failed work.</p>
        </section>
      </div>

      <section className={CARD} aria-labelledby="users-heading">
        <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 id="users-heading" className="text-base font-semibold">Users and balances</h2><p className="mt-1 text-xs text-fg-muted">{fixture ? "Synthetic registered accounts · read-only" : `Registered accounts · read-only${report.pagination ? ` · page ${report.pagination.page} of ${report.pagination.totalPages}` : ""}`}</p></div><label className="flex w-full items-center gap-2 rounded-lg border border-line px-3 sm:w-64"><Search className="size-3.5 shrink-0 text-fg-muted" /><input aria-label={fixture ? "Filter fixture users" : "Filter users on this page"} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={fixture ? "Find a user" : "Find on this page"} className="min-h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" /></label></div>
        <div className="mt-5 hidden gap-4 border-b border-line pb-3 text-[11px] text-fg-muted md:grid md:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_1fr]"><span>User / joined UTC</span><span>Balance</span><span>Reserved</span><span>Available</span><span>Spent · 24h</span></div>
        {!users.length ? <p className="py-10 text-center text-sm text-fg-muted" role="status">{report.users.length ? (fixture ? "No fixture users match this search." : "No users on this page match this search.") : (fixture ? "No registered users in this fixture." : "No registered users in this snapshot.")}</p> : <ul className="divide-y divide-line">{users.map(user => <li key={user.id} className="grid gap-4 py-5 md:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_1fr] md:items-center">
          <div className="min-w-0"><p className="flex flex-wrap items-center gap-2 text-sm font-medium"><span>{user.displayName}</span>{user.active && <span className="rounded-full border border-emerald-400/30 px-2 py-0.5 text-[10px] text-emerald-200">Active · 24h</span>}</p><p className="mt-1 break-all text-xs text-fg-muted">@{user.username}</p><p className="mt-1 text-[11px] leading-5 text-fg-subtle">Joined {adminUtc(user.joinedAt)}</p>{user.lastActivityAt && <p className="text-[11px] leading-5 text-fg-subtle">Activity {adminUtc(user.lastActivityAt)}</p>}</div>
          <dl className="grid grid-cols-2 gap-3 md:contents">{([["Balance", user.balance], ["Reserved", user.reserved], ["Available", user.available], ["Spent · 24h", user.spent24h]] as const).map(([label, value]) => <div key={label} className="rounded-lg bg-canvas px-3 py-2 md:bg-transparent md:p-0"><dt className="text-[10px] text-fg-muted md:sr-only">{label}</dt><dd className="mt-1 text-sm tabular-nums md:mt-0">{value === null ? <span className="text-xs text-fg-subtle">Unavailable</span> : count(value)}</dd></div>)}</dl>
        </li>)}</ul>}
        {!fixture && report.pagination && report.pagination.totalPages > 1 && <nav aria-label="User pages" className="mt-4 flex justify-between gap-3 border-t border-line pt-4 text-sm">{report.pagination.page > 1 ? <Link prefetch={false} href={`/admin?page=${report.pagination.page - 1}`} className="min-h-10 rounded-lg border border-line px-3 py-2">Previous</Link> : <span />}{report.pagination.page < report.pagination.totalPages && <Link prefetch={false} href={`/admin?page=${report.pagination.page + 1}`} className="min-h-10 rounded-lg border border-line px-3 py-2">Next</Link>}</nav>}
      </section>

      <section className="grid gap-4 md:grid-cols-3" aria-label="Usage details">
        <Detail title="Messages and model calls" rows={[["Saved messages · 24h", report.messages24h], ["Hosted model calls · 24h", report.modelCalls], ["Input tokens", report.inputTokens], ["Output tokens", report.outputTokens]]} note="Assistant rows include error or partial replies. Ask Romanum has no complete persisted submission count. Tool calls are not messages." />
        <Detail title="Metered tools · 24h" rows={[["Settled", report.meteredTools.settled], ["Released", report.meteredTools.released], ["Pending", report.meteredTools.pending]]} note="Billed-tool records only. Released attempts are not successful paid calls; free chart tools are outside this count." />
        <Detail title="Background reviews · 24h" rows={[["Complete", report.backgroundRuns.complete], ["Failed", report.backgroundRuns.failed], ["Cancelled", report.backgroundRuns.cancelled]]} note="Retained background-run completions. These are not a status classification for every Ask or chat response." />
      </section>
      <section className="grid gap-4 md:grid-cols-2">
        <div className={CARD}><h2 className="text-sm font-semibold">Holds and adjustments · 24h</h2><dl className="mt-4 space-y-3 text-sm"><Pair label="Released holds · credits" value={count(report.releasedHolds24h)} /><Pair label="Positive adjustments" value={`+${count(report.positiveAdjustments24h)}`} /><Pair label="Negative adjustments" value={`−${count(report.negativeAdjustments24h)}`} /><Pair label="Confirmed refund total" value="Unavailable" /></dl><p className="mt-4 text-xs leading-5 text-fg-muted">Releasing a hold does not debit or refund the balance. Adjustments lack a semantic refund type. Grants, holds and adjustments are excluded from captured spending.</p></div>
        <section className={CARD} aria-labelledby="mcp-usage-heading">
          <h2 id="mcp-usage-heading" className="text-sm font-semibold">MCP tool usage</h2>
          {report.mcpUsage.available ? <>
            <p className="mt-2 text-xs text-fg-muted">7 UTC days: {report.mcpUsage.fromDay} → {report.mcpUsage.throughDay}. Today is partial.</p>
            <dl className="mt-4 space-y-3 text-sm"><Pair label="Recorded calls" value={count(report.mcpUsage.totalCalls)} /><Pair label="Successful" value={count(report.mcpUsage.successfulCalls)} /><Pair label="Failed" value={count(report.mcpUsage.failedCalls)} /><Pair label="Success rate" value={report.mcpUsage.successRate === null ? "No calls recorded" : `${(report.mcpUsage.successRate * 100).toFixed(1)}%`} /></dl>
            <h3 className="mt-5 text-xs font-semibold">Popular tools</h3>
            {report.mcpUsage.popularTools.length ? <ul className="mt-3 space-y-2 text-xs">{report.mcpUsage.popularTools.map(tool => <li key={tool.name} className="flex flex-wrap justify-between gap-2"><span>{tool.name}</span><span className="tabular-nums text-fg-muted">{count(tool.totalCalls)} calls · {tool.successRate === null ? "—" : `${(tool.successRate * 100).toFixed(1)}% success`}</span></li>)}</ul> : <p className="mt-3 text-xs text-fg-muted">No calls recorded.</p>}
          </> : <p className="mt-4 text-sm leading-6 text-fg-muted">{report.mcpUsage.reason}</p>}
          <p className="mt-4 text-xs leading-5 text-fg-muted">Completed tool handlers only; protocol rejections and resource reads are excluded. Recording is best effort and does not establish unique users or client delivery.</p>
          <p className="mt-3 text-xs leading-5 text-fg-muted">Public API, crawlers and AI referrals remain unmeasured.</p>
        </section>
      </section>
    </>}
    <footer className="border-t border-line pt-5 text-xs leading-6 text-fg-subtle">{fixture ? "Fixture preview only. Live reporting requires the configured, approved owner account." : "Approved owner access · metadata and aggregates only."} No credit edits, impersonation or private message content.</footer>
  </div>;
}
function Stat({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <div className={CARD}><p className="flex items-center gap-2 text-xs text-fg-muted">{icon}{label}</p><p className="mt-4 text-3xl font-semibold tracking-tight tabular-nums">{value}</p><p className="mt-3 text-xs leading-5 text-fg-subtle">{detail}</p></div>;
}
function Pair({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-4"><dt className="text-fg-muted">{label}</dt><dd className="shrink-0 tabular-nums">{value}</dd></div>; }
function Detail({ title, rows, note }: { title: string; rows: [string, number][]; note: string }) {
  return <div className={CARD}><h2 className="text-sm font-semibold">{title}</h2><dl className="mt-4 space-y-3 text-sm">{rows.map(([label, value]) => <Pair key={label} label={label} value={count(value)} />)}</dl><p className="mt-4 text-xs leading-5 text-fg-muted">{note}</p></div>;
}
