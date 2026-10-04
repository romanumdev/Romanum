import { InlineAnalyticsTool } from "@/components/analytics/inline-tool";
import { CompetitorComparison } from "@/components/history/competitor-comparison";
import { WatchlistsWorkspace } from "@/components/watchlists/watchlists-workspace";
import { ExperimentsPanel } from "@/components/experiments/experiments-panel";
import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Assistant } from "@/components/assistant/assistant";
import { MarketOverview } from "@/components/market/overview";
import { SKILL_CATALOG } from "@/lib/skill-catalog";
import { PlayerHistory } from "@/components/history/player-history";
import { GameSearch } from "@/components/games/game-search";
import { ANALYTICS_VIEWS, AnalyticsNavigation, type AnalyticsView } from "@/components/analytics/navigation";
import { ChartInvitation } from "@/components/analytics/chart-invitation";
import { GamesSection, GenresSection, TrendsSection } from "@/components/analytics/sections";
import { EarningsCalculator } from "@/components/analytics/earnings-calculator";
import { RevenueControls } from "@/components/analytics/revenue";
import { analyticsPageMetadata } from "@/lib/public-discovery";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ view?: string }> }): Promise<Metadata> {
  return analyticsPageMetadata((await searchParams).view);
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ starter?: string; view?: string; genre?: string; tool?: string; universeIds?: string; days?: string }> }) {
  // Check for the key per request rather than baking the answer in at build time.
  await connection();
  const connected = Boolean(process.env.DEEPSEEK_API_KEY);
  const { starter, view: requestedView, genre, tool, universeIds, days } = await searchParams;
  const view: AnalyticsView = ANALYTICS_VIEWS.includes(requestedView as AnalyticsView) ? requestedView as AnalyticsView : "overview";
  const comparisonIds = (universeIds ?? "").split(",").map(Number).filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 5);
  const comparisonDays = Number(days ?? 7);
  const initialPrompt = SKILL_CATALOG.find((skill) => skill.id === starter)?.prompt ?? "";

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Explore the market</h1>
      </header>
      <Assistant key={starter ?? "default"} connected={connected} initialPrompt={initialPrompt} />
      <ChartInvitation connected={connected} />
      <AnalyticsNavigation view={view} />
      {/* Keep the tab row anchored when streamed content briefly becomes a short fallback.
          scroll={false} alone cannot prevent the browser clamping a shrinking document. */}
      <div className="min-h-[calc(100svh-4rem)]">
        {view !== "earnings" && <div className="mt-4"><RevenueControls /></div>}

        {(view === "overview" || view === "games") && <GameSearch />}

        {/* Streams in after the prompt bar, so a slow Roblox response doesn't hold up the page. */}
        <Suspense key={`${view}:${genre ?? ""}`} fallback={<p role="status" className="mt-7 text-sm text-fg-muted">Loading…</p>}>
          {view === "overview" && <MarketOverview connected={connected} />}
          {(view === "games" || view === "charts") && <GamesSection chartMode={view === "charts"} genre={genre} />}
          {view === "trends" && <TrendsSection connected={connected} />}
          {view === "genres" && <GenresSection />}
        </Suspense>
        {view === "earnings" && <EarningsCalculator />}
        {(view === "overview" || view === "charts") && <PlayerHistory />}
      </div>
      <section aria-label="Saved games and actions" className="mt-6 space-y-3">
        <InlineAnalyticsTool id="compare" title="Compare games" initialOpen={tool === "compare"}>
          <CompetitorComparison initialUniverseIds={comparisonIds} initialDays={Number.isInteger(comparisonDays) && comparisonDays >= 1 && comparisonDays <= 30 ? comparisonDays : 7} />
        </InlineAnalyticsTool>
        <InlineAnalyticsTool id="watches" title="Watched games and alerts" initialOpen={tool === "watches"}>
          <p className="mt-3 text-xs text-fg-muted">Private to your account or this browser. Coverage depends on collection capacity and available observations.</p>
          <WatchlistsWorkspace />
        </InlineAnalyticsTool>
        <InlineAnalyticsTool id="actions" title="Saved actions" initialOpen={tool === "actions"}>
          <p className="my-3 text-xs text-fg-muted">Review a saved brief, add its release date and check the recorded outcome.</p>
          <ExperimentsPanel />
        </InlineAnalyticsTool>
      </section>
      <footer className="mt-10 flex flex-wrap gap-x-5 border-t border-line py-5 text-xs text-fg-subtle"><Link href="/privacy" className="inline-flex min-h-10 items-center rounded-sm hover:text-fg focus-visible:outline-2 focus-visible:outline-fg/70">Privacy policy</Link><Link href="/terms" className="inline-flex min-h-10 items-center rounded-sm hover:text-fg focus-visible:outline-2 focus-visible:outline-fg/70">Terms of service</Link></footer>
    </>
  );
}
