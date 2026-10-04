import type { MetadataRoute } from "next";
import { historyService } from "@/lib/history/service";
import { loadPublicSitemap } from "@/lib/public-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Existing persisted public games only. Never enroll games, generate AI or read owner tables.
  const entries = await loadPublicSitemap(() => historyService.games());
  return [...entries, { url: "https://romanum.dev/terms" }];
}
