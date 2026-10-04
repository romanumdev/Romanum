import { postgresDatabase } from "../../src/lib/history/database.ts";
import { collectHistory } from "../../src/lib/history/collector.ts";
import { collectorAuthorized, retryCollectionRead } from "../../src/lib/history/scheduled.ts";
import { getGameStats, getRobloxChart } from "../../src/lib/roblox.ts";

export default async function historyCollect(request: Request) {
  // Background HTTP requests receive 202 from Netlify before execution. Reject
  // unauthorized work here, before connecting to Postgres or requesting Roblox.
  if (!collectorAuthorized(request)) return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("History collector database is not configured.");
  const database = postgresDatabase(url);
  try {
    const result = await collectHistory(database, {
      loaders: {
        getRobloxChart: (chart) => retryCollectionRead(() => getRobloxChart(chart)),
        getGameStats: (ids) => retryCollectionRead(() => getGameStats(ids)),
      },
    });
    console.log("History collection:", JSON.stringify(result));
    if (!result.skipped && result.status !== "complete") console.error("History collection incomplete; unavailable observations are recorded as gaps.");
    if (!result.skipped && result.alertStatus === "unavailable") console.error("Watchlist alert evaluation unavailable; public collection remains recorded.");
  } catch {
    throw new Error("History collection failed. Check the database diagnostics and recorded run.");
  } finally {
    await database.close();
  }
}

export const config = { background: true };
