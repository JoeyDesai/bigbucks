import "server-only";
import { unstable_rethrow } from "next/navigation";
import { CoreError, userCtx, type Ctx } from "@homebase/core";
import { today } from "@homebase/shared";
import { getDb } from "./db";
import { requireAdmin, requireUser, type CurrentUser } from "./auth";
import { log } from "./log";

/** Write context for the signed-in user (America/New_York "today"). */
export async function userWriteCtx(): Promise<{ ctx: Ctx; cu: CurrentUser }> {
  const cu = await requireUser();
  return { ctx: userCtx(getDb(), cu.user.id, today()), cu };
}

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Run a server-action body with the user's ctx; map service errors to a short message. */
export async function run<T extends object>(name: string, body: (ctx: Ctx, cu: CurrentUser) => Promise<T>, opts: { admin?: boolean } = {}): Promise<ActionResult<T>> {
  const cu = opts.admin ? await requireAdmin() : await requireUser();
  const ctx = userCtx(getDb(), cu.user.id, today());
  try {
    const out = await body(ctx, cu);
    return { ok: true, ...out };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof CoreError) return { ok: false, error: e.message };
    if (e && typeof e === "object" && "issues" in e) return { ok: false, error: "Some fields aren't valid." };
    log.error({ action: name, err: e instanceof Error ? e.message : String(e) }, "action failed");
    return { ok: false, error: "Something went wrong. Nothing was changed." };
  }
}
