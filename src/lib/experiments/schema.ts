import { z } from "zod";
import { briefEvidenceSchema, implementationBriefSchema } from "../implementation/brief.ts";

export const experimentStatusSchema = z.enum(["planned", "in_progress", "released", "archived"]);
export const intendedMetricSchema = z.enum(["public_playing", "retention", "revenue"]);
export const experimentMetadataSchema = z.object({
  title: z.string().trim().min(1).max(120),
  intendedMetric: intendedMetricSchema,
  universeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  status: experimentStatusSchema,
  releaseDate: z.iso.date().nullable(),
}).strict();
export const experimentInputSchema = experimentMetadataSchema.extend({
  brief: implementationBriefSchema,
  projectId: z.uuid().nullable().default(null),
}).strict();
export const experimentUpdateSchema = experimentMetadataSchema.extend({ revision: z.number().int().positive() }).strict();
export const experimentDeleteSchema = z.object({ revision: z.number().int().positive() }).strict();
export type ExperimentInput = z.infer<typeof experimentInputSchema>;
export type ExperimentUpdate = z.infer<typeof experimentUpdateSchema>;
export type ExperimentEvidence = z.infer<typeof briefEvidenceSchema>;
export type Experiment = ExperimentInput & { id: string; evidence: ExperimentEvidence; revision: number; createdAt: string; updatedAt: string };

export const EXPERIMENT_LABELS = { public_playing: "Public concurrent players", retention: "Retention (data unavailable)", revenue: "Revenue (data unavailable)" };
