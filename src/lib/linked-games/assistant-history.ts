import type { ApiMessage } from "../assistant/types";

const PRIVATE_READS = new Set(["list_my_linked_games", "get_private_game_overview", "get_private_analytics_dimensions", "query_private_analytics", "list_ad_reports", "read_ad_report", "compare_ad_reports", "read_ad_learning_history", "prepare_ad_thumbnail_brief"]);

/** Old results (including Ask's client-supplied history) never grant access or masquerade as a fresh owner lookup. */
export function withoutPrivateToolHistory(messages: ApiMessage[]): ApiMessage[] {
  const privateIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) {
      if (call.type === "function" && PRIVATE_READS.has(call.function.name)) privateIds.add(call.id);
    }
  }
  return messages.map(message => {
    if (message.role !== "tool") return message;
    let privatePayload = false;
    try { privatePayload = JSON.parse(message.content as string)?.scope === "private_owner"; } catch { /* Non-JSON public output. */ }
    return privateIds.has(message.tool_call_id) || privatePayload
      ? { ...message, content: JSON.stringify({ privateAnalyticsWithheld: true, reason: "Previous private tool data is withheld. Check current consent and owner access and fetch a new result if needed." }) }
      : message;
  });
}
