import "server-only";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { CoreError, userCtx, type Ctx } from "@homebase/core";
import { today } from "@homebase/shared";
import { ZodError } from "zod";
import { requireAdmin, requireUser, type CurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { env } from "@/server/env";
import { log } from "@/server/log";
import { requireDbUser, type DbUserRef } from "./dbUser";

/** An error whose message is safe and useful to show (never contains secrets). */
export class UserFacingError extends Error {}

export type SettingsResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Settings server-action wrapper: auth (admin sections 404 for members), a user write ctx (every core
 * write audits), error mapping, and revalidation of the section.
 */
export async function act<T extends object>(
  name: string,
  opts: { admin?: boolean; revalidate?: string | string[] },
  body: (x: { ctx: Ctx; cu: CurrentUser; user: DbUserRef }) => Promise<T>,
): Promise<SettingsResult<T>> {
  const cu = opts.admin ? await requireAdmin() : await requireUser();
  // Demo visitors can look at Connections, Users, AI and Backups but not change them.
  if (opts.admin && env().HOMEBASE_DEMO === "1") return { ok: false, error: "That's turned off in the demo." };
  const db = getDb();
  try {
    const user = await requireDbUser(db, cu);
    const out = await body({ ctx: userCtx(db, user.id, today()), cu, user });
    for (const p of [opts.revalidate ?? []].flat()) revalidatePath(p);
    return { ok: true, ...out };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof UserFacingError || e instanceof CoreError) return { ok: false, error: e.message };
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).slice(0, 3).join("; ") };
    const msg = e instanceof Error ? e.message : String(e);
    if (/HOMEBASE_MASTER_KEY/.test(msg)) return { ok: false, error: "Secrets can't be stored: HOMEBASE_MASTER_KEY isn't set on the server." };
    log.error({ action: name, err: msg }, "settings action failed");
    return { ok: false, error: "Something went wrong. Nothing was changed." };
  }
}
