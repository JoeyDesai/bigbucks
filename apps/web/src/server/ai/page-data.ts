import "server-only";
import { requireUser } from "@/server/auth";
import { env } from "@/server/env";
import { getDb } from "@/server/db";
import { resolveDbUser } from "@/server/settings/dbUser";
import type { CategoryOption } from "@/components/ask/AskAction";
import type { AskStatusVM, ConversationListItem } from "@/components/ask/types";
import { getAiStatus } from "./client";
import { listCategoryRefs } from "./context";
import { listConversations } from "./conversations";

const usd = (micro: bigint) => `$${(Number(micro / 10_000n) / 100).toFixed(2)}`;

export async function loadAskPage(): Promise<{ status: AskStatusVM; conversations: ConversationListItem[]; categories: CategoryOption[]; userId: string | null }> {
  const cu = await requireUser();
  const db = getDb();
  const user = await resolveDbUser(db, cu);
  const st = await getAiStatus(db);
  const demo = env().HOMEBASE_DEMO === "1";
  const isAdmin = cu.user.role === "admin" && !demo;
  let blockedReason: string | null = null;
  if (demo) blockedReason = "Ask, the AI chat, is turned off in the demo. In the real app it answers questions like these from your own budget.";
  else if (!st.configured) blockedReason = isAdmin ? "Ask isn't set up yet. Add an Anthropic API key in Settings → AI." : "Ask isn't set up yet. An admin needs to add an Anthropic API key in Settings → AI.";
  else if (st.state === "exceeded") blockedReason = `This month's AI budget (${usd(st.capMicroUsd)}) is used up, so Ask is paused until next month.${isAdmin ? " You can raise the cap in Settings → AI." : ""}`;
  else if (!user) blockedReason = "Your sign-in doesn't match a household user yet.";
  const categories = (await listCategoryRefs(db)).filter((c) => !c.hidden && (c.kind === "normal" || c.kind === "cc_payment")).map((c) => ({ id: c.id, name: c.name, group: c.group }));
  return {
    status: {
      configured: st.configured,
      blockedReason,
      spentMicroUsd: st.spentMicroUsd.toString(),
      capMicroUsd: st.capMicroUsd.toString(),
      state: st.state,
      isAdmin,
      autoSendVoice: true,
      chatModel: st.models.chat,
      deepModel: st.models.deep,
    },
    conversations: user ? await listConversations(db, user.id) : [],
    categories,
    userId: user?.id ?? null,
  };
}
