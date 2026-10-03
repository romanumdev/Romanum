export const modelId = "deepseek-v4-pro";
export const tool = { name: "synthetic_lookup", description: "Read a synthetic fixture", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
export const request = extra => ({ modelId, system: "Synthetic instructions", messages: [{ role: "user", content: "Inspect fixture." }],
  tools: [tool], maxTokens: 100, maxInputTokens: 1_000_000, ...extra });
export const usage = extra => ({ prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60,
  prompt_tokens_details: { cached_tokens: 40 }, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 }, total_tokens: 120, ...extra });
export const envelope = extra => ({ id: "chatcmpl_fixture", object: "chat.completion", model: modelId,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Verified answer.", reasoning_content: "synthetic_private_reasoning" } }],
  usage: usage(), ...extra });
export const toolEnvelope = (name = tool.name) => envelope({ choices: [{ index: 0, finish_reason: "tool_calls", message: {
  role: "assistant", content: "Checking fixtures.", reasoning_content: "synthetic_private_reasoning",
  tool_calls: [{ id: "call_fixture_1", type: "function", function: { name, arguments: '{"query":"fixture"}' } }],
} }] });
export const response = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
