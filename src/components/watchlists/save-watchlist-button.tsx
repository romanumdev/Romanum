"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Watchlist } from "@/lib/watchlists/store";

export function SaveWatchlistButton({ universeId, name }: { universeId: number; name?: string }) {
  const [watch, setWatch] = useState<Watchlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/watchlists", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to read watch settings.");
      setWatch(data.watchlists.find((item: Watchlist) => item.universeId === universeId) ?? null);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to read watch settings."); }
    finally { setLoading(false); }
  }, [universeId]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) return refresh(); });
    const update = () => { void refresh(); };
    window.addEventListener("romanum:watches-updated", update);
    return () => { active = false; window.removeEventListener("romanum:watches-updated", update); };
  }, [refresh]);
  async function toggle() {
    if (error) { await refresh(); return; }
    setBusy(true); setError("");
    try {
      const settings = watch ? {
        name: watch.name, universeId: watch.universeId, peerIds: watch.peerIds,
        direction: watch.direction, thresholdPercent: watch.thresholdPercent,
        minimumPlayers: watch.minimumPlayers, windowMinutes: watch.windowMinutes, enabled: !watch.enabled,
      } : { universeId, name: (name ?? `Game ${universeId}`).slice(0, 100) };
      const response = await fetch(watch ? `/api/watchlists/${watch.id}` : "/api/watchlists", {
        method: watch ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(watch ? { revision: watch.revision, settings } : settings),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to update this watch.");
      await refresh();
      window.dispatchEvent(new Event("romanum:watches-updated"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update this watch."); }
    finally { setBusy(false); }
  }
  return <div className="text-sm">
    <button type="button" onClick={toggle} disabled={loading || busy} aria-pressed={Boolean(watch?.enabled)} className="min-h-11 rounded-lg border border-line px-3 hover:bg-surface disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-white">
      {loading ? "Loading watch" : busy ? "Saving" : error ? "Retry watch" : watch?.enabled ? "Pause watch" : watch ? "Enable watch" : "Watch game"}
    </button>
    {watch && <Link href={`/analytics/games/${universeId}?tool=watches#game-watch`} className="ml-3 underline">Settings and alerts</Link>}
    {error && <p role="alert" className="mt-2 text-fg-muted">{error}</p>}
  </div>;
}
