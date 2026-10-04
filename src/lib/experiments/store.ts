import { randomUUID } from "node:crypto";
import type { Database } from "../history/database.ts";
import { idSchema, ownerIdSchema } from "../creative/schema.ts";
import { experimentInputSchema, experimentUpdateSchema, type Experiment, type ExperimentInput, type ExperimentUpdate, type ExperimentEvidence } from "./schema.ts";

export class ExperimentError extends Error {
  readonly code: "not_found" | "conflict" | "invalid_input" | "limit";
  constructor(code: ExperimentError["code"], message: string) { super(message); this.code = code; }
}
const owner = (value: string) => ownerIdSchema.parse(value);
type Row = { id: string; project_id: string | null; title: string; brief: Experiment["brief"]; evidence: ExperimentEvidence; intended_metric: Experiment["intendedMetric"]; universe_id: string | number | null; status: Experiment["status"]; release_date: string | null; revision: number; created_at: Date | string; updated_at: Date | string };
const COLUMNS = "id,project_id,title,brief,evidence,intended_metric,universe_id,status,release_date::text,revision,created_at,updated_at";
const record = (row: Row): Experiment => ({ id: row.id, projectId: row.project_id, title: row.title, brief: row.brief, evidence: row.evidence, intendedMetric: row.intended_metric, universeId: row.universe_id === null ? null : Number(row.universe_id), status: row.status, releaseDate: row.release_date, revision: row.revision, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() });

export async function createExperiment(db: Database, ownerId: string, input: ExperimentInput): Promise<Experiment> {
  owner(ownerId);
  const value = experimentInputSchema.parse(input);
  const evidence: ExperimentEvidence = value.brief.supportingEvidence ?? { provenance: "prepared_brief_snapshot", sources: [{ kind: "prepared_brief", label: value.brief.title }], caveats: ["client_supplied_snapshot", "gameplay_unverified"] };
  // Preserve provenance even if a client strips the original caveat from its snapshot.
  evidence.caveats = [...new Set([...evidence.caveats, "client_supplied_snapshot" as const])];
  return db.transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [ownerId]);
    const { rows: counts } = await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM analytics_experiments WHERE owner_id=$1", [ownerId]);
    if (counts[0].count >= 100) throw new ExperimentError("limit", "You can keep up to 100 tracked tasks.");
    if (value.projectId) {
      const { rows } = await sql.query("SELECT 1 FROM creative_projects WHERE id=$1 AND owner_id=$2 AND NOT archived", [value.projectId, ownerId]);
      if (!rows[0]) throw new ExperimentError("not_found", "Active project not found.");
    }
    const { rows } = await sql.query<Row>(`INSERT INTO analytics_experiments(id,owner_id,project_id,title,brief,evidence,intended_metric,universe_id,status,release_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLUMNS}`, [randomUUID(), ownerId, value.projectId, value.title, JSON.stringify(value.brief), JSON.stringify(evidence), value.intendedMetric, value.universeId, value.status, value.releaseDate]);
    return record(rows[0]);
  });
}

export async function listExperiments(db: Database, ownerId: string): Promise<Experiment[]> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM analytics_experiments WHERE owner_id=$1 ORDER BY updated_at DESC,id LIMIT 100`, [owner(ownerId)]);
  return rows.map(record);
}

export async function readExperiment(db: Database, ownerId: string, id: string): Promise<Experiment | null> {
  if (!idSchema.safeParse(id).success) return null;
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM analytics_experiments WHERE id=$1 AND owner_id=$2`, [id, owner(ownerId)]);
  return rows[0] ? record(rows[0]) : null;
}

export async function updateExperiment(db: Database, ownerId: string, id: string, input: ExperimentUpdate): Promise<Experiment> {
  owner(ownerId);
  if (!idSchema.safeParse(id).success) throw new ExperimentError("not_found", "Task not found.");
  const value = experimentUpdateSchema.parse(input);
  return db.transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [ownerId]);
    const { rows } = await sql.query<Row>(`UPDATE analytics_experiments SET title=$3,intended_metric=$4,universe_id=$5,status=$6,release_date=$7,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND revision=$8 RETURNING ${COLUMNS}`, [id, ownerId, value.title, value.intendedMetric, value.universeId, value.status, value.releaseDate, value.revision]);
    if (rows[0]) return record(rows[0]);
    const { rows: existing } = await sql.query("SELECT 1 FROM analytics_experiments WHERE id=$1 AND owner_id=$2", [id, ownerId]);
    if (!existing[0]) throw new ExperimentError("not_found", "Task not found.");
    throw new ExperimentError("conflict", "This task changed. Reload before saving your edit.");
  });
}

export async function deleteExperiment(db: Database, ownerId: string, id: string, revision: number): Promise<void> {
  owner(ownerId);
  if (!idSchema.safeParse(id).success) throw new ExperimentError("not_found", "Task not found.");
  if (!Number.isSafeInteger(revision) || revision < 1) throw new ExperimentError("invalid_input", "Invalid task revision.");
  await db.transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [ownerId]);
    const { rows } = await sql.query("DELETE FROM analytics_experiments WHERE id=$1 AND owner_id=$2 AND revision=$3 RETURNING id", [id, ownerId, revision]);
    if (rows[0]) return;
    const { rows: existing } = await sql.query("SELECT 1 FROM analytics_experiments WHERE id=$1 AND owner_id=$2", [id, ownerId]);
    if (!existing[0]) throw new ExperimentError("not_found", "Task not found.");
    throw new ExperimentError("conflict", "This task changed. Reload before deleting it.");
  });
}
