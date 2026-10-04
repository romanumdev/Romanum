import type { Metadata } from "next";
import { ExperimentsPanel } from "@/components/experiments/experiments-panel";
import { AnalyticsWorkflowNavigation } from "@/components/analytics/navigation";

export const metadata: Metadata = { title: "Development tasks — Romanum", robots: { index: false, follow: false } };
export default function ExperimentsPage() {
  return <div className="mx-auto w-full max-w-4xl space-y-6">
    <div><h1 className="text-2xl font-semibold text-fg">Development tasks</h1><p className="mt-2 text-sm text-fg-muted">Track prepared briefs, release dates and intended outcomes. Check descriptive public-player changes across matched weeks when observations are available.</p></div>
    <AnalyticsWorkflowNavigation current="experiments" />
    <ExperimentsPanel />
  </div>;
}
