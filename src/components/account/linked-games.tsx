"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Plus, Settings, ThumbsUp, Users } from "lucide-react";
import { GameIcon } from "@/components/game-icon";
import { useVerifiedFetch } from "@/components/verification";
import { MetricChange } from "./metric-change";
import { Switch } from "@/components/switch";
import { formatMetric } from "@/lib/linked-games/metrics";
import type { LinkedGameView } from "@/lib/linked-games/view";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
const INPUT = `min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle focus:border-line-strong ${FOCUS}`;
/** The metrics each game's card shows, labelled to fit its tiles; its game page shows them all. */
const SUMMARY = [
  { metric: "DailyActiveUsers", label: "Daily active users" },
  { metric: "AveragePlayTimeMinutesPerDAU", label: "Playtime" },
  { metric: "ForwardD1Retention", label: "Day 1 retention" },
  { metric: "DailyRevenue", label: "Revenue" },
];
/** While a game syncs, check back this often, for up to about two minutes. */
const POLL_MS = 5_000;
const POLL_LIMIT = 24;

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function statusLine(game: LinkedGameView): string {
  if (game.status === "key_rejected") return game.syncError ?? "Roblox access needs attention. Connect through Roblox again.";
  if (game.status === "disconnected") return "Disconnected. Link the game again to resume.";
  if (!game.collect) return "Collection off";
  if (game.syncing) return "Syncing…";
  if (game.syncError) return game.syncError;
  return game.syncedAt ? `Synced ${ago(game.syncedAt)}` : "Waiting to sync";
}

const needsPolling = (games: LinkedGameView[]) =>
  games.some((game) => game.syncing || (game.status === "active" && game.collect && !game.syncedAt && !game.syncError));

async function send(url: string, init: RequestInit): Promise<{ game?: LinkedGameView; error?: string }> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => null);
  return res.ok ? { game: data?.game } : { error: typeof data?.error === "string" ? data.error : "Something went wrong. Try again." };
}

function GameCard({ game, settings, onChange, onRemove, onRelink }: { game: LinkedGameView; settings: boolean; onChange: (game: LinkedGameView) => void; onRemove: () => void; onRelink: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = game.name ?? `Universe ${game.universeId}`;
  const connected = game.authorization !== "none" && game.status !== "disconnected";

  async function act(url: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    const result = await send(url, init).catch(() => ({ error: "Couldn't reach Romanum. Try again." }) as { game?: LinkedGameView; error?: string });
    setBusy(false);
    if (result.error) setError(result.error);
    return result;
  }

  async function toggle(setting: "collect" | "share" | "aiAnalysis", value: boolean) {
    const { game: updated } = await act(`/api/linked-games/${game.id}`, { method: "PATCH", body: JSON.stringify({ [setting]: value }) });
    if (updated) onChange(updated);
  }

  async function disconnect() {
    if (!window.confirm(`Disconnect ${name}? Romanum removes its saved authorization and stops syncing. The metrics stay until you delete them.`)) return;
    const { game: updated } = await act(`/api/linked-games/${game.id}/disconnect`, { method: "POST" });
    if (updated) onChange(updated);
  }

  async function remove() {
    if (!window.confirm(`Delete ${name} from Romanum? This deletes its saved authorization and all its synced metrics.`)) return;
    const result = await act(`/api/linked-games/${game.id}`, { method: "DELETE" });
    if (!result.error) onRemove();
  }

  const summary = SUMMARY.flatMap(({ metric, label }) => {
    const found = game.metrics.find((item) => item.metric === metric);
    return found ? [{ ...found, label }] : [];
  });
  if (!settings) return (
    <li className="min-w-0">
      <Link href={`/analytics/games/${game.universeId}`} aria-label={`View analytics for ${name}`} prefetch={false} className={`group block h-full rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-hover sm:p-5 ${FOCUS}`}>
        <div className="flex flex-wrap items-start gap-5">
          <GameIcon url={game.iconUrl} name={name} className="aspect-square w-full max-w-72 rounded-xl 2xl:max-w-80" sizes="(min-width: 1536px) 320px, 288px" />
          <div className="min-w-0 flex-1 basis-56">
            <h3 className="text-lg font-semibold leading-snug break-words group-hover:underline">{name}</h3>
            {game.creatorName && <p className="mt-1 text-xs text-fg-muted break-words">By {game.creatorName}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-muted">
              <p className="inline-flex items-center gap-1.5"><ThumbsUp className="size-3.5" aria-hidden="true" />{game.likeRatio == null ? "Rating unavailable" : `${Math.round(game.likeRatio * 100)}% positive`}</p>
              <p className="inline-flex items-center gap-1.5" title={game.publicFetchedAt ? `Roblox public activity retrieved ${game.publicFetchedAt}` : "Public retrieval time unavailable"}>
                <Users className="size-3.5" aria-hidden="true" /><span className="sr-only">Concurrent users: </span><span className="tabular-nums">{game.playing == null ? "Unavailable" : formatMetric(game.playing, "count")}</span>{game.playing != null && <span>playing</span>}
              </p>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-line pt-4">
              {summary.map((metric) => (
                <div key={metric.metric} className="min-w-0">
                  <dt className="text-xs text-fg-muted">{metric.label}</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums" title={metric.latest ? `Roblox daily observation: ${metric.latest.day}${metric.latest.status ? ` (${metric.latest.status})` : ""}` : "Not synced"}>
                    {formatMetric(metric.unit === "rate" && metric.latest && metric.latest.value > 1 ? metric.latest.value / 100 : metric.latest?.value, metric.unit)}
                    {metric.latest?.status === "Projected" && <span className="ml-2 text-[11px] font-normal text-fg-muted">Projected</span>}
                  </dd>
                  <MetricChange change={metric.change} />
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
          <p className="min-w-0 text-xs text-fg-muted" role="status">{statusLine(game)}</p>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium">View analytics <ChevronRight className="size-3.5" aria-hidden="true" /></span>
        </div>
      </Link>
    </li>
  );
  return (
    <li id={`game-${game.id}`} className="scroll-mt-8 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <GameIcon url={game.iconUrl} name={name} className="size-12" />
        <div className="min-w-0 flex-1">
          <Link href={`/analytics/games/${game.universeId}#your-analytics`} prefetch={false} className={`inline-flex items-center gap-1 rounded-sm text-sm font-medium text-fg hover:underline ${FOCUS}`}>
            <span className="truncate">{name}</span>
          </Link>
          <p className="mt-0.5 text-xs text-fg-muted" role="status">
            {statusLine(game)}
          </p>
        </div>
      </div>

      {game.authorization === "legacy_key" && <p className="mt-3 text-xs leading-5 text-fg-muted">This game uses its existing encrypted key. Connect through Roblox to switch authorization without deleting saved metrics or changing your settings.</p>}
      <div className="mt-4 space-y-3 border-t border-line pt-4">
        <Switch
          label="Collect analytics"
          description="Sync this game's authorized daily metrics from Roblox. Only you can see them."
          checked={game.collect}
          disabled={busy || game.status !== "active"}
          onChange={(value) => toggle("collect", value)}
        />
        <Switch
          label="AI analysis"
          description="Let Ask Romanum and Chats read this game's private analytics, including funnels, performance and revenue. Results go to your selected model provider (DeepSeek, OpenAI or Anthropic) and remain in saved chats. Turning this off stops new reads; it doesn't erase earlier answers."
          checked={game.aiAnalysis}
          disabled={busy || (!game.aiAnalysis && game.status !== "active")}
          onChange={(value) => toggle("aiAnalysis", value)}
        />
        <Switch
          label="Help improve Romanum"
          description="Let Romanum use this game's daily metrics, from today on, to improve its analysis."
          checked={game.share}
          disabled={busy}
          onChange={(value) => toggle("share", value)}
        />
      </div>

      {error && <p role="alert" className="mt-3 text-xs text-fg">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {(game.status !== "active" || game.authorization !== "oauth") && (
          <button type="button" onClick={onRelink} className={`min-h-9 rounded-lg border border-line px-3 text-xs text-fg hover:bg-surface-hover ${FOCUS}`}>
            Connect through Roblox
          </button>
        )}
        {connected && (
          <button type="button" disabled={busy} onClick={disconnect} className={`min-h-9 rounded-lg border border-line px-3 text-xs text-fg hover:bg-surface-hover disabled:opacity-50 ${FOCUS}`}>
            Disconnect
          </button>
        )}
        <button type="button" disabled={busy} onClick={remove} className={`min-h-9 rounded-lg px-3 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50 ${FOCUS}`}>
          Delete data
        </button>
      </div>
    </li>
  );
}

/** Optional Roblox game authorization is separate from account sign-in. */
export function LinkedGames({ initial, settings = false, oauthAvailable = false }: { initial: LinkedGameView[]; settings?: boolean; oauthAvailable?: boolean }) {
  const [games, setGames] = useState(initial);
  const [universeId, setUniverseId] = useState("");
  const request = useVerifiedFetch();
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idField = useRef<HTMLInputElement>(null);
  const polling = needsPolling(games);

  useEffect(() => {
    if (!polling) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      if (++polls > POLL_LIMIT) return window.clearInterval(timer);
      fetch("/api/linked-games")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { games?: LinkedGameView[] } | null) => {
          if (Array.isArray(data?.games)) setGames(data.games);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling]);

  async function link(event: React.FormEvent) {
    event.preventDefault();
    if (!oauthAvailable) return;
    setLinking(true);
    setError(null);
    try {
      const response = await request("/auth/roblox/analytics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ universeId }) });
      const data = await response.json();
      if (!response.ok || typeof data.url !== "string") throw new Error(data.error ?? "Unable to start the Roblox connection.");
      window.location.assign(data.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the Roblox connection.");
      setLinking(false);
    }
  }

  function relink(game: LinkedGameView) {
    setUniverseId(String(game.universeId));
    idField.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    idField.current?.focus();
  }

  return (
    <>
      {!settings && <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">Open an experience to see its data and decide what to improve next.</p>
        <div className="flex gap-2">
          <Link href="/profile/settings/games" className={`inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-xs hover:bg-surface-hover ${FOCUS}`}><Settings className="size-3.5" aria-hidden="true" />Game settings</Link>
          <Link href="/profile/settings/games#link-game" className={`inline-flex min-h-10 items-center gap-2 rounded-lg bg-fg px-3 text-xs font-medium text-canvas ${FOCUS}`}><Plus className="size-3.5" aria-hidden="true" />Link game</Link>
        </div>
      </div>}
      {games.length > 0 ? (
        <ul className={`mt-4 grid gap-4 ${settings ? "lg:grid-cols-2" : "xl:grid-cols-2"}`}>
          {games.map((game) => (
            <GameCard
              key={game.id}
              game={game}
              settings={settings}
              onChange={(updated) => setGames((list) => list.map((item) => (item.id === updated.id ? updated : item)))}
              onRemove={() => setGames((list) => list.filter((item) => item.id !== game.id))}
              onRelink={() => relink(game)}
            />
          ))}
        </ul>
      ) : (
        <div className="mt-4 grid min-h-24 place-items-center rounded-xl border border-line px-6 py-6 text-center">
          <p className="text-sm text-fg-muted">No games linked</p>
        </div>
      )}

      {settings && <form id="link-game" onSubmit={link} className="mt-6 max-w-2xl scroll-mt-8 rounded-xl border border-line p-5" aria-labelledby="link-game-heading">
        <h3 id="link-game-heading" className="text-sm font-medium">
          Link a game
        </h3>
        <p className="mt-1 text-xs leading-5 text-fg-muted">Enter the experience&apos;s universe ID and approve read-only analytics access on Roblox. Sign-in does not grant this access. Collection and AI analysis remain separate settings.</p>
        {!oauthAvailable && <p className="mt-3 text-xs text-fg-muted">Roblox game authorization is not enabled yet. Existing connections and saved data remain available.</p>}
        <label className="mt-4 block max-w-xs">
          <span className="text-xs text-fg-muted">Universe ID</span>
          <input ref={idField} name="universeId" value={universeId} onChange={(event) => setUniverseId(event.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="off" maxLength={16} required className={INPUT}/>
        </label>
        {error && (
          <p role="alert" className="mt-3 text-xs text-fg">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={linking || !universeId || !oauthAvailable}
          className={`mt-4 min-h-11 rounded-lg bg-fg px-4 text-sm font-medium text-canvas hover:bg-white disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-fg-subtle ${FOCUS}`}
        >
          {linking ? "Opening Roblox" : "Connect through Roblox"}
        </button>
      </form>}
    </>
  );
}
