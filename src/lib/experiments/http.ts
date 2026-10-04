import type { Database } from "../history/database.ts";
import { ZodError } from "zod";
import { experimentInputSchema, experimentUpdateSchema, experimentDeleteSchema } from "./schema.ts";
import { createExperiment, listExperiments, readExperiment, updateExperiment, deleteExperiment, ExperimentError } from "./store.ts";
import { readExperimentResult } from "./results.ts";

const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: HEADERS });
type Dependencies = { readOwner: () => Promise<string | null>; ensureOwner: () => Promise<string>; database: () => Promise<Database | null>; isCrossSite: (request: Request) => boolean };
async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 98_304) { await reader.cancel(); throw new Error("size"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function experimentResponse(request: Request, deps: Dependencies, id?: string, resultOnly = false): Promise<Response> {
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (deps.isCrossSite(request) || (origin && origin !== new URL(request.url).origin)) return fail(403, "Request rejected.");
  }
  try {
    const db = await deps.database();
    if (!db) return fail(503, "Tracked tasks unavailable. Try again later.");
    if (request.method === "GET") {
      const ownerId = await deps.readOwner();
      if (!ownerId) return id ? fail(404, "Task not found.") : Response.json({ experiments: [] }, { headers: HEADERS });
      if (id && resultOnly) return Response.json({ result: await readExperimentResult(db, ownerId, id) }, { headers: HEADERS });
      if (id) {
        const experiment = await readExperiment(db, ownerId, id);
        return experiment ? Response.json({ experiment }, { headers: HEADERS }) : fail(404, "Task not found.");
      }
      return Response.json({ experiments: await listExperiments(db, ownerId) }, { headers: HEADERS });
    }
    if (resultOnly || !((request.method === "POST" && !id) || ((request.method === "PUT" || request.method === "DELETE") && id))) return fail(405, "Method not allowed.");
    let value: unknown;
    try { value = await body(request); }
    catch (error) { return fail(error instanceof Error && error.message === "size" ? 413 : 400, "Invalid or oversized task details."); }
    if (id) {
      if (request.method === "DELETE") {
        const parsed = experimentDeleteSchema.safeParse(value);
        if (!parsed.success) return fail(400, "Check the task revision.");
        const ownerId = await deps.readOwner();
        if (!ownerId) return fail(404, "Task not found.");
        await deleteExperiment(db, ownerId, id, parsed.data.revision);
        return Response.json({ deleted: true }, { headers: HEADERS });
      }
      const parsed = experimentUpdateSchema.safeParse(value);
      if (!parsed.success) return fail(400, "Check the task details.");
      const ownerId = await deps.readOwner();
      if (!ownerId) return fail(404, "Task not found.");
      return Response.json({ experiment: await updateExperiment(db, ownerId, id, parsed.data) }, { headers: HEADERS });
    }
    const parsed = experimentInputSchema.safeParse(value);
    if (!parsed.success) return fail(400, "Check the task details.");
    const ownerId = await deps.ensureOwner();
    return Response.json({ experiment: await createExperiment(db, ownerId, parsed.data) }, { status: 201, headers: HEADERS });
  } catch (error) {
    if (error instanceof ExperimentError) return fail(error.code === "not_found" ? 404 : error.code === "invalid_input" ? 400 : 409, error.message);
    if (error instanceof ZodError) return fail(400, "Check the task details.");
    return fail(503, "Tracked tasks unavailable. Try again later.");
  }
}
