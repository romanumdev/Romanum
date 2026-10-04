import test from "node:test";
import assert from "node:assert/strict";
import { runAssistant } from "../src/lib/assistant/engine.ts";
import { prepareCall, runTool } from "../src/lib/assistant/tools.ts";
import { FetchedData } from "../src/lib/assistant/fetched-data.ts";
import { applyEvent, newTurn } from "../src/components/assistant/turns.ts";
import { recordEvent } from "../src/lib/chats/store.ts";
import { replayChatMessages } from "../src/components/assistant/replay.ts";

test("implementation and continuation tools prepare replayable text without model-controlled actions", async () => {
  const brief = { title: "One-lap prototype", context: "Existing pet racing game; no measured retention supplied.", goal: "Complete one race.", requirements: ["Keep race validation on the server."], acceptanceCriteria: ["Two players can complete and restart a race."] };
  const data = new FetchedData();
  const created = await runTool(prepareCall("create_implementation_brief", JSON.stringify(brief)), data);
  assert.equal(created.ok, true);
  assert.deepEqual(created.brief, brief);
  const offered = await runTool(prepareCall("offer_chat_continuation", JSON.stringify({ reason: "Continue planning the prototype." })), data);
  assert.equal(offered.ok, true);
  assert.deepEqual(offered.chatOffer, { reason: "Continue planning the prototype." });
  for (const extra of [{ href: "https://example.invalid" }, { code: "execute()" }, { action: "navigate" }]) {
    assert.equal((await runTool(prepareCall("offer_chat_continuation", JSON.stringify({ reason: "Continue", ...extra })), data)).ok, false);
  }
  const records = [];
  for (const event of [{ type: "implementation_brief", id: "brief", brief }, { type: "chat_offer", reason: offered.chatOffer.reason }, { type: "done", messages: [] }]) recordEvent(records, event, 5);
  const replay = replayChatMessages([{ id: "question", role: "user", content: "Help build this.", attachments: [], events: [] }, { id: "answer", role: "assistant", content: "", attachments: [], events: records }]);
  assert.deepEqual(replay[0].briefs, [{ id: "brief", brief }]);
  assert.equal(replay[0].chatOffer, offered.chatOffer.reason);
  assert.equal(replay[0].done, true);
  assert.equal(applyEvent(newTurn("question", "Build"), { type: "implementation_brief", id: "bad", brief: { ...brief, requirements: [] } }, 0).briefs, undefined);
});

test("a finished answer makes no extra prediction call or credit reservation", async () => {
  const requests = [], charges = [], events = [];
  const usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 };
  const client = { chat: { completions: { create: async request => {
    requests.push(request);
    return (async function* () {
      yield { choices: [{ delta: { content: "For the pet racing game, prototype one short race first." } }] };
      yield { choices: [], usage };
    })();
  } } } };
  await runAssistant({
    client,
    conversation: [{ role: "user", content: "Help me plan a +1 pet racing game." }],
    signal: new AbortController().signal,
    send: event => events.push(event),
    billing: {
      credits: 0,
      reserve: async () => { charges.push("reserve"); return "answer"; },
      settle: async () => charges.push("settle"),
      finish: async () => assert.fail("reported usage must settle"),
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, true);
  assert.deepEqual(charges, ["reserve", "settle"]);
  assert.deepEqual(events.map(event => event.type), ["text", "done"]);
  assert.equal(events.at(-1).messages[0].content, "For the pet racing game, prototype one short race first.");
});

test("the model loop emits implementation and chat-offer events through validated local tools", async () => {
  const brief = { title: "Prototype", context: "Existing Roblox game; core loop agreed by the user.", goal: "Build one round.", requirements: ["Keep scoring on the server."], acceptanceCriteria: ["Two players can finish a round."] };
  const calls = [
    { index: 0, id: "brief", type: "function", function: { name: "create_implementation_brief", arguments: JSON.stringify(brief) } },
    { index: 1, id: "offer", type: "function", function: { name: "offer_chat_continuation", arguments: JSON.stringify({ reason: "Continue implementing this prototype." }) } },
  ];
  let requests = 0;
  const events = [];
  const client = { chat: { completions: { create: async () => {
    const first = requests++ === 0;
    return (async function* () {
      yield { choices: [{ delta: first ? { tool_calls: calls } : { content: "The brief is ready to copy." } }] };
      yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
    })();
  } } } };
  await runAssistant({ client, conversation: [{ role: "user", content: "Prepare implementation instructions for our agreed prototype." }], send: event => events.push(event), signal: new AbortController().signal,
    billing: { credits: 0, reserve: async () => "synthetic", settle: async () => {}, finish: async () => assert.fail("Usage must settle"), tool: async (_name, execute) => execute() } });
  assert.equal(requests, 2);
  assert.deepEqual(events.find(event => event.type === "implementation_brief").brief, brief);
  assert.equal(events.find(event => event.type === "chat_offer").reason, "Continue implementing this prototype.");
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.filter(event => event.type === "tool_end" && event.ok).length, 2);
});
