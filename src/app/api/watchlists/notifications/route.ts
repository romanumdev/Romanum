import { watchlistResponse } from "@/lib/watchlists/http";
import { watchDependencies } from "@/lib/watchlists/dependencies";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => watchlistResponse(request,watchDependencies,{notifications:true});
