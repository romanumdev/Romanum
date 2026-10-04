import type OpenAI from "openai";
import type { ChartSpec } from "@/lib/charts/spec";
import type { ProjectBrief } from "../projects/store.ts";
import type { ModelId, ModelSelection, RouteDecision } from "../models/types.ts";
import type { ImplementationBrief } from "../implementation/brief.ts";

export type SavedPlanCard = { id: string; projectId: string; title: string; kind: "thumbnail" | "ui"; conceptCount: number };

/** DeepSeek returns its reasoning alongside the reply and needs it sent back on later requests. */
export type AssistantApiMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

/** Conversation history in the chat-completions format, as sent to /api/assistant. */
export type ApiMessage =
  | OpenAI.Chat.ChatCompletionUserMessageParam
  | AssistantApiMessage
  | OpenAI.Chat.ChatCompletionToolMessageParam;

/** One line of the NDJSON stream returned by /api/assistant. */
export type AssistantEvent =
  | { type: "model_selection"; modelSelection: ModelSelection; decision: RouteDecision | null; resolvedAt: string; legacy?: true }
  /** Emitted only after the selected provider starts returning chunks, including usage-only chunks. */
  | { type: "model"; modelId: ModelId }
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; label: string; activity: string; detail: string; input: unknown }
  | { type: "tool_end"; id: string; ok: boolean; summary: string; result: unknown; ms: number }
  | { type: "chart"; id: string; chart: ChartSpec }
  | { type: "asset_plan"; plan: SavedPlanCard }
  | { type: "project_context"; project: ProjectBrief }
  | { type: "implementation_brief"; id: string; brief: ImplementationBrief }
  | { type: "chat_offer"; reason: string }
  /** Server acknowledgement after the answer has committed to owner-scoped chat storage. */
  | { type: "conversation_saved"; chatId: string }
  | { type: "done"; messages: ApiMessage[] }
  /** Legacy event: ignored by clients and persistence; no longer generated. */
  | { type: "suggestion"; text: string }
  /** What the answer cost, in credits (usually a fraction of one). */
  | { type: "usage"; credits: number }
  | { type: "error"; message: string };
