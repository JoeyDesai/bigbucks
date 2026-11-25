import { randomUUID } from "node:crypto";
import { requireUser } from "@/server/auth";
import { loadAskPage } from "@/server/ai/page-data";
import { AskView } from "./AskView";

export const metadata = { title: "Ask" };
export const dynamic = "force-dynamic";

export default async function AskPage() {
  await requireUser();
  const d = await loadAskPage();
  // A fresh key per render: "New chat" from a thread URL must remount with an empty thread.
  return <AskView key={randomUUID()} conversations={d.conversations} turns={[]} conversationId={null} status={d.status} categories={d.categories} />;
}
