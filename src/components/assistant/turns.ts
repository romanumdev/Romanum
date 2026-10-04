import type { ChartSpec } from "@/lib/charts/spec";
import type { AssistantEvent, SavedPlanCard } from "@/lib/assistant/types";
import { MODEL_IDS, type ModelId, type ModelSelection, type RouteDecision } from "../../lib/models/types.ts";
import { implementationBriefSchema, type ImplementationBrief } from "../../lib/implementation/brief.ts";

export type Step =
  | { kind: "thinking"; id: string; text: string; startedAt: number; endedAt: number | null }
  | {
      kind: "tool";
      id: string;
      label: string;
      activity: string;
      detail: string;
      input: unknown;
      status: "running" | "done" | "error";
      summary?: string;
      result?: unknown;
      ms?: number;
      startedAt: number;
      endedAt: number | null;
    }
  /** A short line the model wrote between steps, like "I'll look that up". */
  | { kind: "note"; id: string; text: string };

/** One question and everything the assistant did to answer it. */
export type Turn = {
  id: string;
  question: string;
  /** Reference images sent with the question, in chats. */
  attachments?: { id: string; name: string; url: string }[];
  steps: Step[];
  charts: { id: string; chart: ChartSpec }[];
  plans: SavedPlanCard[];
  briefs?: { id: string; brief: ImplementationBrief }[];
  chatOffer?: string;
  answer: string[];
  /** Text still streaming: it becomes a note if more steps follow, or part of the answer. */
  pending: string;
  error: string | null;
  done: boolean;
  /** What the answer cost, in credits, once it has been charged. */
  credits?: number;
  modelSelection?: ModelSelection;
  modelDecision?: RouteDecision | null;
  modelResolvedAt?: string;
  legacyModel?: true;
  /** Separate from the proposal: recorded when the provider actually returns output. */
  actualModel?: ModelId;
};

const NOTE_MAX_CHARS = 160;

export function newTurn(id: string, question: string): Turn {
  return { id, question, steps: [], charts: [], plans: [], answer: [], pending: "", error: null, done: false };
}

function closeThinking(steps: Step[], now: number): Step[] {
  const last = steps.at(-1);
  if (last?.kind !== "thinking" || last.endedAt !== null) return steps;
  return [...steps.slice(0, -1), { ...last, endedAt: now }];
}

/** Short text followed by more work is narration and folds into the steps; anything else is answer. */
function settlePending(turn: Turn, moreStepsFollow: boolean): Turn {
  const text = turn.pending.trim();
  if (!text) return { ...turn, pending: "" };
  if (moreStepsFollow && text.length <= NOTE_MAX_CHARS && !text.includes("\n")) {
    return { ...turn, pending: "", steps: [...turn.steps, { kind: "note", id: crypto.randomUUID(), text }] };
  }
  return { ...turn, pending: "", answer: [...turn.answer, text] };
}

export function finishTurn(turn: Turn, now: number, error: string | null = null): Turn {
  const settled = settlePending(turn, false);
  const steps = closeThinking(settled.steps, now).map((step) =>
    step.kind === "tool" && step.status === "running"
      ? { ...step, status: "error" as const, summary: "Stopped", endedAt: now }
      : step,
  );
  return { ...settled, steps, error: settled.error ?? error, done: true };
}

/** Folds one streamed event into the turn. */
export function applyEvent(turn: Turn, event: AssistantEvent, now: number): Turn {
  switch (event.type) {
    case "model_selection": {
      const selection = event.modelSelection;
      if (!selection || !(selection.mode === "auto" || (selection.mode === "explicit" && MODEL_IDS.includes(selection.modelId))) || !Number.isFinite(Date.parse(event.resolvedAt))) return turn;
      return { ...turn, modelSelection: selection, modelDecision: event.decision, modelResolvedAt: event.resolvedAt, legacyModel: event.legacy === true ? true : undefined };
    }
    case "model":
      return MODEL_IDS.includes(event.modelId) && (!turn.modelDecision || (turn.modelDecision.status === "selected" && turn.modelDecision.modelId === event.modelId)) ? { ...turn, actualModel: event.modelId } : turn;
    case "project_context":
    case "conversation_saved":
      return turn;
    case "implementation_brief": {
      const parsed = implementationBriefSchema.safeParse(event.brief);
      return parsed.success ? { ...turn, briefs: [...(turn.briefs ?? []).filter(item => item.id !== event.id), { id: event.id, brief: parsed.data }] } : turn;
    }
    case "chat_offer":
      return typeof event.reason === "string" && event.reason.trim().length > 0 && event.reason.length <= 240 ? { ...turn, chatOffer: event.reason } : turn;
    case "thinking": {
      const settled = settlePending(turn, true);
      const last = settled.steps.at(-1);
      if (last?.kind === "thinking" && last.endedAt === null) {
        return { ...settled, steps: [...settled.steps.slice(0, -1), { ...last, text: last.text + event.delta }] };
      }
      const step: Step = { kind: "thinking", id: crypto.randomUUID(), text: event.delta, startedAt: now, endedAt: null };
      return { ...settled, steps: [...settled.steps, step] };
    }
    case "text":
      return { ...turn, steps: closeThinking(turn.steps, now), pending: turn.pending + event.delta };
    case "tool_start": {
      const settled = settlePending(turn, true);
      const step: Step = {
        kind: "tool",
        id: event.id,
        label: event.label,
        activity: event.activity,
        detail: event.detail,
        input: event.input,
        status: "running",
        startedAt: now,
        endedAt: null,
      };
      return { ...settled, steps: [...closeThinking(settled.steps, now), step] };
    }
    case "tool_end":
      return {
        ...turn,
        steps: turn.steps.map((step) =>
          step.kind === "tool" && step.id === event.id
            ? { ...step, status: event.ok ? "done" : "error", summary: event.summary, result: event.result, ms: event.ms, endedAt: now }
            : step,
        ),
      };
    case "chart":
      return { ...turn, charts: [...turn.charts, { id: event.id, chart: event.chart }] };
    case "asset_plan":
      return { ...turn, plans: [...turn.plans.filter((plan) => plan.id !== event.plan.id), event.plan] };
    case "error": {
      const settled = settlePending(turn, false);
      return { ...settled, steps: closeThinking(settled.steps, now), error: event.message };
    }
    case "done":
      return finishTurn(turn, now);
    case "suggestion":
      // Ignore legacy prompt-bar suggestions.
      return turn;
    case "usage":
      return { ...turn, credits: event.credits };
  }
}
