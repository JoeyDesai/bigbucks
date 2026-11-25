/** audit_log helper (§5.4): every executed write records who did it, and for AI writes who confirmed it. */
import { and, desc, eq, type SQL } from "drizzle-orm";
import { auditLog, type AuditLogEntry } from "@homebase/db";
import type { Ctx, DbLike } from "./context";
import { assertWriteAllowed } from "./context";
import { toJson } from "./json";

export interface AuditInput {
  /** Dotted verb, e.g. "budget.assign", "transaction.recategorize". */
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Write one audit row using `ctx` for actor/user/confirmed_by. Pass the open transaction as `db`. */
export async function writeAudit(db: DbLike, ctx: Ctx, entry: AuditInput): Promise<void> {
  assertWriteAllowed(ctx);
  await db.insert(auditLog).values({
    userId: ctx.userId,
    actor: ctx.actor,
    confirmedBy: ctx.actor === "ai" ? (ctx.confirmedBy ?? null) : null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : toJson(entry.before),
    after: entry.after === undefined ? null : toJson(entry.after),
  });
}

export interface AuditQuery {
  entity?: string;
  entityId?: string;
  action?: string;
  limit?: number;
}

export async function listAudit(db: DbLike, q: AuditQuery = {}): Promise<AuditLogEntry[]> {
  const conds: SQL[] = [];
  if (q.entity) conds.push(eq(auditLog.entity, q.entity));
  if (q.entityId) conds.push(eq(auditLog.entityId, q.entityId));
  if (q.action) conds.push(eq(auditLog.action, q.action));
  return db
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.at))
    .limit(Math.min(q.limit ?? 100, 1000));
}
