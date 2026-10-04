import { cache } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Settings } from "lucide-react";
import { PrivateAnalytics } from "@/components/account/private-analytics";
import { GameIcon } from "@/components/game-icon";
import { PlayerHistory } from "@/components/history/player-history";
import { loadPublicGame, parseUniverseId } from "@/lib/game-discovery";
import { formatValue } from "@/lib/charts/spec";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { linkedGameForUniverse, readGameMetrics } from "@/lib/linked-games/store";
import { Assistant } from "@/components/assistant/assistant";
import { gameAnalysisPrompt } from "@/lib/analytics/game-analysis";
import { getGameIcons } from "@/lib/roblox-icons";
import { GameEarningsPanel } from "@/components/analytics/revenue";
import { publicGameMetadata, utcObservationTime } from "@/lib/public-discovery";
import { SaveWatchlistButton } from "@/components/watchlists/save-watchlist-button";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ universeId: string }> };
const getGame = cache(loadPublicGame);

function validId(id: string) {
  try { parseUniverseId(id); } catch { notFound(); }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { universeId } = await params;
  validId(universeId);
  // Request memoisation shares this observation with the page body.
  const result = await getGame(universeId);
  return result.game ? publicGameMetadata(result.game) : { title: "Game not found", robots: { index: false } };
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "–" : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The signed-in account's private analytics for this game, when it has linked it. */
async function ownAnalytics(universeId: number) {
  const account = await readAccount();
  if (!account) return null;
  const database = await historyDatabase().catch(() => null);
  const linked = database && (await linkedGameForUniverse(database, account.id, universeId));
  return database && linked ? { game: linked, metrics: await readGameMetrics(database, account.id, linked.id) } : null;
}

export default async function GamePage({ params }: Props) {
  const { universeId } = await params;
  validId(universeId);
  const [{ game, fetchedAt, source }, own] = await Promise.all([getGame(universeId), ownAnalytics(Number(universeId))]);
  if (!game) notFound();
  const iconUrl = (await getGameIcons([game.universeId], "512x512")).get(game.universeId) ?? game.iconUrl;
  const privateAnalysis = Boolean(own?.game.aiAnalysis && own.game.collect && own.game.status === "active");
  const prompt = gameAnalysisPrompt(game, privateAnalysis);
  const stats = [
    { label: "Players now", value: game.playing, format: "compact" },
    { label: "Visits", value: game.visits, format: "compact" },
    { label: "Favourites", value: game.favorites, format: "compact" },
    { label: "Like ratio", value: game.likeRatio, format: "percent" },
  ] as const;
  return (
    <>
      <Link href="/analytics" className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-fg-muted">
        <ArrowLeft className="size-4 text-white" aria-hidden="true" /> Analytics
      </Link>
      <div className="mt-5 grid items-start gap-8 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] xl:gap-10">
        <header className="min-w-0 lg:sticky lg:top-8">
          <GameIcon url={iconUrl} name={game.name} className="aspect-square w-full max-w-72 rounded-2xl" sizes="288px" />
          <h1 className="mt-5 text-2xl font-semibold leading-tight tracking-tight break-words">{game.name}</h1>
          <p className="mt-2 text-sm text-fg-muted break-words">By {game.creator.name}</p>
          <p className="mt-4 text-xs text-fg-subtle break-words">{game.genre ?? "Genre unavailable"}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <a href={`https://www.roblox.com/games/${game.rootPlaceId}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted">View on Roblox <ArrowUpRight className="size-4" aria-hidden="true" /></a>
            <Link href={`/analytics/compare?universeIds=${game.universeId}&days=7`} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted">Compare games</Link>
            <SaveWatchlistButton universeId={game.universeId} name={game.name} />
            {own && <Link href={`/profile/settings/games#game-${own.game.id}`} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted"><Settings className="size-4" aria-hidden="true" />Settings</Link>}
          </div>
          <dl className="mt-6 space-y-3 border-t border-line pt-5 text-xs">
            <div className="flex justify-between gap-3"><dt className="text-fg-muted">Created</dt><dd>{dateLabel(game.created)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-fg-muted">Updated</dt><dd>{dateLabel(game.updated)}</dd></div>
          </dl>
        </header>

        <div className="min-w-0 space-y-8">
          {own && <PrivateAnalytics game={own.game} metrics={own.metrics} />}

          <section id="game-analysis" aria-labelledby="game-analysis-heading" className="scroll-mt-8 rounded-2xl border border-line p-5 sm:p-6">
            <h2 id="game-analysis-heading" className="mt-2 text-lg font-semibold">What should you try next?</h2>
            <p className="mt-3 mb-5 max-w-2xl text-sm leading-6 text-fg-muted">Review {privateAnalysis ? "your authorized private metrics and public activity" : "this game's public activity"} and choose prioritized tests with clear success measures.</p>
            <Assistant connected={Boolean(process.env.DEEPSEEK_API_KEY)} analysisPrompt={prompt} />
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-subtle">
              <Link href={`/chats?prompt=${encodeURIComponent(prompt)}`} className="inline-flex min-h-9 items-center text-fg-muted hover:text-fg hover:underline">Open a saved chat →</Link>
            </div>
            {own && !privateAnalysis && <p className="mt-2 text-xs leading-5 text-fg-muted">Private AI access is off or unavailable. <Link href={`/profile/settings/games#game-${own.game.id}`} className="text-fg underline">Manage AI access in Settings</Link>.</p>}
          </section>

          <section id="public-activity" aria-labelledby="public-activity-heading" className="scroll-mt-8">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="public-activity-heading" className="text-base font-semibold">Public activity</h2>
              <p className="text-xs text-fg-subtle">Roblox · Retrieved <time dateTime={fetchedAt}>{utcObservationTime(fetchedAt) ?? "Time unavailable"}</time></p>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
              {stats.map((stat) => <div key={stat.label} className="min-w-0 rounded-xl border border-line bg-surface px-4 py-5"><dt className="text-xs text-fg-muted">{stat.label}</dt><dd className="mt-2 text-2xl font-semibold tabular-nums" title={formatValue(stat.value, stat.format === "percent" ? "percent" : "full")}>{formatValue(stat.value, stat.format)}</dd></div>)}
            </dl>
            <p className="mt-3 text-xs leading-5 text-fg-muted"><a href={`${source}?universeIds=${game.universeId}`} className="text-fg underline underline-offset-2">Roblox statistics source</a> · Current players are concurrent; visits and favourites are cumulative. <Link href="/analytics/data" className="text-fg underline underline-offset-2">Metric definitions and coverage</Link></p>
            <PlayerHistory key={game.universeId} game={{ universeId: game.universeId, rootPlaceId: game.rootPlaceId, name: game.name, iconUrl: iconUrl ?? null }} />
          </section>
          <details className="rounded-xl border border-line p-5">
            <summary className="cursor-pointer text-sm text-fg-muted hover:text-fg">Explore earnings estimates</summary>
            <GameEarningsPanel game={game} />
          </details>
        </div>
      </div>
    </>
  );
}
