import { z } from "zod";
import { getDb } from "@/server/db";
import { confirmAction } from "@/server/ai/actions";
import { apiUser, json, sameOrigin } from "@/server/ai/http";

export const dynamic = "force-dynamic";

const Body = z.object({ editedInput: z.record(z.string(), z.unknown()).optional() }).nullable();

/** POST /api/ai/actions/:id/confirm — run one pending Ask action (optionally with edited input). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return json({ error: "not_found" }, 404);
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "invalid" }, 400);
  const r = await confirmAction(getDb(), { actionId: id, userId: auth.user.id, ...(body.data?.editedInput ? { editedInput: body.data.editedInput } : {}) });
  return r.ok ? json(r) : json(r, r.httpStatus);
}
