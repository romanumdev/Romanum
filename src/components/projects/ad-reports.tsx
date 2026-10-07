"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { CANONICAL_DAILY_CSV, type AdReportBundle, type AdReportCalculated, type AdReportContext, type AdReportFile, type AdReportSelection } from "@/lib/ad-reports/types";
import { compareAdReports } from "@/lib/ad-reports/compare";
import type { ReferenceSummary } from "@/lib/projects/references";

type Report = { id: string; bundle: AdReportBundle; context: AdReportContext; createdAt: string };
type CreativeLink = { id: string; reportId: string; adId: string; creativeId: string };
type Observation = { id: string; status: string; text: string; reportIds: string[]; creativeIds: string[]; supersedesId: string | null; createdAt: string };
type ReportsData = { reports: Report[]; settings: { aiAnalysis: boolean; platformImprovement: boolean; consentVersion: number }; links: CreativeLink[]; observations: Observation[] };
const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
const FIELD = `mt-2 min-h-11 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm ${FOCUS}`;
const BUTTON = `inline-flex min-h-11 items-center justify-center rounded-lg border border-line px-3 text-sm hover:bg-surface disabled:opacity-40 ${FOCUS}`;
const EMPTY_CONTEXT: AdReportContext = { periodStart: null, periodEnd: null, timezone: null, attributionWindow: null, placement: null, audience: null, currency: null };
const number = (value: number | null) => value === null ? "Unknown" : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
const percent = (value: number | null) => value === null ? "Unknown" : `${(value * 100).toFixed(2)}%`;
const reportName = (report: Report) => `${report.bundle.format === "romanum-daily-v1" ? "Daily" : report.bundle.format === "mixed" ? "Mixed" : "Aggregate"} · ${report.context.periodStart ?? "unknown start"}–${report.context.periodEnd ?? "unknown end"} · ${report.id.slice(0, 8)}`;
const groupKey = (file: AdReportFile) => `${file.grain}|${file.cohort}|${file.entityType}`;
const COMPARISON_METRICS: Record<keyof AdReportCalculated, string> = { ctr: "Paid CTR", playsPerImpression: "Plays / impressions", cpc: "Cost per click", cpp: "Cost per play" };

function contextText(context: AdReportContext) {
  return `Period ${context.periodStart ?? "unknown"} to ${context.periodEnd ?? "unknown"}; time zone ${context.timezone ?? "unknown"}; attribution ${context.attributionWindow ?? "unknown"}; audience ${context.audience ?? "unknown"}; placement ${context.placement ?? "unknown"}; currency/unit ${context.currency ?? "unknown"}.`;
}

function Rows({ files }: { files: AdReportFile[] }) {
  const [limit, setLimit] = useState(25);
  const rows = files.flatMap(file => file.rows.map(row => ({ file, row })));
  return <div className="mt-3">
    <div className={`overflow-x-auto rounded-lg border border-line ${FOCUS}`} tabIndex={0} aria-label="Ad report rows">
      <table className="w-full min-w-[760px] text-left text-xs tabular-nums">
        <caption className="sr-only">Source rows. Unknown means a blank or unavailable metric; zero remains zero.</caption>
        <thead className="bg-surface text-fg-muted"><tr>{["Ad / campaign", "Date", "Impressions", "Clicks", "Plays", "Spend", "Paid CTR", "Plays / impressions"].map(label => <th scope="col" key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead>
        <tbody>{rows.slice(0, limit).map(({ file, row }, index) => <tr key={`${file.sha256}:${row.sourceLine}:${index}`} className="border-t border-line">
          <th scope="row" className="max-w-48 break-words px-3 py-3 font-normal"><span className="block">{row.adName || row.campaignName || row.adId || row.campaignId}</span><span className="text-fg-subtle">{row.adId ? `Ad ${row.adId}` : `Campaign ${row.campaignId}`}</span><span className="mt-1 block text-fg-subtle" title={file.sha256}>{file.name} · line {row.sourceLine}</span></th>
          <td className="px-3 py-3">{row.date ?? "Whole period"}</td><td className="px-3 py-3">{number(row.impressions)}</td><td className="px-3 py-3">{number(row.clicks)}</td><td className="px-3 py-3">{number(row.plays)}</td><td className="px-3 py-3">{number(row.spend)}</td><td className="px-3 py-3">{percent(row.calculated.ctr)}</td><td className="px-3 py-3">{percent(row.calculated.playsPerImpression)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {rows.length > limit && <button type="button" onClick={() => setLimit(current => current + 100)} className={`${BUTTON} mt-3`}>Show more rows ({rows.length - limit} remaining)</button>}
  </div>;
}

// Explicit entity selections use the same deterministic checks as project chat.
function Comparison({ reports, group }: { reports: Report[]; group: string }) {
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [metric, setMetric] = useState<keyof AdReportCalculated>("ctr");
  if (!reports.length || reports.length > 2 || !group) return <p className="text-sm text-fg-muted">Select one or two reports to compare explicit ads or campaigns.</p>;
  const left = reports[0], right = reports[1] ?? reports[0];
  const [grain, cohort, entityType] = group.split("|") as [AdReportSelection["grain"], AdReportSelection["cohort"], AdReportSelection["entityType"]];
  const entities = (report: Report) => [...new Map(report.bundle.files.filter(file => groupKey(file) === group).flatMap(file => file.rows.map(row => [JSON.stringify([row.campaignId, row.adId]), { campaignId: row.campaignId, adId: row.adId, label: `${row.adName || row.campaignName} · ${row.adId ?? row.campaignId}` }] as const))).entries()];
  const leftOptions = entities(left), rightOptions = entities(right);
  const l = leftOptions.find(([id]) => id === leftId) ?? leftOptions[0];
  const r = rightOptions.find(([id]) => id === rightId) ?? rightOptions[reports.length === 1 && rightOptions.length > 1 ? 1 : 0];
  if (!l || !r) return <p className="text-sm text-fg-muted">Both reports need rows in this grain, cohort and entity.</p>;
  const selection = (item: typeof l): AdReportSelection => ({ grain, cohort, entityType, campaignId: item[1].campaignId, ...(entityType === "ad" && item[1].adId ? { adId: item[1].adId } : {}) });
  const result = compareAdReports(left.bundle, right.bundle, { left: selection(l), right: selection(r), metric });
  const same = left.id === right.id && l[0] === r[0];
  const cost = metric === "cpc" || metric === "cpp";
  const costDenominator = metric === "cpc" ? "click" : "play";
  const metricValue = (value: number | null, currency: string | null) => cost ? value === null || !currency ? "Unknown (metric or currency/unit unavailable)" : `${number(value)} ${currency} / ${costDenominator}` : percent(value);
  const delta = result.delta[metric];
  const knownCostUnit = result.left.currency && result.left.currency === result.right.currency;
  const deltaText = !result.comparable || delta === null || (cost && !knownCostUnit) ? cost ? "Unknown: compatible evidence and the same known spend unit are required" : "Unknown: compatible evidence and an available metric are required" : cost ? `${delta > 0 ? "+" : ""}${number(delta)} ${result.left.currency} / ${costDenominator}` : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(2)} percentage points`;
  return <div className="space-y-3">
    <label className="block text-sm">Comparison metric<select value={metric} onChange={event => setMetric(event.target.value as keyof AdReportCalculated)} className={FIELD}>{(Object.keys(COMPARISON_METRICS) as (keyof AdReportCalculated)[]).map(key => <option key={key} value={key}>{COMPARISON_METRICS[key]}</option>)}</select></label>
    <div className="grid gap-3 sm:grid-cols-2">{([{ side: "Left", options: leftOptions, value: l[0], change: setLeftId, report: left }, { side: "Right", options: rightOptions, value: r[0], change: setRightId, report: right }]).map(item => <label key={item.side} className="block text-sm">{item.side} entity<select value={item.value} onChange={event => item.change(event.target.value)} className={FIELD}>{item.options.map(([id, entity]) => <option key={id} value={id}>{entity.label}</option>)}</select><span className="mt-1 block text-xs text-fg-subtle">{reportName(item.report)}</span></label>)}</div>
    <p className="text-xs text-fg-muted">Paid CTR = clicks / impressions; plays / impressions is not discovery PTR. Daily rows are summed only for the selected entity and cohort within each reporting period.</p>
    {same && <p role="status" className="text-sm text-fg-muted">Choose two different entities or reports.</p>}
    {!result.comparable && <div role="status" className="rounded-lg border border-line p-3 text-sm text-fg-muted"><p className="font-medium">Comparison is incomplete or incompatible. No winner is established.</p><ul className="mt-2 list-disc space-y-1 pl-5">{result.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
    <div className="grid gap-3 sm:grid-cols-2">{([{ label: "Left", summary: result.left }, { label: "Right", summary: result.right }]).map(({ label, summary }) => <div key={label} className="rounded-lg border border-line p-3 text-sm"><p className="font-medium">{label}</p><p className="mt-2 text-fg-muted">{COMPARISON_METRICS[metric]}: {metricValue(summary.calculated[metric], summary.currency)}</p><p className="mt-2 text-xs text-fg-subtle">Impressions {number(summary.impressions)} · clicks {number(summary.clicks)} · plays {number(summary.plays)} · spend {number(summary.spend)} {summary.currency ?? "(unknown unit)"}</p><details className="mt-3"><summary className={`cursor-pointer text-xs ${FOCUS}`}>Evidence sources ({summary.sources.length})</summary><ul className="mt-2 space-y-1 text-xs text-fg-subtle">{summary.sources.map((source, index) => <li key={index} className="break-words" title={source.sha256}>{source.name} · line {source.sourceLine}</li>)}</ul></details></div>)}</div>
    {!same && <p className="text-sm text-fg-muted">{COMPARISON_METRICS[metric]} change (right − left): {deltaText}. This describes observed performance; it does not establish that the creative caused the difference.</p>}
    {!!result.warnings.length && <ul className="space-y-1 text-xs text-fg-muted">{result.warnings.map(warning => <li key={warning}>Caution: {warning}</li>)}</ul>}
  </div>;
}

export function AdReports({ projectId, archived }: { projectId: string; archived: boolean }) {
  const heading = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<ReportsData | null>(null);
  const [references, setReferences] = useState<ReferenceSummary[]>([]);
  const [referencesError, setReferencesError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [context, setContext] = useState<AdReportContext>(EMPTY_CONTEXT);
  const [selected, setSelected] = useState<string[]>([]);
  const [group, setGroup] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState("observation");
  const [supersedes, setSupersedes] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const endpoint = `/api/projects/${projectId}/ad-reports`;

  async function load(signal?: AbortSignal) {
    setLoading(true); setError("");
    try {
      const response = await fetch(endpoint, { signal }); const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Couldn't load ad reports.");
      if (!signal?.aborted) { setData(result); setSelected(current => current.filter(id => result.reports.some((report: Report) => report.id === id))); }
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Couldn't load ad reports."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    async function initialize() {
      const results = await Promise.allSettled([fetch(endpoint, { signal: controller.signal }), fetch(`/api/projects/${projectId}/references`, { signal: controller.signal })]);
      if (controller.signal.aborted) return;
      const reportResult = results[0]; const referenceResult = results[1];
      try { if (reportResult.status !== "fulfilled") throw new Error("Couldn't load ad reports."); const value = await reportResult.value.json(); if (!reportResult.value.ok) throw new Error(value.error ?? "Couldn't load ad reports."); if (!controller.signal.aborted) setData(value); } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Couldn't load ad reports."); }
      try { if (referenceResult.status !== "fulfilled" || !referenceResult.value.ok) throw new Error(); const value = await referenceResult.value.json(); if (!controller.signal.aborted) setReferences(value.references); } catch { if (!controller.signal.aborted) setReferencesError("Image references unavailable. Open References to add or review images, then reload."); }
      if (!controller.signal.aborted) setLoading(false);
    }
    void initialize();
    return () => controller.abort();
  }, [endpoint, projectId]);

  async function mutate(body: FormData | Record<string, unknown>, success: string) {
    if (busy) return false;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(endpoint, { method: "POST", ...(body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Couldn't save this change.");
      setMessage(result.duplicate ? "This report was already imported; the existing report is unchanged." : success);
      await load(); return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't save this change."); return false; }
    finally { setBusy(false); }
  }

  async function upload(event: FormEvent) {
    event.preventDefault(); if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError("Choose a report up to 10 MB."); return; }
    if (context.periodStart && context.periodEnd && context.periodStart > context.periodEnd) { setError("Reporting period end must be on or after its start."); return; }
    if (/^Romanum_Daily_v1_/i.test(file.name) && (!context.periodStart || !context.periodEnd)) { setError("Daily imports require a reporting period start and end containing every row date."); return; }
    if (context.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: context.timezone }); } catch { setError("Enter an IANA time zone, such as America/New_York, or leave it blank for unknown."); return; } }
    const normalized = Object.fromEntries(Object.entries(context).map(([key, value]) => [key, value?.trim() || null]));
    const body = new FormData(); body.set("file", file); body.set("context", JSON.stringify(normalized));
    if (await mutate(body, "Report imported privately. Link each ad to its image below.")) { setImporting(false); setFile(null); if (fileInput.current) fileInput.current.value = ""; }
  }

  const chosen = data?.reports.filter(report => selected.includes(report.id)) ?? [];
  const groups = [...new Set(chosen.flatMap(report => report.bundle.files.map(groupKey)))];
  const populatedGroup = groups.find(key => chosen.some(report => report.bundle.files.some(file => groupKey(file) === key && file.rows.length > 0)));
  const comparisonGroup = groups.includes(group) ? group : populatedGroup ?? groups[0] ?? "";
  const planningPrompt = `Create a written thumbnail test plan using imported ad report IDs ${selected.join(", ")}. Read the report evidence and explicit creative links. Separate cohorts and grains; qualify unknown context, small samples and competing explanations. Propose hypotheses and next tests. Do not generate an image or call paid image models.`;

  return <section aria-labelledby={heading} className="mt-8 space-y-6 border-t border-line pt-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={heading} className="text-base font-medium">Ad reports</h2><p className="mt-1 text-xs text-fg-muted">Private paid-ad evidence, creative associations and learning history.</p></div>{!archived && <button type="button" disabled={busy || !data} onClick={() => setImporting(current => !current)} className={BUTTON}>{importing ? "Close import" : "Import report"}</button>}</header>
    {loading && !data && <p role="status" className="text-sm text-fg-muted">Loading ad reports.</p>}
    {error && <p role="alert" className="text-sm text-fg-muted">{error} <button type="button" disabled={busy || loading} onClick={() => void load()} className={`underline ${FOCUS}`}>Reload reports</button></p>}
    {message && <p role="status" className="text-sm text-fg-muted">{message}</p>}
    {archived && <p className="text-sm text-fg-muted">Restore this project to import reports or save new evidence.</p>}
    {data && <div className="rounded-xl border border-line p-4 text-sm">
      <label className="flex min-h-11 items-start gap-3"><input type="checkbox" checked={data.settings.aiAnalysis} disabled={busy || archived} onChange={event => void mutate({ action: "consent", aiAnalysis: event.target.checked, consentVersion: data.settings.consentVersion }, event.target.checked ? "Imported ad evidence enabled for this project's AI analysis." : "Imported ad evidence disabled for AI analysis.")} className={`mt-1 size-4 shrink-0 accent-white ${FOCUS}`} /><span>Allow AI analysis of this project’s imported ad evidence<span className="mt-1 block text-xs text-fg-muted">Off by default. When you ask project chat to use this evidence, report metrics, image associations and private notes can be sent to your selected model provider (DeepSeek, OpenAI or Anthropic). Turning this off stops future imported-evidence reads; earlier written answers and saved plans remain and may appear in chat history. An image association supplies metadata only. To let the model inspect an image, choose it as a reference attachment in chat.</span></span></label>
      <p className="mt-3 border-t border-line pt-3 text-xs text-fg-subtle">Platform improvement sharing is unavailable. AI analysis permission does not enable sharing.</p>
    </div>}
    {importing && !archived && <form onSubmit={upload} className="rounded-xl border border-line bg-surface p-4">
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-60"><legend className="mb-3 text-sm font-medium">Import aggregate or daily evidence</legend>
        <p className="text-xs text-fg-muted">Upload the supported Roblox aggregate ZIP/CSV, or a Romanum daily CSV v1. Daily imports use the canonical template; native Roblox daily exports are not yet verified.</p>
        <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(CANONICAL_DAILY_CSV)}`} download="Romanum_Daily_v1_Ads_AllUsers.csv" className={`${BUTTON} w-fit`}>Download daily CSV template</a>
        <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(CANONICAL_DAILY_CSV)}`} download="Romanum_Daily_v1_Campaigns_AllUsers.csv" className={`${BUTTON} ml-2 w-fit`}>Campaign daily template</a>
        <p className="text-xs text-fg-muted">Fill the template without changing its headers. Its filename identifies Ads and AllUsers; use Campaigns for campaign rows and NewUsers, ReturningUsers, 7DResurrected or 30DResurrected for other cohorts. Daily imports require both reporting period dates. Aggregate filename dates identify the reporting window, which may differ from campaign lifetime dates.</p>
        <label className="block text-sm">Report file (up to 10 MB)<input ref={fileInput} type="file" accept=".zip,.csv,application/zip,text/csv" required onChange={event => setFile(event.target.files?.[0] ?? null)} className={`mt-2 block w-full min-w-0 text-xs file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-line file:bg-canvas file:px-3 file:text-fg ${FOCUS}`} /></label>
        <p className="text-xs text-fg-muted">Enter the context you know. Leave a field blank to explicitly record it as unknown. Ad Credit does not establish USD.</p>
        <div className="grid gap-4 sm:grid-cols-2">{(Object.keys(EMPTY_CONTEXT) as (keyof AdReportContext)[]).map(key => <label key={key} className="block text-sm">{{ periodStart: "Reporting period start", periodEnd: "Reporting period end", timezone: "Time zone", attributionWindow: "Attribution window", audience: "Audience", placement: "Placement", currency: "Currency or spend unit" }[key]}<input type={key === "periodStart" || key === "periodEnd" ? "date" : "text"} value={context[key] ?? ""} onChange={event => setContext(before => ({ ...before, [key]: event.target.value || null }))} maxLength={200} placeholder={{ timezone: "e.g. America/New_York, or unknown", attributionWindow: "e.g. 7-day click, or unknown", audience: "Targeting/cohort context, or unknown", placement: "e.g. sponsored experience, or unknown", currency: "e.g. Ad Credit, or unknown", periodStart: "", periodEnd: "" }[key]} className={FIELD} /></label>)}</div>
      </fieldset><button type="submit" disabled={busy || !file} className={`${BUTTON} mt-5`}>{busy ? "Importing…" : "Import privately"}</button>
    </form>}
    {data?.reports.length === 0 && <p className="text-sm text-fg-muted">No reports yet. Import an export to inspect paid performance and attach its creative images.</p>}
    {data && data.reports.map(report => {
      const reportGroups = [...new Set(report.bundle.files.map(groupKey))];
      const ads = [...new Map(report.bundle.files.flatMap(file => file.rows.filter(row => row.adId).map(row => [row.adId!, row.adName || row.adId!] as const))).entries()];
      return <article key={report.id} className="rounded-xl border border-line p-4">
        <header className="flex items-start gap-3"><label className="flex min-h-11 min-w-0 flex-1 items-start gap-3"><input type="checkbox" checked={selected.includes(report.id)} disabled={!selected.includes(report.id) && selected.length >= 20} onChange={event => setSelected(before => event.target.checked ? [...before, report.id] : before.filter(id => id !== report.id))} className={`mt-1 size-4 shrink-0 accent-white ${FOCUS}`} /><span className="min-w-0 break-words text-sm font-medium">{reportName(report)}<span className="mt-1 block text-xs font-normal text-fg-subtle">Select as comparison and saved-observation evidence (up to 20 reports)</span></span></label>{!archived && <button type="button" disabled={busy} onClick={() => setRemoving(report.id)} className={`${BUTTON} shrink-0`}>Delete</button>}</header>
        <p className="mt-3 break-words text-xs text-fg-muted">{contextText(report.context)}</p><p className="mt-2 break-all text-[11px] text-fg-subtle">Report ID {report.id} · SHA-256 {report.bundle.sha256}</p>
        {!!report.bundle.warnings.length && <ul className="mt-3 space-y-1 text-xs text-fg-muted">{report.bundle.warnings.map((warning, index) => <li key={index}>Warning: {warning}</li>)}</ul>}
        <p className="mt-3 text-xs text-fg-subtle">Unknown cells are unavailable; zero is a measured zero. Spend uses the stated currency/unit. Paid CTR and plays / impressions are calculated from counts.</p>
        {reportGroups.map(key => <details key={key} className="mt-4 border-t border-line pt-3"><summary className={`min-h-11 cursor-pointer text-sm ${FOCUS}`}>{key.split("|").join(" · ")}</summary><Rows files={report.bundle.files.filter(file => groupKey(file) === key)} /></details>)}
        {ads.length > 0 && <details className="mt-4 border-t border-line pt-3"><summary className={`min-h-11 cursor-pointer text-sm ${FOCUS}`}>Associate ad IDs with creative images ({ads.length})</summary><p className="mb-3 text-xs text-fg-muted">Choose an existing project reference yourself. Names and filenames do not establish an association. Add missing images in References.</p>{referencesError && <p role="alert" className="mb-3 text-xs text-fg-muted">{referencesError}</p>}
          <div className="space-y-4">{ads.map(([adId, name]) => {
            const linked = data.links.find(link => link.reportId === report.id && link.adId === adId); const reference = references.find(item => item.id === linked?.creativeId);
            return <div key={adId} className="flex items-start gap-3">{reference && <Image src={`/api/projects/${projectId}/references/${reference.id}`} alt={`Linked creative: ${reference.label}`} width={reference.width} height={reference.height} unoptimized className="mt-2 h-16 w-20 shrink-0 rounded border border-line object-contain" />}<label className="block min-w-0 flex-1 text-sm"><span className="break-words">{name} · Ad {adId}</span><select aria-label={`Creative image for ad ${adId}`} value={linked?.creativeId ?? ""} disabled={busy || archived || !references.length} onChange={event => { if (event.target.value) void mutate({ action: "link", reportId: report.id, adId, creativeId: event.target.value }, "Creative association saved."); }} className={FIELD}><option value="" disabled>Choose a project reference</option>{references.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>{linked && !reference && <span className="mt-1 block text-xs text-fg-muted">Linked reference is unavailable.</span>}</label></div>;
          })}</div>
        </details>}
        {removing === report.id && <div className="mt-4 rounded-lg border border-line p-3"><p className="text-sm">Delete this report? Its creative associations and every saved observation citing it will also be deleted.</p><div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={busy} onClick={async () => { if (await mutate({ action: "delete", reportId: report.id }, "Report and its dependent evidence history deleted.")) setRemoving(null); }} className={BUTTON}>Delete report and cited observations</button><button type="button" disabled={busy} onClick={() => setRemoving(null)} className={BUTTON}>Cancel</button></div></div>}
      </article>;
    })}
    {chosen.length > 0 && <section className="space-y-4 border-t border-line pt-5"><h3 className="text-sm font-medium">Selected evidence ({chosen.length} reports)</h3>{groups.length > 0 && <label className="block text-sm">Compare one grain, cohort and entity<select value={comparisonGroup} onChange={event => setGroup(event.target.value)} className={FIELD}>{groups.map(key => <option key={key} value={key}>{key.split("|").join(" · ")}</option>)}</select></label>}<Comparison reports={chosen} group={comparisonGroup} /></section>}
    {data && <section className="space-y-4 border-t border-line pt-5"><h3 className="text-sm font-medium">Private learning history</h3><p className="text-xs text-fg-muted">Save observations and hypotheses backed by selected report IDs. These records are evidence history, not universal learned truth or proof that a creative caused a result.</p>
      {!archived && <form onSubmit={async event => { event.preventDefault(); if (await mutate({ action: "observation", status, text, reportIds: selected, ...(supersedes ? { supersedesId: supersedes } : {}) }, "Private evidence note saved.")) { setText(""); setSupersedes(""); } }}>
        <label className="block text-sm">Record type<select value={status} onChange={event => setStatus(event.target.value)} disabled={busy} className={FIELD}><option value="observation">Observation</option><option value="hypothesis">Hypothesis to test</option><option value="tested">Test result (owner recorded)</option></select></label>
        {!!data.observations.length && <label className="mt-4 block text-sm">Revises an earlier note (optional)<select value={supersedes} onChange={event => setSupersedes(event.target.value)} disabled={busy} className={FIELD}><option value="">New independent note</option>{data.observations.map(note => <option key={note.id} value={note.id}>{note.status}: {note.text.slice(0, 80)}</option>)}</select></label>}
        <label className="mt-4 block text-sm">Evidence and interpretation<textarea value={text} onChange={event => setText(event.target.value)} required maxLength={4000} rows={4} disabled={busy} placeholder="Describe the metric, report/cohort and alternative explanations. State what you would test next." className={FIELD} /></label><p className="mt-2 text-xs text-fg-muted">Evidence: {selected.length ? selected.map(id => id.slice(0, 8)).join(", ") : "Select at least one report above."}</p><button type="submit" disabled={busy || !selected.length || !text.trim()} className={`${BUTTON} mt-3`}>Save private note</button>
      </form>}
      {data.observations.length ? <ol className="space-y-3">{data.observations.map(observation => <li key={observation.id} className="rounded-lg border border-line p-3"><p className="text-xs text-fg-subtle">{observation.status} · {new Date(observation.createdAt).toLocaleDateString()}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{observation.text}</p><p className="mt-2 break-words text-xs text-fg-muted">Report evidence: {observation.reportIds.map(id => id.slice(0, 8)).join(", ")}</p>{observation.supersedesId && <p className="mt-1 text-xs text-fg-subtle">Revises note {observation.supersedesId.slice(0, 8)}</p>}</li>)}</ol> : <p className="text-sm text-fg-muted">No saved evidence notes yet.</p>}
      {!archived && <div className="border-t border-line pt-4">{data.settings.aiAnalysis && selected.length > 0 ? <Link href={`/chats?project=${projectId}&prompt=${encodeURIComponent(planningPrompt)}`} className={BUTTON}>Plan a thumbnail test from selected evidence</Link> : <><Link href={`/chats?project=${projectId}`} className={BUTTON}>Open project chat for written thumbnail planning</Link><p className="mt-2 text-xs text-fg-muted">To use imported evidence in AI planning, enable AI analysis and select reports above.</p></>}<p className="mt-2 text-xs text-fg-subtle">The link opens a written planning request for review in chat. No image generation is started here.</p></div>}
    </section>}
  </section>;
}
