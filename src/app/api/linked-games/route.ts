import { after } from "next/server";
import { readAccount } from "@/lib/accounts/session";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";
import { syncDueGames } from "@/lib/linked-games/sync";
import { linkedGameViews } from "@/lib/linked-games/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const failure = (status: number, error: string) => Response.json({ error }, { status, headers: NO_STORE });

async function database() {
  try {
    return await historyDatabase();
  } catch {
    return null;
  }
}

/** The signed-in account's linked games. Games due a sync start one once the response is sent. */
export async function GET() {
  const account = await readAccount();
  if (!account) return failure(401, "Sign in to see your games.");
  const db = await database();
  if (!db) return failure(503, "Your games are unavailable.");
  after(() => syncDueGames(db, { accountId: account.id }).catch(() => {}));
  return Response.json({ games: await linkedGameViews(db, account.id) }, { headers: NO_STORE });
}

/** Old clients cannot submit new user API keys. Connecting now requires explicit Roblox authorization. */
export async function POST(request: Request) {
  if (isCrossSite(request)) return failure(403, "Request rejected.");
  const account = await readAccount();
  if (!account) return failure(401, "Sign in to link a game.");
  return failure(410, "Connect through Roblox in Game settings.");
}
