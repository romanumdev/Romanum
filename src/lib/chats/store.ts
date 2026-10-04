import { randomUUID } from "node:crypto";
import type { ApiMessage, AssistantEvent } from "../assistant/types.ts";
import type { Database } from "../history/database.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_QUESTION_CHARS, type ImageType } from "./limits.ts";
import { ImageInputError, normalizeChatImage } from "./image-input.ts";
import { messageText } from "../assistant/message-text.ts";
import { chatProject, type ChatProject } from "../projects/chat-context.ts";

// Saved chats: each question with its reference images, each answer as the events that drew it, and the
// conversation in the model's format for later questions. Every read and write is scoped to an owner.

/** Model-format messages kept per chat; the oldest drop off first. */
const MAX_STORED_HISTORY = 200;
/** Model-format messages sent with each question, as in /api/assistant. */
const MAX_MODEL_HISTORY = 80;

/** A streamed event and when it arrived, in milliseconds after the answer started. */
export type TimedEvent = { t: number; e: AssistantEvent };
export type ChatSummary = { id: string; title: string; updatedAt: string };
export type StoredAttachment = { id: string; name: string };
export type StoredMessage = { id: string; role: "user" | "assistant"; content: string; events: TimedEvent[]; attachments: StoredAttachment[] };
export type Chat = { id: string; title: string; projectId: string | null; messages: StoredMessage[] };

export class ChatError extends Error {
  readonly code: "invalid_input" | "not_found";
  constructor(code: ChatError["code"], message: string) {
    super(message);
    this.name = "ChatError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isChatId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/**
 * Identifies PNG, JPEG and WebP images by their first bytes; anything else, SVG included, is refused. This is
 * not a decoder or a moderation check. saveQuestion also fully decodes and normalizes uploads.
 */
export function imageType(bytes: Uint8Array): ImageType | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** A display name for an attachment: the file's own name, without a path or control characters. */
export function attachmentName(raw: string): string {
  const name = (raw.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return name || "image";
}

/** A chat's title: its first question on one line, cut at about 60 characters. */
export function chatTitle(question: string): string {
  const line = question.replace(/\s+/g, " ").trim();
  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`;
}

/** Text-only history; current images are added separately to the outbound model request. */
export function questionForModel(question: string, attachmentNames: string[]): ApiMessage {
  const note = attachmentNames.length ? `\n\n[Attached reference images: ${attachmentNames.join(", ")}]` : "";
  return { role: "user", content: question + note };
}

/** The latest messages that fit, starting at a question so every tool call keeps its result. */
export function recentHistory(history: ApiMessage[], limit: number): ApiMessage[] {
  let start = Math.max(0, history.length - limit);
  while (start < history.length && history[start].role !== "user") start++;
  return history.slice(start);
}

/** What the model receives for a new question: the chat so far, then the question. */
export const modelConversation = (history: ApiMessage[], question: ApiMessage) => recentHistory([...history, question], MAX_MODEL_HISTORY);

/**
 * Adds a streamed event to an answer's record. Consecutive thinking or text chunks merge into one event, which
 * replays to the same answer. Legacy suggestions are discarded, and the finished turn's model messages are
 * kept in the chat's history instead.
 */
export function recordEvent(events: TimedEvent[], event: AssistantEvent, t: number) {
  if (event.type === "suggestion") return;
  if (event.type === "thinking" || event.type === "text") {
    const previous = events.at(-1)?.e;
    if (previous && (previous.type === "thinking" || previous.type === "text") && previous.type === event.type) {
      previous.delta += event.delta;
      return;
    }
  }
  events.push({ t, e: event.type === "done" ? { type: "done", messages: [] } : { ...event } });
}

export async function listChats(database: Database, ownerId: string, projectId?: string): Promise<ChatSummary[]> {
  if (projectId !== undefined && !isChatId(projectId)) return [];
  const { rows } = await database.query<{ id: string; title: string; updated_at: Date | string }>(
    `SELECT id, title, updated_at FROM chats WHERE owner_id=$1${projectId ? " AND project_id=$2" : ""} ORDER BY updated_at DESC, id LIMIT 50`,
    projectId ? [ownerId, projectId] : [ownerId],
  );
  return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: new Date(row.updated_at).toISOString() }));
}

export async function readChat(database: Database, ownerId: string, chatId: string): Promise<Chat | null> {
  if (!isChatId(chatId)) return null;
  const { rows: chats } = await database.query<{ id: string; title: string; project_id: string | null }>("SELECT id, title, project_id FROM chats WHERE id=$1 AND owner_id=$2", [chatId, ownerId]);
  if (!chats[0]) return null;
  const { rows: messages } = await database.query<Omit<StoredMessage, "attachments">>(
    "SELECT id, role, content, events FROM chat_messages WHERE chat_id=$1 ORDER BY seq",
    [chatId],
  );
  const { rows: files } = await database.query<{ id: string; message_id: string; name: string }>(
    "SELECT a.id, a.message_id, a.name FROM chat_attachments a JOIN chat_messages m ON m.id=a.message_id WHERE m.chat_id=$1 AND a.owner_id=$2 ORDER BY a.position",
    [chatId, ownerId],
  );
  return {
    id: chats[0].id,
    title: chats[0].title,
    projectId: chats[0].project_id,
    messages: messages.map((message) => ({
      ...message,
      attachments: files.filter((file) => file.message_id === message.id).map(({ id, name }) => ({ id, name })),
    })),
  };
}

/**
 * Saves a question and its reference images to a chat, starting a chat when there isn't one. Returns the chat's
 * history for the model and the stored attachments.
 */
export async function saveQuestion(
  database: Database,
  input: { ownerId: string; chatId: string | null; projectId?: string | null; question: string; attachments: { name: string; bytes: Uint8Array }[] },
) {
  const question = input.question.trim();
  if (!question || question.length > MAX_QUESTION_CHARS) throw new ChatError("invalid_input", "Write a message of up to 4,000 characters.");
  if (input.attachments.length > MAX_ATTACHMENTS) throw new ChatError("invalid_input", "Attach up to 3 images.");
  const files: { name: string; mimeType: "image/webp"; bytes: Uint8Array }[] = [];
  // Decode sequentially to bound peak memory per request. Nothing is persisted if any file fails.
  for (const file of input.attachments) {
    if (!imageType(file.bytes) || file.bytes.length > MAX_ATTACHMENT_BYTES) throw new ChatError("invalid_input", "Images must be PNG, JPEG or WebP, up to 5 MB.");
    try { files.push({ name: attachmentName(file.name), ...await normalizeChatImage(file.bytes) }); }
    catch (error) {
      if (error instanceof ImageInputError) throw new ChatError("invalid_input", error.message);
      throw error;
    }
  }
  if (input.chatId !== null && !isChatId(input.chatId)) throw new ChatError("not_found", "Chat not found.");
  if (input.projectId !== undefined && input.projectId !== null && !isChatId(input.projectId)) throw new ChatError("not_found", "Project not found.");

  return database.transaction(async (sql) => {
    // Match context saves and account closure before locking a chat or project.
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.ownerId]);
    let chatId = input.chatId;
    let history: ApiMessage[] = [];
    let projectId = input.projectId ?? null;
    let project: ChatProject | null = null;
    if (chatId) {
      const { rows } = await sql.query<{ history: ApiMessage[]; project_id: string | null }>("SELECT history, project_id FROM chats WHERE id=$1 AND owner_id=$2 FOR UPDATE", [chatId, input.ownerId]);
      if (!rows[0]) throw new ChatError("not_found", "Chat not found.");
      if (input.projectId && input.projectId !== rows[0].project_id) throw new ChatError("not_found", "Chat not found in this project.");
      projectId = rows[0].project_id;
      history = rows[0].history;
    }
    if (projectId) {
      project = await chatProject(sql, input.ownerId, projectId);
      if (!project) throw new ChatError("not_found", "Project not found.");
      if (!chatId && project.archived) throw new ChatError("invalid_input", "Restore this project to start a chat.");
    }
    if (chatId) await sql.query("UPDATE chats SET updated_at=now() WHERE id=$1", [chatId]);
    else {
      chatId = randomUUID();
      await sql.query("INSERT INTO chats(id, owner_id, title, project_id) VALUES ($1,$2,$3,$4)", [chatId, input.ownerId, chatTitle(question), projectId]);
    }
    const messageId = randomUUID();
    await sql.query("INSERT INTO chat_messages(id, chat_id, role, content) VALUES ($1,$2,'user',$3)", [messageId, chatId, question]);
    const attachments: StoredAttachment[] = [];
    for (const [position, file] of files.entries()) {
      const id = randomUUID();
      await sql.query(
        "INSERT INTO chat_attachments(id, message_id, owner_id, position, name, mime_type, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, messageId, input.ownerId, position, file.name, file.mimeType, Buffer.from(file.bytes)],
      );
      attachments.push({ id, name: file.name });
    }
    return { chatId, questionId: messageId, question, history, attachments, images: files, project };
  });
}

/** Saves an answer and adds it, with its question, to the chat's history for later questions. */
export async function saveAnswer(
  database: Database,
  input: { ownerId: string; chatId: string; question: ApiMessage; turn: ApiMessage[] | null; events: TimedEvent[] },
) {
  return database.transaction(async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.ownerId]);
    const { rows } = await sql.query<{ history: ApiMessage[] }>("SELECT history FROM chats WHERE id=$1 AND owner_id=$2 FOR UPDATE", [input.chatId, input.ownerId]);
    // The chat was deleted while the answer streamed.
    if (!rows[0]) return false;
    // An unfinished answer can stop mid tool call, which the model can't be shown again, so only its question stays.
    const question: ApiMessage = { role: "user", content: messageText(input.question) };
    const history = recentHistory([...rows[0].history, question, ...(input.turn ?? [])], MAX_STORED_HISTORY);
    await sql.query("INSERT INTO chat_messages(id, chat_id, role, events) VALUES ($1,$2,'assistant',$3)", [randomUUID(), input.chatId, JSON.stringify(input.events)]);
    await sql.query("UPDATE chats SET history=$2, updated_at=now() WHERE id=$1", [input.chatId, JSON.stringify(history)]);
    return true;
  });
}

export async function deleteChat(database: Database, ownerId: string, chatId: string): Promise<boolean> {
  if (!isChatId(chatId)) return false;
  const { rows } = await database.query("DELETE FROM chats WHERE id=$1 AND owner_id=$2 RETURNING id", [chatId, ownerId]);
  return rows.length > 0;
}

export async function readAttachment(database: Database, ownerId: string, id: string) {
  if (!isChatId(id)) return null;
  const { rows } = await database.query<{ name: string; mime_type: ImageType; bytes: Uint8Array }>(
    "SELECT name, mime_type, bytes FROM chat_attachments WHERE id=$1 AND owner_id=$2",
    [id, ownerId],
  );
  return rows[0] ? { name: rows[0].name, mimeType: rows[0].mime_type, bytes: rows[0].bytes } : null;
}
