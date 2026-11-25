import { getDb } from "@/server/db";
import { archiveConversation, canAccessConversation, getConversation, loadThread } from "@/server/ai/conversations";
import { apiUser, json, sameOrigin } from "@/server/ai/http";

export const dynamic = "force-dynamic";

/** GET /api/ask/conversations/:id — the thread as view models (text, charts, action cards). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const db = getDb();
  const c = await getConversation(db, id);
  if (!c || !canAccessConversation(c, auth.user.id)) return json({ error: "not_found" }, 404);
  return json({ conversation: { id: c.id, title: c.title }, turns: await loadThread(db, id) });
}

/** DELETE /api/ask/conversations/:id — archive (hidden from the list; messages kept for the audit trail). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const db = getDb();
  const c = await getConversation(db, id);
  if (!c || c.userId !== auth.user.id) return json({ error: "not_found" }, 404);
  await archiveConversation(db, id);
  return json({ ok: true });
}
