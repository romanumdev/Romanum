import { deleteChat, readChat } from "@/lib/chats/store";
import { readOwner } from "@/lib/accounts/session";
import { isCrossSite } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await readOwner();
  const { id } = await params;
  if (!owner) return Response.json({ error: "Chat not found." }, { status: 404, headers: NO_STORE });
  try {
    const db = await historyDatabase();
    if (!db) throw new Error("No database is configured.");
    const chat = await readChat(db, owner, id);
    return chat ? Response.json(chat, { headers: NO_STORE }) : Response.json({ error: "Chat not found." }, { status: 404, headers: NO_STORE });
  } catch {
    return Response.json({ error: "Chats unavailable." }, { status: 503, headers: NO_STORE });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return Response.json({ error: "Request rejected." }, { status: 403, headers: NO_STORE });
  const owner = await readOwner();
  const { id } = await params;
  try {
    const db = await historyDatabase();
    if (!db) throw new Error("No database is configured.");
    if (owner && (await deleteChat(db, owner, id))) return new Response(null, { status: 204, headers: NO_STORE });
    return Response.json({ error: "Chat not found." }, { status: 404, headers: NO_STORE });
  } catch {
    return Response.json({ error: "Chats unavailable." }, { status: 503, headers: NO_STORE });
  }
}
