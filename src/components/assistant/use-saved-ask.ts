"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Chat } from "@/lib/chats/store";
import { parseAutoRecommendationContext } from "@/lib/models/auto-recommendation";
import { CHATS_CHANGED } from "../events";
import { replayChatMessages } from "./replay";
import { finishTurn, type Turn } from "./turns";

const validId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** Browser storage contains only an opaque, owner-scoped pointer; transcripts stay in existing private storage. */
export function useSavedAsk(onOwnerChange: () => void) {
  const pathname = usePathname();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const scope = useRef<string | null | undefined>(undefined);
  const generation = useRef(0);
  const onChange = useRef(onOwnerChange);
  useEffect(() => { onChange.current = onOwnerChange; }, [onOwnerChange]);
  const invalidate = useCallback(() => { generation.current++; }, []);

  const readScope = useCallback(async () => {
    const response = await fetch("/api/models/preferences", { cache: "no-store" });
    if (!response.ok) throw new Error("Conversation identity unavailable.");
    const context = parseAutoRecommendationContext(await response.json());
    return context.scope ? `romanum:ask:v1:${context.scope}:${pathname}` : null;
  }, [pathname]);

  const refresh = useCallback(async (force = false) => {
    const version = ++generation.current;
    setLoading(true);
    try {
      const key = await readScope();
      if (version !== generation.current) return;
      if (scope.current === key && !force) return;
      scope.current = key;
      onChange.current();
      setTurns([]); setChatId(null); setSaved(false); setRestoreError(null);
      if (!key) return;
      let id: string | null = null;
      try { id = localStorage.getItem(key); } catch { /* Chats remain accessible without browser storage. */ }
      if (!validId(id)) return;
      const response = await fetch(`/api/chats/${id}`, { cache: "no-store" });
      if (version !== generation.current || scope.current !== key) return;
      if (response.status === 404) {
        try { localStorage.removeItem(key); } catch { /* Optional pointer only. */ }
        return;
      }
      if (!response.ok) throw new Error("Saved conversation unavailable. Retry before starting another message.");
      const chat = await response.json() as Chat;
      if (chat.id !== id || !Array.isArray(chat.messages)) throw new Error("Saved conversation unavailable.");
      setTurns(replayChatMessages(chat.messages).map(turn => turn.done ? turn : finishTurn(turn, 0, "No answer was saved.")));
      setChatId(id); setSaved(chat.messages.at(-1)?.role === "assistant");
    } catch (error) {
      if (version === generation.current) {
        onChange.current();
        setTurns([]); setChatId(null); setSaved(false);
        setRestoreError(error instanceof Error ? error.message : "Saved conversation unavailable.");
      }
      // A failed read must be retryable with the same owner scope.
      if (version === generation.current) scope.current = undefined;
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [readScope]);

  useEffect(() => {
    scope.current = undefined;
    const initial = setTimeout(() => { void refresh(); }, 0);
    const focused = () => { void refresh(); };
    window.addEventListener("focus", focused);
    return () => { clearTimeout(initial); invalidate(); window.removeEventListener("focus", focused); };
  }, [invalidate, refresh]);

  async function remember(id: string, committed: boolean) {
    if (!validId(id)) return;
    const version = generation.current;
    const previous = scope.current;
    const key = await readScope();
    if (version !== generation.current) return;
    // A first guest question may have established its signed identity during verification.
    if (previous && key !== previous) { void refresh(); return; }
    scope.current = key;
    setChatId(id); setSaved(committed);
    if (key) try { localStorage.setItem(key, id); } catch { /* The saved chat still appears in Chats. */ }
    if (committed) window.dispatchEvent(new Event(CHATS_CHANGED));
  }

  function reset() {
    invalidate();
    onChange.current();
    if (scope.current) try { localStorage.removeItem(scope.current); } catch { /* Optional pointer only. */ }
    setChatId(null); setTurns([]); setSaved(false); setRestoreError(null);
  }

  return { turns, setTurns, chatId, saved, setSaved, loading, restoreError, retry: () => refresh(true), remember, reset };
}
