import { z } from "zod";
import { getDb } from "@/server/db";
import { buildAiClient } from "@/server/ai/client";
import { askTurn, framesToStream, SSE_HEADERS } from "@/server/ai/ask";
import { canAccessConversation, getConversation } from "@/server/ai/conversations";
import { apiUser, json, sameOrigin } from "@/server/ai/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().trim().min(1).max(4000),
  deep: z.boolean().optional(),
});

/** POST /api/ask — stream one agent turn as Server-Sent Events (§11.2). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid", message: "Send a message of 1–4000 characters." }, 400);
  const db = getDb();
  const { conversationId, message, deep } = parsed.data;
  if (conversationId) {
    const c = await getConversation(db, conversationId);
    if (!c || !canAccessConversation(c, auth.user.id)) return json({ error: "not_found" }, 404);
  }
  const ai = await buildAiClient(db);
  const frames = askTurn({
    db,
    ai,
    speaker: { id: auth.user.id, name: auth.user.displayName },
    conversationId: conversationId ?? null,
    message,
    deep: deep ?? false,
    signal: req.signal,
  });
  return new Response(framesToStream(frames), { headers: SSE_HEADERS });
}
