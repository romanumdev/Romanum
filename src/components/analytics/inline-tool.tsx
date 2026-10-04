"use client";
import { useState, type ReactNode } from "react";

/** Load private controls only after the reader opens them. */
export function InlineAnalyticsTool({ id, title, initialOpen = false, children, className = "" }: { id: string; title: string; initialOpen?: boolean; children: ReactNode; className?: string }) {
  const [opened, setOpened] = useState(initialOpen);
  return <details id={id} open={initialOpen} onToggle={event => { if (event.currentTarget.open) setOpened(true); }} className={`scroll-mt-6 rounded-xl border border-line p-4 ${className}`}>
    <summary className="cursor-pointer text-sm font-medium">{title}</summary>
    {opened && children}
  </details>;
}
