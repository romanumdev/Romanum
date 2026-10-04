"use client";

import { useEffect, useState } from "react";
import { ImplementationBriefCard } from "@/components/implementation/brief-card";
import type { Experiment } from "@/lib/experiments/schema";
import type { ExperimentResult } from "@/lib/experiments/results";
import { TaskFields, taskMetadata, buttonClass, type TaskFieldsValue } from "./task-fields";

const labels: Record<ExperimentResult["reason"], string> = { descriptive_change: "Descriptive before/after comparison", coverage_below_threshold: "Insufficient paired observations", window_not_complete: "Waiting for the full after-release week", release_date_missing: "Add your release date", target_game_missing: "Add the target game universe ID", metric_unavailable: "Private metric data unavailable", history_unavailable: "No recorded history in these windows" };
const caveatLabels: Record<string, string> = { client_supplied_snapshot: "Saved brief snapshot", historical_sample: "Historical sample", gameplay_unverified: "Gameplay unverified", search_candidates: "Search candidates", research_incomplete: "Research incomplete", legacy_unverified: "Legacy suggestion" };
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
function Results({ result }: { result: ExperimentResult }) {
  return <div className="mt-3 rounded-lg border border-line p-3 text-xs leading-5 text-fg-muted">
    <p className="font-medium text-fg">{labels[result.reason]}</p>
    {result.windows && <p className="mt-1">UTC weeks: {result.windows.before.from.slice(0, 10)} to {result.windows.before.to.slice(0, 10)} before; {result.windows.after.from.slice(0, 10)} to {result.windows.after.to.slice(0, 10)} after (ends excluded).</p>}
    {result.pairs.length > 0 && <p>{result.coverage.paired}/{result.coverage.expectedPerWindow} paired five-minute slots. Gaps: {result.coverage.beforeGaps} before, {result.coverage.afterGaps} after. At least {result.semantics.minimumPairedCoverage * 100}% paired coverage required.</p>}
    {result.summary && <dl className="mt-2 grid grid-cols-2 gap-1"><dt>Mean concurrent players, before</dt><dd>{number(result.summary.beforeMeanPlaying)}</dd><dt>Mean concurrent players, after</dt><dd>{number(result.summary.afterMeanPlaying)}</dd><dt>Descriptive change</dt><dd>{number(result.summary.absoluteChange)} ({result.summary.percentChange === null ? "percentage undefined from zero" : `${number(result.summary.percentChange)}%`})</dd></dl>}
    {result.freshness.latestObservedAt && <p className="mt-1">Latest game observation: {result.freshness.latestObservedAt}{result.freshness.stale ? " · Older than 30 minutes" : ""}.</p>}
    <p className="mt-2">Same weekday and UTC slots · Public samples · Gaps excluded · Release time unknown · Descriptive, no causal attribution</p>
  </div>;
}

function ExperimentEditor({ experiment, onSaved, onDeleted, reload }: { experiment: Experiment; onSaved: (experiment: Experiment) => void; onDeleted: () => void; reload: () => void }) {
  const [value, setValue] = useState<TaskFieldsValue>({ title: experiment.title, universeId: experiment.universeId?.toString() ?? "", intendedMetric: experiment.intendedMetric, status: experiment.status, releaseDate: experiment.releaseDate ?? "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [result, setResult] = useState<ExperimentResult | null>(null);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(""); setConflict(false);
    try {
      const response = await fetch(`/api/experiments/${experiment.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...taskMetadata(value), revision: experiment.revision }) });
      const data = await response.json();
      if (!response.ok) { setConflict(response.status === 409); throw new Error(data.error ?? "Could not save this task."); }
      onSaved(data.experiment); setResult(null); setMessage("Task updated.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save this task."); }
    finally { setBusy(false); }
  }
  async function compare() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/experiments/${experiment.id}/results`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Results unavailable.");
      setResult(data.result);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Results unavailable."); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setMessage(""); setConflict(false);
    try {
      const response = await fetch(`/api/experiments/${experiment.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: experiment.revision }) });
      const data = await response.json();
      if (!response.ok) { setConflict(response.status === 409); throw new Error(data.error ?? "Could not delete this task."); }
      onDeleted();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not delete this task."); }
    finally { setBusy(false); }
  }
  return <article className="rounded-xl border border-line bg-surface p-4">
    <h2 className="font-semibold text-fg">{experiment.title}</h2>
    <form onSubmit={save} className="mt-3 space-y-3">
      <TaskFields value={value} onChange={setValue} />
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy} className={buttonClass}>Save changes</button><button type="button" disabled={busy} className={buttonClass} onClick={compare}>Check saved before/after results</button><button type="button" disabled={busy} className={buttonClass} onClick={remove}>Delete task</button>{conflict && <button type="button" onClick={reload} className={buttonClass}>Reload latest tasks</button>}</div>
    </form>
    <p role="status" aria-live="polite" className="mt-2 text-xs text-fg-muted">{message}</p>
    {result && <Results result={result} />}
    <details className="mt-3 text-xs text-fg-muted"><summary className="cursor-pointer text-fg">Saved brief and supporting evidence</summary>
      <p className="mt-2">{experiment.evidence.caveats.map(caveat => caveatLabels[caveat] ?? caveat).join(" · ")}</p>
      {experiment.evidence.sources.length > 0 && <ul className="mt-2 space-y-1">{experiment.evidence.sources.map((source, index) => <li key={index}>{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-fg underline">{source.label}</a> : source.label}{source.playing !== undefined ? ` · ${number(source.playing)} players observed` : ""}{source.observedAt ? ` · ${source.observedAt}` : ""}</li>)}</ul>}
      <ImplementationBriefCard brief={experiment.brief} trackable={false} />
    </details>
  </article>;
}

export function ExperimentsPanel() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [message, setMessage] = useState("Loading tracked tasks…");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/experiments", { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Tracked tasks unavailable.");
      setExperiments(data.experiments); setMessage(data.experiments.length ? "" : "Save a prepared implementation brief as a tracked task to get started.");
    }).catch(error => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Tracked tasks unavailable."); });
    return () => controller.abort();
  }, [version]);
  const reload = () => setVersion(value => value + 1);
  return <div className="space-y-4"><p role="status" className="text-sm text-fg-muted">{message}</p>{experiments.map(experiment => <ExperimentEditor key={`${experiment.id}:${version}`} experiment={experiment} reload={reload} onDeleted={() => { setExperiments(current => current.filter(item => item.id !== experiment.id)); setMessage("Task deleted."); }} onSaved={saved => setExperiments(current => current.map(item => item.id === saved.id ? saved : item))} />)}</div>;
}
