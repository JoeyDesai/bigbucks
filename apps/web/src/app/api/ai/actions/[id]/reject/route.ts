import { z } from "zod";
import { getDb } from "@/server/db";
import { rejectAction } from "@/server/ai/actions";
import { apiUser, json, sameOrigin } from "@/server/ai/http";

export const dynamic = "force-dynamic";

/** POST /api/ai/actions/:id/reject — the card's Cancel button. Nothing is changed. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return json({ error: "not_found" }, 404);
  const r = await rejectAction(getDb(), { actionId: id, userId: auth.user.id });
  return r.ok ? json(r) : json(r, r.httpStatus);
}
