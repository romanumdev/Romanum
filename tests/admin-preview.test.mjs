import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const sourceUrl = pathToFileURL(root).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (["next/link", "next/headers", "next/navigation"].includes(specifier)) return nextResolve(`${specifier}.js`, context);
    if (specifier.startsWith("@/") || (context.parentURL?.startsWith(sourceUrl) && specifier.startsWith("."))) {
      const base = specifier.startsWith("@/") ? path.resolve(root, specifier.slice(2)) : fileURLToPath(new URL(specifier, context.parentURL));
      const candidate = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find(file => existsSync(file) && statSync(file).isFile());
      if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceUrl) && /\.tsx?$/.test(url)) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
    return nextLoad(url, context);
  },
});
const { adminPreviewAllowed, adminPreviewRequestAllowed } = await import("../src/lib/admin/access.ts");
const { buildAdminReport, adminUtc, adminUsd } = await import("../src/lib/admin/report.ts");
const { adminFixtureProjection, adminFixtureReport, FIXTURE_AS_OF } = await import("../src/lib/admin/fixtures.ts");
const { default: AdminPage } = await import("../src/app/admin/page.tsx");
const { default: PreviewPage } = await import("../src/app/admin/preview/page.tsx");
const { GET: liveGET } = await import("../src/app/api/admin/route.ts");
const { GET: previewGET } = await import("../src/app/api/admin/preview/route.ts");
const { AdminDashboard } = await import("../src/components/admin/dashboard.tsx");
hooks.deregister();
const notFound = error => error.digest === "NEXT_HTTP_ERROR_FALLBACK;404";

test("fixture access requires local development and rejects production, remote and cross-origin requests", () => {
  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) assert.equal(adminPreviewAllowed("development", host), true);
  for (const environment of ["production", "test", undefined]) assert.equal(adminPreviewAllowed(environment, "localhost:3000"), false);
  for (const host of ["romanum.dev", "localhost.example", "example.com@localhost:3000", "", "localhost:3000/path"]) assert.equal(adminPreviewAllowed("development", host), false);
  assert.equal(adminPreviewAllowed("development", "localhost:3000", "https://evil.example"), false);
  assert.equal(adminPreviewRequestAllowed(new Request("https://romanum.dev/api/admin/preview", { headers: { host: "localhost:3000" } }), "development"), false);
});

test("live admin page and API deny missing owner configuration despite forged client claims", async () => {
  const previous = process.env.NODE_ENV;
  try {
    for (const environment of ["development", "production"]) {
      process.env.NODE_ENV = environment;
      for (const headers of [{}, { cookie: "romanum_session=ordinary-user" }, { cookie: "romanum_session=admin", "x-admin": "true", "x-user-role": "admin" }]) {
        const response = await liveGET(new Request("http://localhost:3000/api/admin", { headers }));
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: "Not found." });
        assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
        await assert.rejects(AdminPage({ searchParams: Promise.resolve({}) }), notFound);
      }
    }
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test("actual fixture page and API fail closed in production before rendering or loading a report", async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(PreviewPage({ searchParams: Promise.resolve({}) }), notFound);
    const response = await previewGET(new Request("http://localhost:3000/api/admin/preview", { headers: { host: "localhost:3000", cookie: "romanum_session=admin" } }));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found." });
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test("local preview API returns explicit fixtures and handles empty/unavailable states without real data", async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    const sample = await previewGET(new Request("http://localhost:3000/api/admin/preview"));
    const body = await sample.json();
    assert.equal(body.mode, "fixture");
    assert.equal(body.report.registeredUsers, 5);
    assert.ok(body.report.users.every(user => user.id.startsWith("fixture-") && user.username.startsWith("fixture_")));
    const empty = await previewGET(new Request("http://localhost:3000/api/admin/preview?state=empty"));
    assert.equal((await empty.json()).report.savedMessages, 0);
    const error = await previewGET(new Request("http://localhost:3000/api/admin/preview?state=unavailable"));
    assert.equal(error.status, 503);
    assert.deepEqual(await error.json(), { mode: "fixture", error: "Fixture reporting unavailable." });
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test("dashboard separates retained messages, active registered users, tool calls, runs and all-owner spending", () => {
  const report = adminFixtureReport();
  assert.equal(report.registeredUsers, 5);
  assert.equal(report.activeUsers24h, 2);
  assert.equal(report.savedMessages, 14);
  assert.equal(report.userMessages, 7);
  assert.equal(report.assistantMessages, 7);
  assert.equal(report.messages24h, 8);
  assert.equal(report.creditsSpent24h, 27);
  assert.equal(report.users.reduce((total, user) => total + user.spent24h, 0), 20);
  assert.deepEqual(report.meteredTools, { settled: 2, released: 1, pending: 1 });
  assert.deepEqual(report.backgroundRuns, { complete: 1, failed: 1, cancelled: 1 });
  assert.equal(report.releasedHolds24h, 20);
  assert.equal(report.positiveAdjustments24h, 2);
  assert.equal(report.negativeAdjustments24h, 1);
});

test("rolling 24-hour boundaries are half-open and distinct from UTC calendar trends", () => {
  const projection = { accounts: [], messages: [], usage: [], tools: [], runs: [], insights: [], ledger: [
    { ownerId: "fixture", entryType: "capture", amount: 3, balanceChange: -3, createdAt: "2026-10-01T04:00:00.000Z" },
    { ownerId: "fixture", entryType: "capture", amount: 10, balanceChange: -10, createdAt: "2026-10-01T03:59:59.999Z" },
    { ownerId: "fixture", entryType: "capture", amount: 99, balanceChange: -99, createdAt: FIXTURE_AS_OF },
  ] };
  const report = buildAdminReport(projection, FIXTURE_AS_OF);
  assert.equal(report.creditsSpent24h, 3);
  assert.equal(report.days.find(day => day.day === "2026-10-01").credits, 13);
  assert.equal(report.days.at(-1).credits, 0);
  assert.equal(report.days.at(-1).partial, true);
  assert.equal(adminUtc("2026-10-02T06:00:00+02:00"), "2026-10-02 04:00 UTC");
});

test("grants, reserves, released holds and adjustments do not become captured spending or refunds", () => {
  const data = adminFixtureProjection();
  data.ledger = data.ledger.filter(row => row.entryType !== "capture");
  const report = buildAdminReport(data, FIXTURE_AS_OF);
  assert.equal(report.creditsSpent24h, 0);
  assert.equal(report.releasedHolds24h, 20);
  assert.equal(report.positiveAdjustments24h, 2);
});

test("missing balances stay unknown and zero balances stay zero", () => {
  const report = adminFixtureReport();
  assert.equal(report.users.find(user => user.id === "fixture-d").available, 0);
  assert.equal(report.users.find(user => user.id === "fixture-e").available, null);
  assert.equal(report.users.find(user => user.id === "fixture-b").available, 51);
});

test("recorded provider cost and fractional usage price are not double-counted as credits spent", () => {
  const report = adminFixtureReport();
  assert.equal(report.hostedCostNanoUsd, 170_000_000);
  assert.equal(report.insightCostNanoUsd, 10_000_000);
  assert.equal(report.providerCostNanoUsd, 180_000_000);
  assert.equal(report.usagePriceNanoUsd, 281_700_000);
  assert.equal(report.usageCreditsCharged, 27);
  assert.equal(report.modelCalls, 4);
  assert.equal(adminUsd(report.providerCostNanoUsd), "$0.1800");
  assert.throws(() => buildAdminReport(adminFixtureProjection(), "invalid"));
});

test("reports strip unrelated private fields and render explicit fixture/empty/error/telemetry states", () => {
  const data = adminFixtureProjection();
  data.accounts[0].apiKey = "PRIVATE_KEY";
  data.messages[0].content = "PRIVATE_PROMPT";
  data.messages[0].events = [{ secret: "PRIVATE_EVENT" }];
  const report = buildAdminReport(data, FIXTURE_AS_OF);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|apiKey|events|content|ownerId/);
  const sample = renderToStaticMarkup(React.createElement(AdminDashboard, { report, state: "overview" }));
  assert.ok(sample.includes("Every value here is synthetic fixture data"));
  assert.ok(sample.includes("MCP tool usage"));
  assert.ok(sample.includes("MCP aggregate recording is unavailable."));
  report.mcpUsage = { available: true, fromDay: "2026-09-26", throughDay: "2026-10-02", totalCalls: 4,
    successfulCalls: 3, failedCalls: 1, successRate: 0.75,
    popularTools: [{ name: "search_games", totalCalls: 4, successfulCalls: 3, failedCalls: 1, successRate: 0.75 }] };
  const measured = renderToStaticMarkup(React.createElement(AdminDashboard, { report, state: "overview" }));
  for (const text of ["Recorded calls", "Popular tools", "search_games", "75.0%", "Today is partial"]) assert.ok(measured.includes(text));
  assert.ok(!measured.includes("MCP aggregate recording is unavailable."));
  assert.ok(sample.includes("Confirmed refund total"));
  assert.ok(sample.includes("not cash revenue or profit"));
  const empty = renderToStaticMarkup(React.createElement(AdminDashboard, { report: adminFixtureReport("empty"), state: "empty" }));
  assert.ok(empty.includes("No registered users in this fixture."));
  const unavailable = renderToStaticMarkup(React.createElement(AdminDashboard, { report: null, state: "unavailable" }));
  assert.ok(unavailable.includes("Reporting unavailable"));
  assert.ok(!unavailable.includes("Daily credits spent"));
});
