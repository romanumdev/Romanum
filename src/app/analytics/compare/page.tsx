import { CompetitorComparison } from "@/components/history/competitor-comparison";
import { AnalyticsWorkflowNavigation } from "@/components/analytics/navigation";
export const metadata = { title: "Public competitor comparisons | Romanum", description: "Compare recorded Roblox concurrent players with matching windows, peer suggestions and transparent coverage." };
export default async function ComparePage({ searchParams }: { searchParams: Promise<{ universeIds?: string; days?: string }> }) {
  const query = await searchParams;
  const ids = (query.universeIds ?? "").split(",").map(Number).filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 5);
  const days = Number(query.days ?? 7);
  return <><h1 className="text-2xl font-semibold">Compare public competitors</h1><AnalyticsWorkflowNavigation current="compare" /><CompetitorComparison initialUniverseIds={ids} initialDays={Number.isInteger(days) && days >= 1 && days <= 30 ? days : 7} /></>;
}
