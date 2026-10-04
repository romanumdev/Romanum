import { watchlistResponse } from "@/lib/watchlists/http";
import { watchDependencies } from "@/lib/watchlists/dependencies";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params:Promise<{id:string}>};
export const PUT = async (request: Request,context:Context) => watchlistResponse(request,watchDependencies,await context.params);
export const DELETE = async (request: Request,context:Context) => watchlistResponse(request,watchDependencies,await context.params);
