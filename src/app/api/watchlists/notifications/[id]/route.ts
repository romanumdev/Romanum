import { watchlistResponse } from "@/lib/watchlists/http";
import { watchDependencies } from "@/lib/watchlists/dependencies";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (request:Request,context:{params:Promise<{id:string}>}) => watchlistResponse(request,watchDependencies,{...(await context.params),notifications:true});
