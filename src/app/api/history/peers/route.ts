import { historyPeerService } from "@/lib/analytics/peer-selection";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const query = new URL(request.url).searchParams, id = query.get("universeId"), days = query.get("days");
    if ([...query.keys()].some(key => key !== "universeId" && key !== "days") || query.getAll("universeId").length !== 1 || query.getAll("days").length > 1 || !/^[1-9]\d{0,15}$/.test(id ?? "") || (days !== null && !/^(?:[1-9]|[12]\d|30)$/.test(days))) return Response.json({ error: "Choose a valid public universe ID and one to thirty days." }, { status: 400, headers });
    return Response.json(await historyPeerService.peers({ universeId: Number(id), days: days === null ? undefined : Number(days) }), { headers });
  } catch (error) { return Response.json({ error: error instanceof z.ZodError ? "Invalid peer request." : "Could not read recorded peers. Try again." }, { status: error instanceof z.ZodError ? 400 : 503, headers }); }
}
