import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { createProject } from "../src/lib/projects/store.ts";
import { createExperiment, listExperiments, readExperiment, updateExperiment, deleteExperiment } from "../src/lib/experiments/store.ts";
import { summarizeExperimentObservations, readExperimentResult } from "../src/lib/experiments/results.ts";
import { experimentResponse } from "../src/lib/experiments/http.ts";
import { recommendationImplementationBrief } from "../src/lib/implementation/brief.ts";

const owner = `guest:${randomUUID()}`;
const other = `guest:${randomUUID()}`;
const sample = () => ({ title: "Prototype", brief: recommendationImplementationBrief({ title: "Prototype", reason: "An unverified prototype recommendation." }, "2026-09-01"), projectId: null, intendedMetric: "public_playing", universeId: 42, status: "planned", releaseDate: "2026-09-14" });
async function fixture(t) {
  const engine = await PGlite.create(); t.after(() => engine.close());
  const adapter = client => ({ query: (text, values) => client.query(text, values), exec: async text => { await client.exec(text); } });
  const db = { ...adapter(engine), transaction: operation => engine.transaction(client => operation(adapter(client))), close: () => engine.close() };
  await migrateHistory(db); return db;
}

test("tracked tasks preserve private brief evidence, owner/project scope and revision conflicts", async t => {
  const db = await fixture(t);
  const value = sample();
  const saved = await createExperiment(db, owner, value);
  assert.match(saved.brief.context, /Legacy suggestion/);
  assert.ok(saved.evidence.caveats.includes("client_supplied_snapshot"));
  assert.equal((await listExperiments(db, owner)).length, 1);
  assert.equal((await listExperiments(db, other)).length, 0);
  assert.equal(await readExperiment(db, other, saved.id), null);
  const metadata = { title: saved.title, intendedMetric: saved.intendedMetric, universeId: saved.universeId, status: "in_progress", releaseDate: saved.releaseDate, revision: saved.revision };
  const updated = await updateExperiment(db, owner, saved.id, metadata);
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.brief, saved.brief);
  await assert.rejects(updateExperiment(db, owner, saved.id, metadata), error => error.code === "conflict");
  await assert.rejects(updateExperiment(db, other, saved.id, metadata), error => error.code === "not_found");
  const project = await createProject(db, { ownerId: other, name: "Other project", context: { game: "Other game" } });
  await assert.rejects(createExperiment(db, owner, { ...value, projectId: project.id }), error => error.code === "not_found");
  const result = await readExperimentResult(db, owner, saved.id, Date.parse("2026-09-22T00:00:00Z"));
  assert.equal(result.status, "insufficient"); assert.equal(result.summary, null);
  await assert.rejects(deleteExperiment(db, owner, saved.id, 1), error => error.code === "conflict");
  await assert.rejects(deleteExperiment(db, other, saved.id, 2), error => error.code === "not_found");
  await deleteExperiment(db, owner, saved.id, 2);
  assert.equal(await readExperiment(db, owner, saved.id), null);
  await db.query("INSERT INTO account_closures(owner_id,account_id) VALUES($1,$2)", [owner, randomUUID()]);
  await assert.rejects(createExperiment(db, owner, value), error => error.code === "55000");
});

test("same-window results pair equal weekday/time slots, preserve gaps and never fabricate sparse/future/private results", () => {
  const experiment = sample();
  const release = Date.parse("2026-09-14T00:00:00Z");
  const week = 7 * 86400_000, slot = 300_000;
  const rows = [];
  for (let index = 0; index < 2016; index++) {
    for (const [start, playing] of [[release - week, 100], [release, 120]]) {
      const time = start + index * slot;
      rows.push({ slot: new Date(time).toISOString(), observed_at: new Date(time + 1000).toISOString(), playing, target_status: "observed" });
    }
  }
  const result = summarizeExperimentObservations(experiment, rows, "2026-09-20T23:55:01Z", release + week);
  assert.equal(result.status, "available"); assert.equal(result.coverage.paired, 2016);
  assert.deepEqual(result.summary, { beforeMeanPlaying: 100, afterMeanPlaying: 120, absoluteChange: 20, percentChange: 20 });
  assert.equal(result.semantics.causal, false);
  assert.equal(Date.parse(result.pairs[0].after.slot) - Date.parse(result.pairs[0].before.slot), week);
  const sparse = summarizeExperimentObservations(experiment, rows.slice(0, 20), null, release + week);
  assert.equal(sparse.status, "insufficient"); assert.equal(sparse.summary, null); assert.equal(sparse.coverage.beforeGaps, 2006);
  assert.equal(sparse.pairs[30].before.playing, null);
  const future = summarizeExperimentObservations(experiment, rows, null, release + slot);
  assert.equal(future.status, "awaiting_window"); assert.equal(future.summary, null);
  const privateMetric = summarizeExperimentObservations({ ...experiment, intendedMetric: "retention" }, rows, null, release + week);
  assert.equal(privateMetric.reason, "metric_unavailable"); assert.equal(privateMetric.summary, null);
  const invalid = rows.map(row => ({ ...row, observed_at: new Date(Date.parse(row.slot) + slot).toISOString() }));
  assert.equal(summarizeExperimentObservations(experiment, invalid, null, release + week).coverage.paired, 0);
});

test("non-AI guest saves create identity only for valid same-origin creates, and reads stay private", async t => {
  const db = await fixture(t); let ensured = 0;
  const deps = { readOwner: async () => null, ensureOwner: async () => { ensured++; return owner; }, database: async () => db, isCrossSite: request => request.headers.get("sec-fetch-site") === "cross-site" };
  const make = (body, headers = {}) => new Request("https://romanum.test/api/experiments", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await experimentResponse(make(sample(), { Origin: "https://other.test" }), deps)).status, 403);
  assert.equal((await experimentResponse(make({ ...sample(), ownerId: other }), deps)).status, 400);
  assert.equal(ensured, 0);
  const response = await experimentResponse(make(sample()), deps);
  assert.equal(response.status, 201); assert.equal(ensured, 1);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const saved = (await response.json()).experiment;
  assert.equal((await experimentResponse(new Request(`https://romanum.test/api/experiments/${saved.id}`), { ...deps, readOwner: async () => other }, saved.id)).status, 404);
  assert.equal((await experimentResponse(new Request("https://romanum.test/api/experiments"), deps)).status, 200);
  assert.equal(ensured, 1);
});
