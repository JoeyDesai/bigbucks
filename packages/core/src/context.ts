/**
 * Service context. Reads take a `DbLike` (a Drizzle db or an open transaction); writes take a `Ctx`
 * that also says who is acting, so every write can be audited (spec §5.4 audit_log, §11.3).
 */
import { sql } from "drizzle-orm";
import type { Db, Tx } from "@homebase/db";
import { today as localToday, type ISODate } from "@homebase/shared";
import { ValidationError } from "./errors";

export type DbLike = Db | Tx;

export type Actor = "user" | "ai" | "system";

export interface Ctx {
  db: DbLike;
  /** The user acting (for `ai`, the user in the conversation). null for system jobs. */
  userId: string | null;
  actor: Actor;
  /** Required when actor = "ai": the user who tapped Confirm on the action card (§11.3). */
  confirmedBy?: string | null;
  /** "Today" in America/New_York. Defaults to the real date; tests pin it. */
  today?: ISODate;
}

/** Convenience constructors. */
export const userCtx = (db: DbLike, userId: string | null, today?: ISODate): Ctx => ({ db, userId, actor: "user", today });
export const systemCtx = (db: DbLike, today?: ISODate): Ctx => ({ db, userId: null, actor: "system", today });
export const aiCtx = (db: DbLike, userId: string | null, confirmedBy: string, today?: ISODate): Ctx => ({ db, userId, actor: "ai", confirmedBy, today });

export function ctxToday(ctx: { today?: ISODate }): ISODate {
  return ctx.today ?? localToday();
}

/** CLAUDE.md "Never: AI writes without user confirmation". */
export function assertWriteAllowed(ctx: Ctx): void {
  if (ctx.actor === "ai" && !ctx.confirmedBy) throw new ValidationError("AI writes require a confirming user (confirmedBy)");
}

/** Run `fn` in a transaction (a savepoint when `ctx.db` is already a transaction). */
export async function withTx<T>(ctx: Ctx, fn: (tx: Tx, ctx: Ctx) => Promise<T>): Promise<T> {
  assertWriteAllowed(ctx);
  return (ctx.db as Db).transaction(async (tx) => fn(tx, { ...ctx, db: tx }));
}

/** Serializes every write that changes budget state, so stale-check + recompute never interleave. */
export async function lockBudget(tx: DbLike): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('homebase.budget'))`);
}

/**
 * Run queries one after another. A transaction is a single connection, so `Promise.all` over it would
 * pipeline queries on one client (deprecated in pg); services may be handed either a pool or a tx.
 */
export async function inOrder<T extends readonly unknown[]>(thunks: { [K in keyof T]: () => PromiseLike<T[K]> }): Promise<T> {
  const out: unknown[] = [];
  for (const f of thunks as readonly (() => PromiseLike<unknown>)[]) out.push(await f());
  return out as unknown as T;
}
