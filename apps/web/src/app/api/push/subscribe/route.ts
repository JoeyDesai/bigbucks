import { z } from "zod";
import { getDb } from "@/server/db";
import { apiUser, json, sameOrigin } from "@/server/ai/http";
import { getOrCreateVapidPublic, saveSubscription } from "@/server/settings/push";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";

const Sub = z.object({
  endpoint: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "push endpoints are https"),
  keys: z.object({ p256dh: z.string().min(16).max(200), auth: z.string().min(8).max(100) }),
});

/** GET /api/push/subscribe — the VAPID public key for PushManager.subscribe (created on first use). */
export async function GET() {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  try {
    const v = await getOrCreateVapidPublic(getDb());
    return json({ publicKey: v.publicKey });
  } catch (e) {
    log.error({ err: (e as Error).message }, "vapid key unavailable");
    return json({ error: "vapid_unavailable", message: "Push keys can't be created: HOMEBASE_MASTER_KEY isn't set on the server." }, 503);
  }
}

/** POST /api/push/subscribe — store this device's PushSubscription for the signed-in user. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const body = Sub.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "invalid", message: "That subscription isn't valid." }, 400);
  await saveSubscription(getDb(), auth.user.id, body.data, req.headers.get("user-agent"));
  return json({ ok: true });
}
