import "server-only";
import { executeConfirmedAction, PendingActionError, rejectPendingAction, type ActionExecutor, type PendingActionStatus } from "@homebase/ai";
import { DbAuditSink, DbPendingActionStore } from "@homebase/ai/db";
import type { Db } from "@homebase/db";
import { log } from "@/server/log";
import { canAccessConversation, getConversation } from "./conversations";
import { defaultActionExecutor } from "./context";

export type ActionOutcome =
  | { ok: true; status: PendingActionStatus; summary?: string }
  | { ok: false; httpStatus: number; error: string; status?: PendingActionStatus };

async function loadOwned(db: Db, actionId: string, userId: string) {
  const store = new DbPendingActionStore(db);
  const action = await store.get(actionId);
  if (!action?.conversationId) return { store, action: null };
  const c = await getConversation(db, action.conversationId);
  if (!c || !canAccessConversation(c, userId)) return { store, action: null };
  return { store, action };
}

/** Confirm button (§11.3): runs that card's write exactly once, audited actor=ai, confirmed_by=user. */
export async function confirmAction(db: Db, o: { actionId: string; userId: string; editedInput?: unknown; executor?: ActionExecutor }): Promise<ActionOutcome> {
  const { store, action } = await loadOwned(db, o.actionId, o.userId);
  if (!action) return { ok: false, httpStatus: 404, error: "That change wasn't found." };
  const executor = o.executor ?? defaultActionExecutor(db, action.requestedBy ?? o.userId);
  try {
    const r = await executeConfirmedAction({ actionId: action.id, confirmedBy: o.userId, store, executor, audit: new DbAuditSink(db), ...(o.editedInput !== undefined ? { editedInput: o.editedInput } : {}) });
    if (r.status === "confirmed") return { ok: true, status: "confirmed", ...(r.result.summary ? { summary: r.result.summary } : {}) };
    log.warn({ actionId: action.id, tool: action.tool, err: r.error }, "confirmed AI action failed");
    return { ok: false, httpStatus: 422, status: "failed", error: friendly(r.error) };
  } catch (e) {
    if (e instanceof PendingActionError) {
      const http = e.code === "not_found" ? 404 : e.code === "not_pending" ? 409 : 400;
      return { ok: false, httpStatus: http, error: e.code === "not_pending" ? "This card was already confirmed or cancelled." : e.message };
    }
    throw e;
  }
}

function friendly(err: string): string {
  // Core errors are already user-facing; anything else is summarized.
  return err.length > 240 ? `${err.slice(0, 237)}…` : err;
}

export async function rejectAction(db: Db, o: { actionId: string; userId: string }): Promise<ActionOutcome> {
  const { store, action } = await loadOwned(db, o.actionId, o.userId);
  if (!action) return { ok: false, httpStatus: 404, error: "That change wasn't found." };
  const ok = await rejectPendingAction(store, action.id, o.userId);
  return ok ? { ok: true, status: "rejected" } : { ok: false, httpStatus: 409, error: "This card was already confirmed or cancelled." };
}
