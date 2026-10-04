import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { dailyMetricChange } from "../src/lib/linked-games/changes.ts";

test("card links have concise names, readable projected qualifiers and retained metric descriptions", async (context) => {
  const fixtureLink = new URL("./linked-games-next-link.fixture.mjs", import.meta.url).href;
  const fixtureImage = new URL("./linked-games-next-image.fixture.mjs", import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, parent, nextResolve) {
      if (specifier === "next/link") return { url: fixtureLink, shortCircuit: true };
      if (specifier === "next/image") return { url: fixtureImage, shortCircuit: true };
      if (parent.conditions?.includes("require")) return nextResolve(specifier, parent);
      let target;
      if (specifier.startsWith("@/")) target = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
      else if (specifier.startsWith(".") && parent.parentURL?.startsWith("file:")) target = new URL(specifier, parent.parentURL);
      if (target && !existsSync(fileURLToPath(target))) {
        for (const extension of [".ts", ".tsx"]) {
          if (existsSync(fileURLToPath(`${target.href}${extension}`))) return nextResolve(`${target.href}${extension}`, parent);
        }
      }
      return nextResolve(target?.href ?? specifier, parent);
    },
    load(url, parent, nextLoad) {
      if (url === fixtureLink) return { format: "module", shortCircuit: true, source:
        'import React from "react"; export default function Link({ href, prefetch, children, ...props }) { return React.createElement("a", { ...props, href }, children); }' };
      if (url === fixtureImage) return { format: "module", shortCircuit: true, source:
        'export default function Image() { throw new Error("Fixture must not load images."); }' };
      if (url.startsWith("file:") && url.endsWith(".tsx")) return {
        format: "module", shortCircuit: true,
        source: ts.transpileModule(`import React from "react";\n${readFileSync(fileURLToPath(url), "utf8")}`, {
          compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
        }).outputText,
      };
      return nextLoad(url, parent);
    },
  });
  try {
    const { LinkedGames } = await import(new URL("../src/components/account/linked-games.tsx", import.meta.url).href);
    const { VerificationProvider } = await import(new URL("../src/components/verification.tsx", import.meta.url).href);
    const series = [{ day: "2026-09-29", value: 100, status: null }, { day: "2026-09-30", value: 125, status: null }];
    const fixture = (status = null, name = "Rescue Squad") => ({
      id: "synthetic-game", universeId: 123, name, iconUrl: null, creatorName: "Fixture Creator",
      playing: 45, likeRatio: 0.9, publicFetchedAt: "2026-10-02T10:00:00.000Z",
      status: "active", collect: true, syncing: false, syncedAt: "2026-10-02T10:00:00.000Z", syncError: null,
      metrics: [{ metric: "DailyActiveUsers", unit: "count", latest: { ...series[1], status },
        change: status === "Projected" ? null : dailyMetricChange(series, "count") }],
    });
    const render = (game, props = {}) => renderToStaticMarkup(createElement(VerificationProvider, null, createElement(LinkedGames, { initial: [game], ...props })));
    const complete = render(fixture());
    assert.match(complete, /<a[^>]*aria-label="View analytics for Rescue Squad"[^>]*>/);
    assert.match(complete, /<span class="sr-only">[^<]*relative change[^<]*Absolute change \+25/);
    assert.match(complete, /Daily active users/);
    assert.match(render(fixture(null, null)), /aria-label="View analytics for Universe 123"/);
    const unavailable = render(fixture(), { settings: true, oauthAvailable: false });
    assert.match(unavailable, /Roblox game authorization is not enabled yet/);
    assert.match(unavailable, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>Connect through Roblox/);
    const available = render(fixture(), { settings: true, oauthAvailable: true });
    assert.match(available, /name="universeId"/);
    assert.match(available, /Connect through Roblox/);
    assert.doesNotMatch(available, /type="password"|name="apiKey"|API key<\/span>/);
    const projected = render(fixture("Projected"));
    const labelClass = projected.match(/<span class="([^"]*)">Projected<\/span>/)?.[1];
    assert.ok(labelClass?.split(" ").includes("text-fg-muted"));
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    const colours = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*(#[\da-f]{6})/gi)].map(match => [match[1], match[2]]));
    const luminance = (hex) => {
      const linear = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    for (const background of ["surface", "surface-hover"]) {
      const foregroundLum = luminance(colours["fg-muted"]), backgroundLum = luminance(colours[background]);
      const ratio = (Math.max(foregroundLum, backgroundLum) + 0.05) / (Math.min(foregroundLum, backgroundLum) + 0.05);
      assert.ok(ratio >= 4.5, `Projected contrast on ${background}: ${ratio}`);
      context.diagnostic(`Projected theme-token contrast on ${background}: ${ratio.toFixed(3)}:1`);
    }
  } finally { hooks.deregister(); }
});
