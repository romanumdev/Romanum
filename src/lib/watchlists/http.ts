import type { Database } from "../history/database.ts";
import { z } from "zod";
import type { GameStats } from "../roblox.ts";
import { watchInput, saveWatchlist, deleteWatchlist, listWatchlists, listNotifications, acknowledgeNotification, WatchlistError } from "./store.ts";

export type WatchDependencies = { owner: () => Promise<string | null>; ensureIdentity: () => Promise<string>; database: () => Promise<Database | null>; isCrossSite: (request: Request) => boolean; loadGames?: (ids:number[])=>Promise<GameStats[]> };
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const json = (value: unknown, status = 200) => Response.json(value,{status,headers});
const fail = (status: number, error: string) => json({error},status);
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WatchlistError("invalid","Use JSON watchlist settings.");
  const reader = request.body?.getReader();
  if (!reader) throw new WatchlistError("invalid","Missing watchlist settings.");
  let size = 0; const parts: Uint8Array[] = [];
  try {
    for (;;) { const {value,done} = await reader.read(); if(done) break; size += value.byteLength; if(size>8192) { await reader.cancel(); throw new WatchlistError("invalid","Watchlist settings are too long."); } parts.push(value); }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new WatchlistError("invalid","Invalid JSON watchlist settings."); }
  } finally { reader.releaseLock(); }
}
export async function watchlistResponse(request: Request,deps: WatchDependencies,options: {id?:string; notifications?:boolean} = {}) {
  try {
    const write = request.method !== "GET";
    const origin = request.headers.get("origin");
    if (write && (deps.isCrossSite(request) || (origin && origin !== new URL(request.url).origin))) return fail(403,"Request rejected.");
    const methods = options.notifications ? (options.id ? ["POST"] : ["GET"]) : (options.id ? ["PUT","DELETE"] : ["GET","POST"]);
    if (!methods.includes(request.method)) return fail(405,"Method not allowed.");
    // Parse free writes before starting a signed pending guest identity. This
    // never verifies Turnstile, issues credits or authorizes an AI request.
    let input: unknown; let revision: number | undefined;
    if (request.method === "POST" && !options.notifications || request.method === "PUT") {
      const raw = await body(request);
      if(request.method === "PUT") {
        const update = z.object({revision:z.number().int().positive(),settings:watchInput}).strict().safeParse(raw);
        if(!update.success) return fail(400,"Check the watchlist settings and revision.");
        input=update.data.settings; revision=update.data.revision;
      } else { const create=watchInput.safeParse(raw); if(!create.success) return fail(400,"Check the game, distinct peers and rule settings."); input=create.data; }
    }
    const db = await deps.database();
    if (!db) return fail(503,"Watchlists unavailable. Try again later.");
    const ownerId = await deps.owner() ?? (request.method === "POST" && !options.notifications ? await deps.ensureIdentity() : null);
    if (!ownerId) return request.method === "GET" ? json(options.notifications ? {notifications:[]} : {watchlists:[]}) : fail(401,"Start a guest identity or sign in to save games.");
    if (options.notifications) {
      if (options.id) { await acknowledgeNotification(db,ownerId,options.id); return json({acknowledged:true}); }
      return json({notifications:await listNotifications(db,ownerId)});
    }
    if(request.method === "GET") return json({watchlists:await listWatchlists(db,ownerId)});
    if(request.method === "DELETE") { await deleteWatchlist(db,ownerId,options.id!); return json({deleted:true}); }
    return json({watchlist:await saveWatchlist(db,ownerId,input,{id:options.id,revision,load:deps.loadGames})},request.method === "POST" ? 201 : 200);
  } catch(error) {
    if(error instanceof WatchlistError) return fail(error.code === "not_found" ? 404 : error.code === "conflict" || error.code === "limit" ? 409 : error.code === "unavailable" ? 503 : 400,error.message);
    return fail(503,"Watchlists unavailable. Try again later.");
  }
}
