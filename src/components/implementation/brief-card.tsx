"use client";

import { useId, useRef, useState } from "react";
import { formatImplementationBrief, type ImplementationBrief } from "@/lib/implementation/brief";
import { TrackExperiment } from "@/components/experiments/track-experiment";

export function ImplementationBriefCard({ brief, trackable = true }: { brief: ImplementationBrief; trackable?: boolean }) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState("");
  const prompt = formatImplementationBrief(brief);

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(prompt);
      setStatus("Brief copied.");
    } catch {
      field.current?.focus();
      field.current?.select();
      setStatus("Brief selected. Use your device’s Copy command to copy it.");
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-fg">AI implementation brief</label>
        <button type="button" onClick={copy} className="rounded-md border border-line px-2.5 py-1 text-xs text-fg hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg/70">Copy brief</button>
      </div>
      <p className="mt-1 text-xs text-fg-muted">Review and paste into your AI coding tool. Copying is free.</p>
      <textarea id={id} ref={field} readOnly value={prompt} rows={6} spellCheck={false} className="mt-2 block w-full resize-y rounded-md border border-line bg-surface p-2 text-xs leading-5 text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg/70" />
      <p role="status" aria-live="polite" className="mt-1 text-xs text-fg-muted">{status}</p>
      {trackable && <TrackExperiment brief={brief} />}
    </div>
  );
}
