import { getDb } from "@/server/db";
import { listConversations } from "@/server/ai/conversations";
import { apiUser, json } from "@/server/ai/http";

export const dynamic = "force-dynamic";

/** GET /api/ask/conversations — the signed-in user's chats, newest first. */
export async function GET() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  return json({ conversations: await listConversations(getDb(), auth.user.id) });
}
