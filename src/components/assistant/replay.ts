import type { StoredMessage } from "../../lib/chats/store.ts";
import { applyEvent, finishTurn, newTurn, type Turn } from "./turns.ts";

/** Ask and Chats render the same stored question and event rows, without importing or copying them. */
export function replayChatMessages(messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const attachments = message.attachments.map(file => ({ ...file, url: `/api/chat-attachments/${file.id}` }));
      turns.push({ ...newTurn(message.id, message.content), attachments });
    } else if (turns.length) {
      let turn = turns[turns.length - 1];
      for (const { t, e } of message.events) turn = applyEvent(turn, e, t);
      turns[turns.length - 1] = turn.done ? turn : finishTurn(turn, message.events.at(-1)?.t ?? 0);
    }
  }
  return turns;
}
