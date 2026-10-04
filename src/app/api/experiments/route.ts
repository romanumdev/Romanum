import { experimentResponse } from "@/lib/experiments/http";
import { readAccount, readOwner } from "@/lib/accounts/session";
import { ensureGuestIdentity, isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const deps = { readOwner, ensureOwner: async () => (await readAccount())?.ownerId ?? await ensureGuestIdentity(), database: historyDatabase, isCrossSite };
export const GET = (request: Request) => experimentResponse(request, deps);
export const POST = (request: Request) => experimentResponse(request, deps);
