"use client";

import { useId } from "react";
import { EXPERIMENT_LABELS, type ExperimentUpdate } from "@/lib/experiments/schema";

export type TaskFieldsValue = { title: string; universeId: string; intendedMetric: ExperimentUpdate["intendedMetric"]; status: ExperimentUpdate["status"]; releaseDate: string };
export const fieldClass = "mt-1 block w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg/70";
export const buttonClass = "rounded-md border border-line px-3 py-1.5 text-xs text-fg hover:bg-surface-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg/70";
export function taskMetadata(value: TaskFieldsValue) {
  return { title: value.title, universeId: value.universeId ? Number(value.universeId) : null, intendedMetric: value.intendedMetric, status: value.status, releaseDate: value.releaseDate || null };
}

export function TaskFields({ value, onChange }: { value: TaskFieldsValue; onChange: (value: TaskFieldsValue) => void }) {
  const id = useId();
  const set = <K extends keyof TaskFieldsValue>(key: K, next: TaskFieldsValue[K]) => onChange({ ...value, [key]: next });
  return <div className="grid gap-3 sm:grid-cols-2">
    <label htmlFor={`${id}-title`} className="text-xs text-fg-muted sm:col-span-2">Task title<input id={`${id}-title`} required maxLength={120} value={value.title} onChange={event => set("title", event.target.value)} className={fieldClass} /></label>
    <label htmlFor={`${id}-game`} className="text-xs text-fg-muted">Target game universe ID<input id={`${id}-game`} type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={value.universeId} onChange={event => set("universeId", event.target.value)} placeholder="Add when your game is ready" className={fieldClass} /></label>
    <label htmlFor={`${id}-metric`} className="text-xs text-fg-muted">Intended metric<select id={`${id}-metric`} value={value.intendedMetric} onChange={event => set("intendedMetric", event.target.value as TaskFieldsValue["intendedMetric"])} className={fieldClass}>{Object.entries(EXPERIMENT_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label htmlFor={`${id}-status`} className="text-xs text-fg-muted">Status<select id={`${id}-status`} value={value.status} onChange={event => set("status", event.target.value as TaskFieldsValue["status"])} className={fieldClass}><option value="planned">Planned</option><option value="in_progress">In progress</option><option value="released">Released</option><option value="archived">Archived</option></select></label>
    <label htmlFor={`${id}-date`} className="text-xs text-fg-muted">Release date (UTC, entered by you)<input id={`${id}-date`} type="date" value={value.releaseDate} onChange={event => set("releaseDate", event.target.value)} className={fieldClass} /></label>
  </div>;
}
