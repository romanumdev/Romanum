import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT } from "../src/lib/assistant/prompt.ts";
import { CHAT_PROMPT } from "../src/lib/chats/prompt.ts";
import { assistantRequest, runAssistant } from "../src/lib/assistant/engine.ts";
import { loadSkill } from "../src/lib/assistant/skills.ts";
import { PUBLIC_TOOLS } from "../src/lib/public-tools.ts";
import { applyEvent, newTurn } from "../src/components/assistant/turns.ts";
import { PRIVATE_ANALYTICS_PROMPT } from "../src/lib/linked-games/assistant-prompt.ts";
import { AD_REPORT_PROMPT } from "../src/lib/ad-reports/assistant-prompt.ts";
import { withProjectContext } from "../src/lib/projects/chat-context.ts";
import { responseToneCases, toolHistory } from "./fixtures/response-tone.mjs";

// This suite checks prompt delivery, tool/event plumbing and preservation of authored
// example text. Its scripted completions do not evaluate an LLM's semantic behavior.
test("active guidance has no unconditional idea-research, warning or follow-up requirement", async () => {
  const design = await loadSkill("romanum-game-design");
  const genre = await loadSkill("romanum-genre-analysis");
  for (const prompt of [SYSTEM_PROMPT, CHAT_PROMPT]) {
    assert.ok(prompt.includes("Finish when the request is answered"));
    assert.ok(prompt.includes("repeat it only if new evidence"));
    assert.ok(prompt.includes("omit the unsupported premise"));
    assert.ok(!prompt.includes("Base every recommendation on data you fetched"));
    assert.ok(!prompt.includes("Before recommending each new game idea, call"));
    assert.ok(!prompt.includes("End with a short offer"));
    assert.ok(!prompt.includes("From the latest data, I'd go with"));
  }
  assert.ok(CHAT_PROMPT.startsWith(SYSTEM_PROMPT));
  assert.ok(CHAT_PROMPT.includes("without an automatic closing question"));
  assert.ok(CHAT_PROMPT.includes("When clarification is needed"));
  assert.ok(design.instructions.includes("do not require searches for each idea"));
  assert.ok(design.instructions.includes("No mandatory data preface"));
  assert.ok(!design.instructions.includes("Before recommending a concept, call"));
  assert.ok(genre.instructions.includes("do not append a warning or follow-up question to every answer"));
  assert.ok(genre.instructions.includes("do not establish demand or a causal explanation"));
  assert.ok(PUBLIC_TOOLS.research_game_idea.description.includes("Pure brainstorming and brief corrections do not require this lookup"));
});

for (const scenario of responseToneCases) {
  test(`offline scripted fixture: ${scenario.id}`, async () => {
    const design = await loadSkill("romanum-game-design");
    const guideHistory = toolHistory("guide", "load_skill", { skill: design.id }, { id: design.id, instructions: design.instructions });
    const conversation = [...guideHistory, ...scenario.conversation];
    const requests = [], events = [], tools = [], charges = [];
    const client = { chat: { completions: { create: async request => {
      requests.push(request);
      assert.equal(request.messages[0].content, CHAT_PROMPT);
      for (const phrase of scenario.guidance) assert.ok(request.messages[0].content.includes(phrase), `${scenario.id}: missing guidance ${phrase}`);
      assert.deepEqual(request.messages.slice(1, conversation.length + 1), conversation);
      assert.ok(request.tools.some(tool => tool.function.name === "research_game_idea"));
      const toolStep = scenario.call && requests.length === 1;
      return (async function* () {
        if (toolStep) {
          yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: scenario.call.name, arguments: JSON.stringify(scenario.call.args) } }] } }] };
        } else {
          const midpoint = Math.floor(scenario.reply.length / 2);
          yield { choices: [{ delta: { content: scenario.reply.slice(0, midpoint) } }] };
          yield { choices: [{ delta: { content: scenario.reply.slice(midpoint) } }] };
        }
        yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
      })();
    } } } };
    await runAssistant({ client, conversation, systemPrompt: CHAT_PROMPT, signal: new AbortController().signal,
      send: event => events.push(event), billing: { credits: 0,
        reserve: async () => { charges.push("reserve"); return "offline"; },
        settle: async () => { charges.push("settle"); },
        finish: async () => assert.fail("offline fixture reports usage"),
        tool: async name => {
          // Never invoke the real lookup closure: every tool outcome is synthetic.
          tools.push(name); assert.equal(name, scenario.call?.name); return scenario.outcome;
        },
      },
    });
    assert.equal(requests.length, scenario.call ? 2 : 1);
    assert.deepEqual(tools, scenario.call ? [scenario.call.name] : []);
    assert.equal(charges.length, requests.length * 2);
    assert.equal(events.at(-1).type, "done");
    assert.equal(events.filter(event => event.type === "text").map(event => event.delta).join(""), scenario.reply);
    assert.equal(events.at(-1).messages.at(-1).content, scenario.reply);
    const rendered = events.reduce((turn, event, index) => applyEvent(turn, event, index), newTurn(scenario.id, "Offline fixture"));
    assert.equal(rendered.answer.join("\n"), scenario.reply);
    if (scenario.outcome) {
      const result = events.find(event => event.type === "tool_end");
      assert.equal(result.ok, scenario.outcome.ok);
      assert.equal(result.summary, scenario.outcome.ok ? scenario.outcome.summary : scenario.outcome.error);
      assert.equal(rendered.steps.find(step => step.kind === "tool").status, scenario.outcome.ok ? "done" : "error");
      assert.ok(requests[1].messages.at(-1).content.includes(scenario.outcome.ok ? '"games"' : '"error"'));
    }
  });
}

test("owner analytics, audit coverage and spending consent remain attached to actual requests", () => {
  const projectTools = { definitions: [{ type: "function", function: { name: "list_ad_reports", parameters: {} } }] };
  const analyticsTools = { definitions: [] };
  const request = assistantRequest([{ role: "user", content: "Audit my linked game and imported ads." }], { systemPrompt: CHAT_PROMPT, projectTools, analyticsTools });
  assert.equal(request.messages[0].content, CHAT_PROMPT + PRIVATE_ANALYTICS_PROMPT + AD_REPORT_PROMPT);
  assert.ok(request.messages[0].content.includes("Keep the existing image-generation approval/spending workflow"));
  assert.ok(request.messages[0].content.includes("never request, reveal or invent it"));
  assert.ok(request.messages[0].content.includes("separate imported-ads AI-analysis opt-in"));
  // Installed owner tools can trigger a final step at a budget limit, even for a
  // creative turn. Scope missing areas to requested facts/audit coverage, not all failures.
  const final = assistantRequest([], { systemPrompt: CHAT_PROMPT, analyticsTools, finalAnalysisStep: true });
  assert.equal(final.tools, undefined);
  assert.ok(final.messages.at(-1).content.includes("State any missing or unchecked areas"));
  assert.ok(final.messages[0].content.includes("refers to gaps in the user's requested facts or audit scope, not every failed tool attempt"));
});

test("the actual saved-brief layer leaves a newer correction as the final user request", () => {
  const correction = { role: "user", content: "no definitely not i want a verity game not just lava man" };
  const project = { id: "offline-project", name: "Old lava idea", revision: 2, archived: false, context: { genre: "Lava survival" } };
  const conversation = withProjectContext([{ role: "user", content: "Suggest ideas." }, correction], project);
  const request = assistantRequest(conversation, { systemPrompt: CHAT_PROMPT });
  assert.equal(request.messages.at(-1), correction);
  assert.equal(request.messages.at(-2).role, "user");
  assert.ok(request.messages.at(-2).content.includes("Saved project brief (revision 2)"));
  assert.ok(request.messages[0].content.includes("Follow the user's current brief and corrections"));
  assert.ok(request.messages[0].content.includes("drop a rejected direction instead of carrying it into renamed ideas"));
});
