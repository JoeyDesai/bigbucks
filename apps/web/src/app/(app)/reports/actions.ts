"use server";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { REPORT_SLUGS, paramsFromSearch, reportDefaults, saveReportView, setSavedReportPinned, userCtx, type Ctx } from "@homebase/core";
import { today } from "@homebase/shared";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";

/** Core writes need the users-table id; the identity store may hold its own ids, so match by id, login or name. */
async function ctxForCurrentUser(): Promise<Ctx> {
  const cu = await getCurrentUser();
  if (!cu) throw new Error("Not signed in");
  const db = getDb();
  const u = cu.user as { id: string; displayName: string; tailscaleLogin?: string | null };
  const r = await db.execute<{ id: string }>(sql`
    SELECT id FROM users
    WHERE id::text = ${u.id} OR (tailscale_login IS NOT NULL AND tailscale_login = ${u.tailscaleLogin ?? ""}) OR display_name = ${u.displayName}
    ORDER BY (id::text = ${u.id}) DESC LIMIT 1`);
  return userCtx(db, r.rows[0]?.id ?? null, today());
}

const SaveView = z.object({
  slug: z.enum(REPORT_SLUGS).refine((s) => s !== "saved"),
  search: z.string().max(2000),
  name: z.string().trim().min(1).max(80),
  pinned: z.boolean().default(false),
});

export async function saveReportViewAction(input: z.input<typeof SaveView>): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const p = SaveView.safeParse(input);
  if (!p.success) return { ok: false, error: "Give the report a name." };
  const ctx = await ctxForCurrentUser();
  const { today: _t, ...params } = paramsFromSearch(new URLSearchParams(p.data.search), reportDefaults(p.data.slug));
  void _t;
  const row = await saveReportView(ctx, { name: p.data.name, report: p.data.slug as Exclude<(typeof REPORT_SLUGS)[number], "saved">, params, pinned: p.data.pinned });
  revalidatePath("/reports");
  return { ok: true, id: row.id };
}

export async function pinSavedReportAction(id: string, pinned: boolean): Promise<void> {
  z.string().uuid().parse(id);
  const ctx = await ctxForCurrentUser();
  await setSavedReportPinned(ctx, id, pinned);
  revalidatePath("/reports");
  revalidatePath("/reports/saved");
}
