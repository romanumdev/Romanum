import { redirect } from "next/navigation";
export default async function ComparePage({ searchParams }: { searchParams: Promise<{ universeIds?: string; days?: string }> }) {
  const query = await searchParams;
  const params = new URLSearchParams({ tool: "compare" });
  if (query.universeIds) params.set("universeIds", query.universeIds);
  if (query.days) params.set("days", query.days);
  redirect(`/analytics?${params}#compare`);
}
