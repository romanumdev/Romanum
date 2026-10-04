"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Folder } from "lucide-react";
import { Transcript } from "@/components/assistant/transcript";
import { applyEvent, finishTurn, newTurn, type Turn } from "@/components/assistant/turns";
import type { AssistantEvent } from "@/lib/assistant/types";
import type { ChatSummary, StoredMessage } from "@/lib/chats/store";
import { Composer, type PendingImage } from "./composer";
import { CHATS_CHANGED, CREDITS_CHANGED } from "@/components/events";
import { RecentChats } from "./recent-chats";
import { useVerifiedFetch } from "../verification";
import {
  CHAT_RUN_PAGE_LIMIT,
  CHAT_RUN_POLL_MS,
  CHAT_RUN_MAX_RETRIES,
  ChatRunPollError,
  cancelChatRun,
  chatRunFailureMessage,
  chatRunRetryDelay,
  isTerminalChatRun,
  readChatRun,
  waitForChatRun,
  type ChatRunPage,
} from "@/lib/chats/poll-run";
import type { ProjectBrief, ProjectSummary } from "@/lib/projects/store";
import { ProjectPanel } from "./project-panel";
import { WorkspaceList } from "./workspace-list";
import contextStyles from "./project-context.module.css";
import { useModelCatalog } from "@/components/models/use-model-catalog";

import { replayChatMessages } from "@/components/assistant/replay";
export { replayChatMessages } from "@/components/assistant/replay";
const STARTERS = [
  { label: "Give me ideas", prompt: "Give me a few Roblox game ideas grounded in current data and existing games. Help me choose one before we work through its hooks, game design, roadmap and implementation." },
  { label: "I have an idea", prompt: "I have a Roblox game idea. Ask me about it, then help me work through its hooks and game design before we plan the roadmap and implementation." },
  { label: "I have a game already", prompt: "Help me work out the next steps for my existing Roblox game. Start by asking what I've built so far." },
];

/** A saved question whose answer never arrived keeps a terminal note, unless a run is still filling it in. */
function settle(turns: Turn[]): Turn[] {
  return turns.map((turn) => (turn.done ? turn : finishTurn(turn, 0, "No answer was saved.")));
}

/** A durable run's acknowledgement stream carries no answer; read it dry so its EOF is never mistaken for one. */
async function drainAcknowledgement(body: NonNullable<Response["body"]>) {
  try {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      if ((await reader.read()).done) break;
    }
  } catch {
    // The acknowledgement may close early; the answer arrives through the run endpoint regardless.
  }
}

/**
 * A chat: a new one (no chatId) or a saved one. The first question saves it and gives it its own address. Empty,
 * it shows the prompt bar in the middle with recent chats below; once it has messages, the bar sits at the bottom.
 */
export function ChatView({
  chatId,
  initialMessages,
  recent,
  connected,
  project: initialProject = null,
  canPlan = false,
  projects = [],
  archived = false,
  contextTab,
  initialPrompt,
  activeRun,
}: {
  chatId: string | null;
  initialMessages: StoredMessage[];
  recent: ChatSummary[] | null;
  connected: boolean;
  project?: ProjectBrief | null;
  canPlan?: boolean;
  projects?: ProjectSummary[];
  archived?: boolean;
  contextTab?: string;
  initialPrompt?: string;
  /** Set when a saved chat is reopened while its answer is still being produced server-side. */
  activeRun?: { id: string } | null;
}) {
  const verifiedFetch = useVerifiedFetch();
  const [initialTurns] = useState(() => replayChatMessages(initialMessages));
  // Reopening a chat restores the requested mode/choice, including an explicit choice now unavailable.
  const models = useModelCatalog(initialTurns.at(-1)?.modelSelection);
  const restoreSelection = models.setSelection;
  const [turns, setTurns] = useState<Turn[]>(() => {
    const saved = initialTurns;
    // A resumed run keeps its last turn open until the recorded events catch up to it.
    return activeRun && saved.length ? [...settle(saved.slice(0, -1)), saved[saved.length - 1]] : settle(saved);
  });
  const [running, setRunning] = useState(Boolean(activeRun));
  const [stopError, setStopError] = useState<string | null>(null);
  const stoppingRef = useRef(false);
  const [project, setProject] = useState(initialProject);
  const [contextExpanded, setContextExpanded] = useState(Boolean(contextTab));
  const [contextAnimation, setContextAnimation] = useState(0);
  const projectSaved = useCallback((next: ProjectBrief) => setProject(current => current?.id === next.id && current.revision > next.revision ? current : next), []);
  const chatRef = useRef(chatId);
  const abortRef = useRef<AbortController | null>(null);
  // An older stream may finish closing after the next question starts.
  const requestRef = useRef(0);
  // Follow new output unless the reader has scrolled up to read.
  const followRef = useRef(true);
  // Preview URLs of images sent from this page, released when it closes.
  const previews = useRef(new Set<string>());
  // Whether the page is still mounted, so an aborted poll never writes to a torn-down tree.
  const mountedRef = useRef(true);
  // The turn a run is filling in, and the durable run id to cancel if the reader stops it.
  const activeRef = useRef<{ turnId: string; runId: string | null } | null>(null);
  const restoreRunSelection = useRef(activeRun?.id ?? null);
  // How far each run has been read, so a re-render (or a dev remount) resumes instead of replaying.
  const cursorRef = useRef<{ id: string; cursor: number } | null>(null);

  useEffect(() => {
    const owned = previews.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Leaving the page detaches the reader; the run keeps going so a saved chat can finish later.
      abortRef.current?.abort();
      owned.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    const onScroll = () => {
      followRef.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (followRef.current && turns.length) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [turns]);

  const updateTurn = useCallback((turnId: string, change: (turn: Turn) => Turn) => {
    setTurns((prev) => prev.map((turn) => (turn.id === turnId ? change(turn) : turn)));
  }, []);

  /** Folds one event into a turn and runs the side effects every path shares, streaming or polled. */
  const applyIncoming = useCallback(
    (turnId: string, event: AssistantEvent, at: number) => {
      if (event.type === "model_selection" && restoreRunSelection.current && activeRef.current?.runId === restoreRunSelection.current) {
        const requested = applyEvent(newTurn("model", ""), event, at).modelSelection;
        if (requested) restoreSelection(requested);
        restoreRunSelection.current = null;
      }
      if (event.type === "project_context") {
        projectSaved(event.project);
        setContextAnimation((version) => version + 1);
        window.dispatchEvent(new Event(CHATS_CHANGED));
      } else if (event.type === "usage") {
        window.dispatchEvent(new Event(CREDITS_CHANGED));
      }
      updateTurn(turnId, (turn) => applyEvent(turn, event, at));
    },
    [projectSaved, updateTurn, restoreSelection],
  );

  /** Follows a durable run to its terminal status, applying its events and settling the turn. */
  const pollRun = useCallback(
    async (runId: string, turnId: string, request: number, controller: AbortController) => {
      // Resume from where this run was last read, so a re-render or dev remount never replays events.
      let cursor = cursorRef.current?.id === runId ? cursorRef.current.cursor : 0;
      let attempt = 0;
      let terminal: ChatRunPage | null = null;
      for (;;) {
        let page: ChatRunPage;
        try {
          page = await readChatRun(runId, cursor, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          const pollError = error instanceof ChatRunPollError ? error : new ChatRunPollError("Retrieving the answer failed.", false);
          if (pollError.retryable && attempt < CHAT_RUN_MAX_RETRIES) {
            attempt += 1;
            try {
              await waitForChatRun(controller.signal, chatRunRetryDelay(attempt));
            } catch {
              return;
            }
            continue;
          }
          if (mountedRef.current && request === requestRef.current) {
            setRunning(false);
            updateTurn(turnId, (turn) => (turn.done ? turn : finishTurn(turn, Date.now(), pollError.message)));
          }
          return;
        }
        if (controller.signal.aborted || !mountedRef.current || request !== requestRef.current) return;
        attempt = 0;
        for (const { e } of page.events) applyIncoming(turnId, e, Date.now());
        cursor = page.cursor;
        cursorRef.current = { id: runId, cursor };
        // A terminal status still drains: a page at the limit may have more events behind it.
        if (isTerminalChatRun(page.status) && page.events.length < CHAT_RUN_PAGE_LIMIT) {
          terminal = page;
          break;
        }
        if (!isTerminalChatRun(page.status)) {
          try {
            await waitForChatRun(controller.signal, CHAT_RUN_POLL_MS);
          } catch {
            return;
          }
        }
      }
      if (!terminal || !mountedRef.current || request !== requestRef.current) return;
      const message = terminal.status === "complete" && !terminal.error ? null : chatRunFailureMessage(terminal);
      updateTurn(turnId, (turn) => (turn.done ? turn : finishTurn(turn, Date.now(), message)));
      setRunning(false);
      window.dispatchEvent(new Event(CHATS_CHANGED));
    },
    [applyIncoming, updateTurn],
  );

  /** Explicit Stop: cancel the durable run server-side, then detach the reader and close the turn. */
  const stop = useCallback(async () => {
    const active = activeRef.current;
    if (stoppingRef.current) return;
    if (active?.runId) {
      stoppingRef.current = true;
      try {
        await cancelChatRun(active.runId);
      } catch {
        if (mountedRef.current && activeRef.current === active) setStopError("The review could not be stopped. It may still be running; try Stop again.");
        return;
      } finally { stoppingRef.current = false; }
      if (activeRef.current !== active) return;
    }
    setStopError(null);
    activeRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    if (active && mountedRef.current) {
      updateTurn(active.turnId, (turn) => (turn.done ? turn : finishTurn(turn, Date.now(), "Stopped.")));
    }
    setRunning(false);
  }, [updateTurn]);

  // The last turn is the one a reopened run is still filling in; its id is stable for this mount.
  const resumeTurnIdRef = useRef<string | null>(null);
  resumeTurnIdRef.current = turns.at(-1)?.id ?? null;
  const activeRunId = activeRun?.id ?? null;
  useEffect(() => {
    if (!activeRunId) return;
    const runId = activeRunId;
    const turnId = resumeTurnIdRef.current;
    if (!turnId) {
      setRunning(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const request = ++requestRef.current;
    activeRef.current = { turnId, runId };
    setRunning(true);
    void pollRun(runId, turnId, request, controller).finally(() => {
      if (activeRef.current?.runId === runId && request === requestRef.current) activeRef.current = null;
      if (abortRef.current === controller) abortRef.current = null;
      if (request === requestRef.current) setRunning(false);
    });
    // Leaving detaches this reader; the backend keeps working so the saved chat can finish later.
    return () => controller.abort();
    // Only a different run should restart the loop; events are deduplicated by the run's cursor.
  }, [activeRunId, pollRun]);

  async function ask(question: string, images: PendingImage[]) {
    if (running || !models.canSend) return;
    setStopError(null);
    // Close any remaining stream from the previous answer.
    abortRef.current?.abort();
    const request = ++requestRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const turnId = crypto.randomUUID();
    activeRef.current = { turnId, runId: null };
    const update = (change: (turn: Turn) => Turn) => setTurns((prev) => prev.map((turn) => (turn.id === turnId ? change(turn) : turn)));
    for (const image of images) previews.current.add(image.url);
    followRef.current = true;
    setRunning(true);
    setTurns((prev) => [
      ...prev,
      { ...newTurn(turnId, question), attachments: images.map((image) => ({ id: image.id, name: image.file.name, url: image.url })) },
    ]);

    const body = new FormData();
    if (chatRef.current) body.set("chatId", chatRef.current);
    if (project) body.set("projectId", project.id);
    body.set("text", question);
    body.set("modelSelection", JSON.stringify(models.selection));
    for (const image of images) body.append("files", image.file, image.file.name);

    try {
      const res = await verifiedFetch("/api/chats", { method: "POST", body, signal: controller.signal });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `The chat request failed (${res.status}).`);
      }
      const id = res.headers.get("x-chat-id");
      if (id && !chatRef.current) {
        chatRef.current = id;
        // The new chat gets its own address without reloading the page.
        window.history.replaceState(null, "", `/chats/${id}`);
      }
      window.dispatchEvent(new Event(CHATS_CHANGED));

      // A durable run acknowledges the request, then answers in the background; otherwise this is the answer.
      const runId = res.headers.get("x-chat-run-id");
      if (runId) {
        activeRef.current = { turnId, runId };
        void drainAcknowledgement(res.body);
        await pollRun(runId, turnId, request, controller);
        return;
      }

      // The route streams one JSON event per line.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as AssistantEvent;
          if (event.type === "done") setRunning(false);
          applyIncoming(turnId, event, Date.now());
        }
      }
      // If the stream ended without a "done" event, don't leave the turn spinning.
      update((turn) => (turn.done ? turn : finishTurn(turn, Date.now(), "The response ended unexpectedly.")));
    } catch (error) {
      const message = controller.signal.aborted ? "Stopped." : error instanceof Error ? error.message : "Something went wrong.";
      // A completed answer stays intact if its remaining stream is interrupted.
      update((turn) => (turn.done ? turn : finishTurn(turn, Date.now(), message)));
    } finally {
      if (activeRef.current?.turnId === turnId) activeRef.current = null;
      if (request === requestRef.current) setRunning(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  const empty = turns.length === 0;
  return (
    <div className={project ? `${contextStyles.workspace} ${contextExpanded ? contextStyles.workspaceExpanded : ""}` : undefined}>
    {/* The negative margin cancels the page's bottom padding, so the prompt bar can sit at the very bottom. */}
    <div
      className={`mx-auto -mb-6 flex min-h-[calc(100dvh-var(--mobile-nav-height)-1.5rem)] w-full min-w-0 max-w-3xl flex-col sm:-mb-8 sm:min-h-[calc(100dvh-var(--mobile-nav-height)-2rem)] ${
        empty ? "justify-center pb-6 sm:pb-8" : ""
      }`}
    >
      {project ? <header className="mb-6 flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 flex-1 items-center gap-2 text-sm"><Folder className="size-4 shrink-0" /><span className="truncate">{project.name}</span>{project.archived && <span className="text-xs text-fg-muted">Archived</span>}</div>{!project.archived && <Link href={`/chats?project=${project.id}`} className="rounded text-xs text-fg-muted hover:text-fg focus-visible:outline-2">New chat</Link>}</header> : !empty && canPlan ? <div className="mb-4 flex justify-end"><button type="button" disabled={running} onClick={() => void ask("Help me turn this conversation into a game plan. Ask about anything important that's missing, then save our agreed plan, roadmap and to-dos as project context.", [])} className="min-h-10 rounded-lg border border-line px-3 text-xs text-fg-muted hover:text-fg disabled:opacity-40">Plan this game</button></div> : null}
      {empty ? (
        <h1 key="heading" className="mb-6 text-center text-2xl font-semibold tracking-tight">
          {project?.archived ? "This project is archived" : "What are we making?"}
        </h1>
      ) : (
        <div key="transcript" className="flex-1 pb-6" aria-busy={running}>
          <Transcript turns={turns} />
        </div>
      )}
      {!(empty && project?.archived) && <div key="composer" className={empty ? "" : "sticky bottom-0 z-20 pb-[max(1rem,env(safe-area-inset-bottom))]"}>
        {/* The conversation scrolls under the bar through a blur that fades out above it. */}
        {!empty && (
          <div className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 -z-10 backdrop-blur-xl [mask-image:linear-gradient(to_top,black_calc(100%_-_2.5rem),transparent)] [@media(prefers-reduced-transparency:reduce)]:bg-canvas" />
        )}
        {stopError && <p role="alert" className="mb-2 text-sm text-fg-muted">{stopError}</p>}
        <Composer
          initialText={initialPrompt}
          projectId={project?.id}
          connected={connected}
          models={models}
          running={running}
          onSend={ask}
          onStop={stop}
          starters={!empty ? [] : !project ? STARTERS : !project.archived ? [{ label: "Plan next steps", prompt: "Help me review this game's plan and work out the next steps. Save the agreed roadmap and to-dos in context." }, { label: "Plan a thumbnail", prompt: "Create and save a thumbnail plan for this project." }, { label: "Plan a UI", prompt: "Create and save a UI plan for this project. Ask me which screen to design first." }] : []}
        />
      </div>}
      {empty && !project && canPlan && (projects.length > 0 || archived) && <WorkspaceList projects={projects} archived={archived} />}
      {empty && recent && <RecentChats key="recent" initial={recent} />}
      <p role="status" className="sr-only">
        {running ? "The assistant is responding." : ""}
      </p>
    </div>
    {project && <ProjectPanel project={project} onSaved={projectSaved} initialTab={contextTab} expanded={contextExpanded} onExpandedChange={setContextExpanded} animationVersion={contextAnimation} />}
    </div>
  );
}
