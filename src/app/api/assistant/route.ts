import type OpenAI from "openai";
import { assistantClient, assistantRequest, runAssistant } from "@/lib/assistant/engine";
import { assertSelectionReady, ModelSelectionError, requestModelSelection, resolveAssistantModel } from "@/lib/assistant/model-selection";
import type { ModelSelection } from "@/lib/models/types";
import type { ApiMessage, AssistantEvent } from "@/lib/assistant/types";
import { welcomeGuest } from "@/lib/credits/guest";
import { welcomeAccount } from "@/lib/credits/account";
import { assistantBilling } from "@/lib/assistant/billing";
import { ensureOwner, readAccount } from "@/lib/accounts/session";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase, type Database } from "@/lib/history/database";
import { verificationResponse } from "@/lib/turnstile";
import { privateAnalyticsTools } from "@/lib/linked-games/assistant-tools";
import { usesBackgroundChatWorker } from "@/lib/chats/run-dispatch";
import { ChatError, isChatId, modelConversation, recordEvent, saveAnswer, type TimedEvent } from "@/lib/chats/store";
import { ChatRunBusyError, submitChatQuestion } from "@/lib/chats/runs";

const MAX_MESSAGES = 80;
const MAX_USER_CHARS = 4000;
const MAX_BODY_CHARS = 500_000;

function isToolCall(value: unknown): value is OpenAI.Chat.ChatCompletionMessageFunctionToolCall {
  if (!value || typeof value !== "object") return false;
  const call = value as Record<string, unknown>;
  const fn = call.function as Record<string, unknown> | undefined;
  return (
    typeof call.id === "string" &&
    call.type === "function" &&
    typeof fn?.name === "string" &&
    typeof fn?.arguments === "string"
  );
}

/** Accepts only the message shapes this route produces, ending with the new user message. */
function parseMessages(body: unknown): ApiMessage[] | null {
  const list = body && typeof body === "object" ? (body as { messages?: unknown }).messages : null;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MESSAGES) return null;

  const messages: ApiMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const msg = item as Record<string, unknown>;

    if (msg.role === "user") {
      if (typeof msg.content !== "string" || !msg.content.trim() || msg.content.length > MAX_USER_CHARS) return null;
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(isToolCall) : [];
      messages.push({
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
        ...(typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (msg.role === "tool") {
      if (typeof msg.tool_call_id !== "string" || typeof msg.content !== "string") return null;
      messages.push({ role: "tool", tool_call_id: msg.tool_call_id, content: msg.content });
    } else {
      return null;
    }
  }
  return messages.at(-1)?.role === "user" ? messages : null;
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return Response.json({ error: "Request rejected." }, { status: 403 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return Response.json({ error: "The conversation is too long." }, { status: 413 });
  let history: ApiMessage[] | null = null;
  let modelSelection: ModelSelection;
  let saveConversation = false;
  let chatId: string | null = null;
  try {
    const body = JSON.parse(raw);
    history = parseMessages(body);
    saveConversation = body?.saveConversation === true;
    if (saveConversation) {
      if (body.chatId != null && !isChatId(body.chatId)) return Response.json({ error: "Invalid chat." }, { status: 400 });
      chatId = body.chatId ?? null;
      // Saved history is authoritative; clients submit just the new question.
      if (history?.length !== 1) return Response.json({ error: "Send one new question to the saved conversation." }, { status: 400 });
    }
    modelSelection = requestModelSelection(body?.modelSelection, Object.hasOwn(body ?? {}, "modelSelection"));
    assertSelectionReady(modelSelection);
  } catch (error) {
    if (error instanceof ModelSelectionError) return Response.json({ error: error.message, decision: error.decision }, { status: error.status, headers: { "cache-control": "no-store" } });
    // Handled below.
  }
  if (!history) return Response.json({ error: "Invalid conversation." }, { status: 400 });
  let conversation = history;
  const question = history[history.length - 1];

  // Answers spend credits, so the owner needs some before the model is called.
  let db: Database;
  let owner: string;
  let accountId: string | undefined;
  let availableCredits: number;
  try {
    const database = await historyDatabase();
    if (!database) throw new Error("No database is configured.");
    db = database;
    owner = await ensureOwner(request);
    const account = await readAccount();
    if (account?.ownerId === owner) accountId = account.id;
    const balance = account?.ownerId === owner ? await welcomeAccount(db, account.id) : await welcomeGuest(db, owner);
    availableCredits = balance.available;
    if (balance.available < 1) return Response.json({ error: "You're out of credits." }, { status: 402 });
  } catch (error) {
    const verification = verificationResponse(error);
    if (verification) return verification;
    return Response.json({ error: "Credits unavailable. Try again later." }, { status: 503 });
  }

  const abort = new AbortController();
  const timeBudget = usesBackgroundChatWorker() ? 25_000 : undefined;
  const analyticsTools = accountId ? privateAnalyticsTools(db, accountId, abort.signal, timeBudget ? { signal: AbortSignal.timeout(timeBudget) } : {}) : undefined;
  let modelRoute;
  let saved: Awaited<ReturnType<typeof submitChatQuestion>>["saved"] | null = null;
  try {
    if (saveConversation) {
      const submitted = await submitChatQuestion(db, { ownerId: owner, chatId, question: String(question.content), attachments: [] }, null, persisted => {
        conversation = modelConversation(persisted.history, { role: "user", content: persisted.question });
        return resolveAssistantModel(modelSelection!, assistantRequest(conversation, { analyticsTools }), availableCredits);
      });
      saved = submitted.saved;
      modelRoute = submitted.modelRoute!;
    } else modelRoute = resolveAssistantModel(modelSelection!, assistantRequest(conversation, { analyticsTools }), availableCredits);
  }
  catch (error) {
    if (error instanceof ModelSelectionError) return Response.json({ error: error.message, decision: error.decision }, { status: error.status, headers: { "cache-control": "no-store" } });
    if (error instanceof ChatError) return Response.json({ error: error.message }, { status: error.code === "not_found" ? 404 : 400, headers: { "cache-control": "no-store" } });
    if (error instanceof ChatRunBusyError) return Response.json({ error: error.message }, { status: 409, headers: { "cache-control": "no-store" } });
    return Response.json({ error: "The model selection could not be validated." }, { status: 503 });
  }
  const client = modelRoute.modelDecision?.modelId === "deepseek-flash" ? assistantClient(process.env.DEEPSEEK_API_KEY ?? "") : undefined;
  request.signal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const events: TimedEvent[] = [];
      const started = Date.now();
      let turn: ApiMessage[] | null = null;
      const send = (event: AssistantEvent) => {
        if (saved) recordEvent(events, event, Date.now() - started);
        if (event.type === "done") turn = event.messages;
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const billing = saved ? assistantBilling(db, owner, "ask", { conversationId: saved.chatId, runId: saved.questionId }) : assistantBilling(db, owner, "ask");
      try {
        await runAssistant({ client, conversation, send, signal: abort.signal, billing, analyticsTools, analysisTimeBudgetMs: timeBudget, modelRoute });
      } finally {
        if (billing.credits) send({ type: "usage", credits: billing.credits });
        if (saved) {
          if (!turn && !events.some(({ e }) => e.type === "error")) send({ type: "error", message: abort.signal.aborted ? "Stopped." : "The response ended before completion." });
          try {
            const committed = await saveAnswer(db, { ownerId: owner, chatId: saved.chatId, question: { role: "user", content: saved.question }, turn, events });
            // This acknowledgement is deliberately after persistence, never a model-controlled action.
            if (committed && !closed) controller.enqueue(encoder.encode(`${JSON.stringify({ type: "conversation_saved", chatId: saved.chatId })}\n`));
          } catch {
            send({ type: "error", message: "The answer could not be saved. Keep this page open to copy it." });
          }
        }
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", ...(saved ? { "x-chat-id": saved.chatId } : {}) },
  });
}
