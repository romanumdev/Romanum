import Image from "next/image";
import Link from "next/link";
import { ImplementationBriefCard } from "@/components/implementation/brief-card";
import { Brain, Check, ChevronRight, CircleAlert, LoaderCircle, X } from "lucide-react";
import { ChartCard } from "@/components/charts/chart-card";
import { Coin } from "@/components/coin";
import { PlanCard } from "@/components/projects/plan-card";
import { creditAmount, formatCredits } from "@/lib/credits/value";
import { AssistantMarkdown } from "./markdown";
import type { Step, Turn } from "./turns";

// Expandable rows use <details>; this hides the default disclosure triangle.
const SUMMARY = "flex cursor-pointer list-none items-start gap-2 rounded-md py-1 [&::-webkit-details-marker]:hidden";

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs text-fg-subtle">{title}</p>
      <pre className="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-xs leading-5 text-fg-muted">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function ToolRow({ step }: { step: Extract<Step, { kind: "tool" }> }) {
  const Icon = step.status === "running" ? LoaderCircle : step.status === "done" ? Check : X;
  return (
    <details className="group text-sm">
      <summary className={SUMMARY}>
        <Icon
          className={`mt-0.5 size-4 shrink-0 text-white ${step.status === "running" ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-fg">{step.label}</span>
          {step.detail && <span className="ml-2 text-fg-muted">{step.detail}</span>}
          {step.summary && <span className="block text-fg-muted">{step.summary}</span>}
        </span>
        {step.ms !== undefined && <span className="shrink-0 text-xs text-fg-subtle">{(step.ms / 1000).toFixed(1)}s</span>}
        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-white transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-2 mb-1 space-y-2 pl-6">
        <JsonBlock title="Input" value={step.input} />
        {step.result !== undefined && step.result !== null && <JsonBlock title="Result" value={step.result} />}
      </div>
    </details>
  );
}

function ThinkingRow({ step }: { step: Extract<Step, { kind: "thinking" }> }) {
  const seconds = step.endedAt === null ? null : Math.max(1, Math.round((step.endedAt - step.startedAt) / 1000));
  return (
    <details className="group text-sm">
      <summary className={SUMMARY}>
        <Brain className="mt-0.5 size-4 shrink-0 text-white" aria-hidden="true" />
        <span className="flex-1 text-fg-muted">{seconds === null ? "Thinking…" : `Thought for ${seconds}s`}</span>
        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-white transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <p className="mt-1 mb-1 pl-6 text-xs leading-5 whitespace-pre-wrap text-fg-subtle">{step.text}</p>
    </details>
  );
}

function headline(steps: Step[], active: boolean): string {
  if (active) {
    const current = [...steps]
      .reverse()
      .find((s) => (s.kind === "tool" && s.status === "running") || (s.kind === "thinking" && s.endedAt === null));
    if (current?.kind === "tool") return `${current.activity}…`;
    if (current?.kind === "thinking") return "Thinking…";
    return "Working…";
  }
  const timed = steps.filter((s): s is Exclude<Step, { kind: "note" }> => s.kind !== "note");
  const start = Math.min(...timed.map((s) => s.startedAt));
  const end = Math.max(...timed.map((s) => s.endedAt ?? s.startedAt));
  const seconds = Number.isFinite(start) ? Math.max(1, Math.round((end - start) / 1000)) : 0;
  if (timed.length === 1 && timed[0].kind === "thinking") return `Thought for ${seconds}s`;
  return `Worked for ${seconds}s · ${timed.length} ${timed.length === 1 ? "step" : "steps"}`;
}

/** An answer's price: the coin and the amount. Screen readers hear "0.25 credits". */
function CreditCost({ credits, className = "" }: { credits: number; className?: string }) {
  return (
    <span title={formatCredits(credits)} className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}>
      <Coin className="size-3.5 shrink-0 text-white" />
      {creditAmount(credits)}
      <span className="sr-only"> credits</span>
    </span>
  );
}

/** Everything the assistant did for one answer, collapsed to a single live status line, with its cost once charged. */
function ProcessGroup({ steps, active, credits }: { steps: Step[]; active: boolean; credits?: number }) {
  const failed = !active && steps.some((s) => s.kind === "tool" && s.status === "error");
  const Icon = active ? LoaderCircle : failed ? CircleAlert : Check;
  return (
    <details className="group/process text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-fg-muted [&::-webkit-details-marker]:hidden">
        <Icon className={`size-4 shrink-0 text-white ${active ? "animate-spin" : ""}`} aria-hidden="true" />
        <span className={active ? "text-fg" : ""}>
          {headline(steps, active)}
          {!active && credits !== undefined && (
            <>
              {" · "}
              <CreditCost credits={credits} className="align-[-0.15em]" />
            </>
          )}
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-white transition-transform group-open/process:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-1 ml-2 space-y-0.5 border-l border-line pl-4">
        {steps.length === 0 && <p className="py-1 text-fg-subtle">Waiting for the model…</p>}
        {steps.map((step) =>
          step.kind === "thinking" ? (
            <ThinkingRow key={step.id} step={step} />
          ) : step.kind === "tool" ? (
            <ToolRow key={step.id} step={step} />
          ) : (
            <p key={step.id} className="py-1 text-fg-muted">
              {step.text}
            </p>
          ),
        )}
      </div>
    </details>
  );
}

function TurnView({ turn, chatHref }: { turn: Turn; chatHref?: string }) {
  const text = [...turn.answer, turn.pending].filter(Boolean).join("\n\n");
  // The process line shows while the model works, and afterwards if it did anything.
  const working = !turn.done && !turn.pending;
  return (
    <div className="space-y-3">
      {turn.attachments && turn.attachments.length > 0 && (
        <div className="flex justify-end gap-2">
          {turn.attachments.map((file) => (
            <Image
              key={file.id}
              src={file.url}
              alt={file.name}
              width={96}
              height={96}
              unoptimized
              className="size-24 rounded-lg border border-line object-cover"
            />
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <p className="max-w-[min(85%,40rem)] rounded-lg bg-surface px-3 py-2 text-sm whitespace-pre-wrap text-fg">{turn.question}</p>
      </div>
      {(turn.steps.length > 0 || working) && <ProcessGroup steps={turn.steps} active={working} credits={turn.credits} />}
      {turn.actualModel && <p className="text-xs text-fg-subtle" title={turn.modelResolvedAt ? `Model selected ${turn.modelResolvedAt}` : undefined}>
        {turn.actualModel === "deepseek-flash" ? "DeepSeek Flash" : turn.actualModel}{turn.legacyModel ? " · Legacy" : turn.modelSelection?.mode === "auto" ? " · Auto" : " · Your choice"}
      </p>}
      {turn.charts.map(({ id, chart }) => (
        <ChartCard key={id} chart={chart} />
      ))}
      {turn.plans.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
      {(turn.briefs ?? []).map(({ id, brief }) => <ImplementationBriefCard key={id} brief={brief} />)}
      {turn.chatOffer && chatHref && turn.done && <div className="flex flex-wrap items-center gap-2 text-sm">
        <p className="text-fg-muted">{turn.chatOffer}</p>
        <Link href={chatHref} prefetch={false} className="rounded-lg border border-line px-3 py-2 text-fg hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2">Take this to chat</Link>
      </div>}
      {text && (
        // Charts may use the full width; prose stays at a comfortable line length.
        <div className="max-w-3xl text-sm leading-6 text-fg">
          <AssistantMarkdown text={text} />
        </div>
      )}
      {turn.error && (
        <p className="flex items-start gap-2 text-sm text-fg">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-white" aria-hidden="true" />
          {turn.error}
        </p>
      )}
      {/* Without a process line to carry it, the cost gets its own. */}
      {turn.credits !== undefined && turn.steps.length === 0 && !working && (
        <p className="text-xs text-fg-subtle">
          <CreditCost credits={turn.credits} />
        </p>
      )}
    </div>
  );
}

export function Transcript({ turns, chatId }: { turns: Turn[]; chatId?: string | null }) {
  const chatHref = typeof chatId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId) ? `/chats/${chatId}` : undefined;
  return (
    <div className="space-y-6">
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} chatHref={chatHref} />
      ))}
    </div>
  );
}
