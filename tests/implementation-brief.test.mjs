import test from "node:test";
import assert from "node:assert/strict";
import { implementationBriefSchema, formatImplementationBrief, recommendationImplementationBrief } from "../src/lib/implementation/brief.ts";

test("recommendation briefs retain design and dated evidence without inventing missing research", () => {
  const brief = recommendationImplementationBrief({
    title: "Rock relay", reason: "Prototype a game where players carry rocks, using team relays.",
    proposal: { coreAction: "carry rocks", variation: "team relays" },
    evidence: [{ name: "Recorded game", chart: "top-playing-now", playing: 42, genre: null, universeId: 12, rootPlaceId: 34, fetchedAt: "2026-10-03T12:00:00Z", expiresAt: "2026-10-03T12:05:00Z" }],
  }, "2026-10-03");
  const prompt = formatImplementationBrief(brief);
  assert.match(prompt, /carry rocks/);
  assert.match(prompt, /42 players observed/);
  assert.match(prompt, /https:\/\/www.roblox.com\/games\/34/);
  assert.match(prompt, /2026-10-03T12:00:00Z/);
  assert.match(prompt, /Competitor research was not recorded/);
  assert.match(prompt, /do not verify gameplay/);
  assert.match(prompt, /Acceptance criteria/);
});

test("legacy suggestions stay explicitly unverified and require core-loop confirmation", () => {
  const brief = recommendationImplementationBrief({ title: "Old idea", reason: "An earlier idea without saved evidence." }, "2026-10-02");
  assert.match(brief.context, /Legacy suggestion \(unverified\)/);
  assert.match(brief.context, /No dated chart observations/);
  assert.ok(brief.requirements.some(item => item.includes("Confirm the core player action")));
});

test("brief contract rejects unbounded content and executable extra fields", () => {
  const valid = { title: "Prototype", context: "Existing project", goal: "Playable loop", requirements: ["Inspect project"], acceptanceCriteria: ["Playtest loop"] };
  assert.equal(implementationBriefSchema.safeParse(valid).success, true);
  for (const invalid of [{ ...valid, context: "x".repeat(8001) }, { ...valid, requirements: Array(13).fill("Requirement") }, { ...valid, acceptanceCriteria: [] }, { ...valid, command: "execute" }]) {
    assert.equal(implementationBriefSchema.safeParse(invalid).success, false);
  }
});
