import Link from "next/link";

export const ANALYTICS_VIEWS = ["overview", "games", "trends", "genres", "charts", "earnings"] as const;
export type AnalyticsView = typeof ANALYTICS_VIEWS[number];
const WORKFLOWS = [["compare", "Compare"], ["watchlists", "Watches"], ["experiments", "Experiments"]] as const;

export function AnalyticsWorkflowNavigation({ current }: { current?: string }) {
  return <nav aria-label="Analytics workflows" className="mt-4 flex flex-wrap gap-2 text-sm">
    {WORKFLOWS.map(([slug, label]) => <Link key={slug} href={`/analytics/${slug}`} prefetch={false}
      aria-current={current === slug ? "page" : undefined}
      className={`inline-flex min-h-11 items-center rounded-lg border border-line px-3 focus-visible:outline-2 focus-visible:outline-white ${current === slug ? "bg-surface text-white" : "text-fg-muted hover:bg-surface hover:text-white"}`}>{label}</Link>)}
  </nav>;
}

export function AnalyticsNavigation({ view }: { view: AnalyticsView }) {
  return (<>
    <nav aria-label="Analytics sections" className="mt-7 flex gap-1 overflow-x-auto border-b border-line pb-2">
      {/* Sections share the assistant above: retain the reader's position when switching views. */}
      {ANALYTICS_VIEWS.map((item) => <Link key={item} href={item === "overview" ? "/analytics" : `/analytics?view=${item}`} prefetch={false} scroll={false}
        aria-current={item === view ? "page" : undefined}
        className={`shrink-0 rounded-lg px-3 py-2 text-sm capitalize focus-visible:outline-2 focus-visible:outline-white ${item === view ? "bg-surface text-white" : "text-fg-muted hover:bg-surface hover:text-white"}`}>
        {item}
      </Link>)}
    </nav>
    <AnalyticsWorkflowNavigation />
  </>);
}
