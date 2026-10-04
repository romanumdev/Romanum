import { experimentResponse } from "@/lib/experiments/http";
import { readOwner } from "@/lib/accounts/session";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const deps = { readOwner, ensureOwner: async () => { throw new Error("Existing owner required"); }, database: historyDatabase, isCrossSite };
type Context = { params: Promise<{ id: string }> };
export const GET = async (request: Request, context: Context) => experimentResponse(request, deps, (await context.params).id);
export const PUT = async (request: Request, context: Context) => experimentResponse(request, deps, (await context.params).id);
export const DELETE = async (request: Request, context: Context) => experimentResponse(request, deps, (await context.params).id);
