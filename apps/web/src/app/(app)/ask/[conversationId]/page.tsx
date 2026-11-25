import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { canAccessConversation, getConversation, loadThread } from "@/server/ai/conversations";
import { loadAskPage } from "@/server/ai/page-data";
import { resolveDbUser } from "@/server/settings/dbUser";
import { AskView } from "../AskView";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ conversationId: string }> }) {
  const cu = await requireUser();
  const { conversationId } = await params;
  const db = getDb();
  const c = await getConversation(db, conversationId);
  // Same rule as the page: another member's chat title stays out of the tab title too.
  const me = c?.title ? await resolveDbUser(db, cu) : null;
  return { title: c?.title && canAccessConversation(c, me?.id ?? null) ? `${c.title} · Ask` : "Ask" };
}

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  await requireUser();
  const { conversationId } = await params;
  const d = await loadAskPage();
  const db = getDb();
  const convo = await getConversation(db, conversationId);
  if (!convo || !canAccessConversation(convo, d.userId)) notFound();
  const turns = await loadThread(db, conversationId);
  return <AskView key={conversationId} conversations={d.conversations} turns={turns} conversationId={conversationId} title={convo.title ?? "Ask"} status={d.status} categories={d.categories} />;
}
