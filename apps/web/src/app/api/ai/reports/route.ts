import { z } from "zod";
import { ChartSpecSchema } from "@homebase/ai";
import { saveReport, userCtx } from "@homebase/core";
import { today } from "@homebase/shared";
import { getDb } from "@/server/db";
import { apiUser, json, sameOrigin } from "@/server/ai/http";

export const dynamic = "force-dynamic";

const Body = z.object({ name: z.string().trim().min(1).max(120), spec: ChartSpecSchema, conversationId: z.string().uuid().optional() });

/** POST /api/ai/reports — "Save as report" on an Ask chart (§12.5). Stored as saved_reports {kind: ai_chart}. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "invalid", message: "That chart can't be saved." }, 400);
  const r = await saveReport(userCtx(getDb(), auth.user.id, today()), {
    name: body.data.name,
    spec: { kind: "ai_chart", chart: body.data.spec, ...(body.data.conversationId ? { conversationId: body.data.conversationId } : {}) },
  });
  return json({ ok: true, id: r.id, name: r.name });
}
