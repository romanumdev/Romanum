import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ChatView } from "@/components/chats/chat-view";
import { readChat } from "@/lib/chats/store";
import { readOwner, readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { readProject } from "@/lib/projects/store";
import { activeChatRun } from "@/lib/chats/runs";
import { hasReadyModel } from "@/lib/models/readiness";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ context?: string }> };

// Request memoisation shares one read between the title and the page. A database failure reaches the error page.
const getChat = cache(async (id: string) => {
  const owner = await readOwner();
  const database = await historyDatabase();
  if (!database) throw new Error("Chats unavailable.");
  if (!owner) return null;
  // Recover an expired review before reading messages, so partial output survives this reload.
  await activeChatRun(database, owner, id);
  return readChat(database, owner, id);
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await connection();
  const chat = await getChat((await params).id);
  return { title: chat?.title ?? "Chat not found" };
}

export default async function ChatPage({ params, searchParams }: Props) {
  await connection();
  const chat = await getChat((await params).id);
  if (!chat) notFound();
  const owner = await readOwner();
  const db = await historyDatabase();
  const project = chat.projectId && owner && db ? await readProject(db, owner, chat.projectId) : null;
  const activeRun = owner && db ? await activeChatRun(db, owner, chat.id) : null;
  return <ChatView key={chat.id} chatId={chat.id} initialMessages={chat.messages} recent={null} connected={hasReadyModel()} project={project} canPlan={!!await readAccount()} contextTab={(await searchParams).context} activeRun={activeRun ?? undefined} />;
}
