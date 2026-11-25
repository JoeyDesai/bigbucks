import { z } from "zod";
import { getDb } from "@/server/db";
import { apiUser, json, sameOrigin } from "@/server/ai/http";
import { deleteSubscription } from "@/server/settings/push";

export const dynamic = "force-dynamic";

/** POST /api/push/unsubscribe — forget this device's subscription. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const body = z.object({ endpoint: z.string().url().max(2000) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "invalid" }, 400);
  return json({ ok: true, removed: await deleteSubscription(getDb(), auth.user.id, body.data.endpoint) });
}
