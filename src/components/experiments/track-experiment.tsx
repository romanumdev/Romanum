"use client";

import { useState } from "react";
import Link from "next/link";
import type { ImplementationBrief } from "@/lib/implementation/brief";
import { TaskFields, taskMetadata, buttonClass, type TaskFieldsValue } from "./task-fields";

export function TrackExperiment({ brief }: { brief: ImplementationBrief }) {
  const [value, setValue] = useState<TaskFieldsValue>({ title: brief.title, universeId: "", intendedMetric: "public_playing", status: "planned", releaseDate: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/experiments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...taskMetadata(value), brief }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save this task.");
      setSaved(true); setMessage("Task saved privately for this browser or account.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save this task."); }
    finally { setBusy(false); }
  }
  return <details className="mt-2 border-t border-line pt-2 text-xs text-fg-muted">
    <summary className="cursor-pointer rounded-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg/70">Track this development task</summary>
    {saved ? <Link href="/analytics/experiments" className="mt-2 inline-block text-fg underline">View tracked tasks</Link> : <form onSubmit={save} className="mt-3 space-y-3">
      <TaskFields value={value} onChange={setValue} />
      <p>Private brief and evidence snapshot, saved to your account or this browser&apos;s guest identity.</p>
      <button className={buttonClass} type="submit" disabled={busy}>{busy ? "Saving…" : "Save tracked task"}</button>
    </form>}
    <p role="status" aria-live="polite" className="mt-2">{message}</p>
  </details>;
}
