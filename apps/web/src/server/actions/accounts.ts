"use server";
/** Accounts: "Sync now" and the new-accounts inbox (admin). */
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, connections, transactions, type Db } from "@homebase/db";
import { NotFoundError, ValidationError, householdEntityId, putAccountOnBudget, updateAccount, writeAudit } from "@homebase/core";
import { ACCOUNT_KINDS } from "@homebase/shared";
import { createBoss, enqueueManualSync } from "@homebase/worker";
import { run, type ActionResult } from "../ctx";
import { loadSyncStatus } from "../queries/sync";
import { log } from "../log";

const Id = z.string().uuid();

/** Enqueue `sync.manual {provider: simplefin}` via a short-lived pg-boss client (the worker runs it). */
export async function syncNowAction(): Promise<ActionResult<{ jobId: string | null }>> {
  return run("sync_now", async (_ctx, cu) => {
    const status = await loadSyncStatus();
    if (!status.available || status.reason) throw new ValidationError(status.reason ?? "Sync isn't available.");
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const boss = createBoss(url, process.env.PGBOSS_SCHEMA ?? "pgboss");
    boss.on("error", (e) => log.warn({ err: e.message }, "pg-boss (sync now)"));
    try {
      let jobId: string | null;
      try {
        await boss.start();
        jobId = await enqueueManualSync(boss, "simplefin", cu.user.id);
      } catch (e) {
        log.warn({ err: e instanceof Error ? e.message : String(e) }, "sync now: enqueue failed");
        throw new ValidationError("Couldn't queue the sync. Is the worker running?");
      }
      // pg-boss returns null when the queue doesn't exist yet (worker never started) or the
      // per-provider singleton already has a queued job.
      if (!jobId) throw new ValidationError("A sync is already queued, or the worker isn't running yet.");
      revalidatePath("/activity", "layout");
      return { jobId };
    } finally {
      await boss.stop({ graceful: false, wait: false }).catch(() => undefined);
    }
  });
}

async function removeFromInbox(db: Parameters<typeof writeAudit>[0], connectionId: string, externalId: string) {
  await db
    .update(connections)
    .set({
      meta: sql`jsonb_set(coalesce(${connections.meta}, '{}'::jsonb), '{inbox}', coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(coalesce(${connections.meta}->'inbox', '[]'::jsonb)) e WHERE e->>'externalId' <> ${externalId}), '[]'::jsonb))`,
      updatedAt: new Date(),
    })
    .where(eq(connections.id, connectionId));
}

const Setup = z.object({
  connectionId: Id,
  accountId: Id,
  externalId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(ACCOUNT_KINDS),
  onBudget: z.boolean(),
  entityId: Id,
  balanceSign: z.enum(["normal", "inverted"]),
});

/** Keep the sync-created account: set its name, kind, budget, entity and sign, and clear the inbox entry. */
export async function setupInboxAccountAction(input: z.input<typeof Setup>): Promise<ActionResult> {
  const i = Setup.parse(input);
  return run(
    "inbox_setup",
    async (ctx) => {
      await (ctx.db as Db).transaction(async (tx) => {
        const [before] = await tx.select().from(accounts).where(eq(accounts.id, i.accountId));
        if (!before) throw new NotFoundError("account", i.accountId);
        if (before.kind !== i.kind) {
          // core's updateAccount doesn't change kind; do it here (audited) before switching on budget.
          await tx.update(accounts).set({ kind: i.kind, updatedAt: new Date() }).where(eq(accounts.id, i.accountId));
          await writeAudit(tx, ctx, { action: "account.set_kind", entity: "account", entityId: i.accountId, before: { kind: before.kind }, after: { kind: i.kind } });
        }
      });
      const household = await householdEntityId(ctx.db);
      if (i.onBudget && i.entityId === household) {
        // The common case: a household account onto the budget. core does the budget switch (and the
        // card payment category) and clears the inbox entry in one audited step.
        await updateAccount(ctx, i.accountId, { name: i.name, balanceSign: i.balanceSign });
        await putAccountOnBudget(ctx, i.accountId);
      } else {
        await updateAccount(ctx, i.accountId, { name: i.name, onBudget: i.onBudget, entityId: i.entityId, balanceSign: i.balanceSign });
      }
      await removeFromInbox(ctx.db, i.connectionId, i.externalId);
      revalidatePath("/activity", "layout");
      revalidatePath("/wealth", "layout");
      revalidatePath("/plan");
      return {};
    },
    { admin: true },
  );
}

const Link = z.object({ connectionId: Id, accountId: Id, externalId: z.string().min(1).max(200), targetAccountId: Id });

/**
 * Link the external account to an existing account (e.g. YNAB-imported). The sync-created duplicate and
 * its rows are soft-deleted; `accountMap[externalId] = {accountId}` makes the next sync attach the
 * existing account, re-fetch the recent window into it and match YNAB rows (§8.4).
 */
export async function linkInboxAccountAction(input: z.input<typeof Link>): Promise<ActionResult> {
  const i = Link.parse(input);
  if (i.accountId === i.targetAccountId) return { ok: false, error: "Pick a different account." };
  return run(
    "inbox_link",
    async (ctx) => {
      await (ctx.db as Db).transaction(async (tx) => {
        const now = new Date();
        await tx.execute(sql`UPDATE connections SET updated_at = now(), meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('accountMap', coalesce(meta->'accountMap', '{}'::jsonb) || jsonb_build_object(${i.externalId}::text, jsonb_build_object('accountId', ${i.targetAccountId}::text))) WHERE id = ${i.connectionId}`);
        await tx.update(transactions).set({ deletedAt: now, updatedAt: now }).where(and(eq(transactions.accountId, i.accountId), sql`${transactions.deletedAt} IS NULL`));
        await tx.update(accounts).set({ deletedAt: now, connectionId: null, externalId: null, updatedAt: now }).where(eq(accounts.id, i.accountId));
        await removeFromInbox(tx, i.connectionId, i.externalId);
        await writeAudit(tx, ctx, { action: "account.link_external", entity: "account", entityId: i.targetAccountId, after: { connectionId: i.connectionId, externalId: i.externalId, replacedAccountId: i.accountId } });
      });
      revalidatePath("/activity", "layout");
      revalidatePath("/wealth", "layout");
      return {};
    },
    { admin: true },
  );
}
