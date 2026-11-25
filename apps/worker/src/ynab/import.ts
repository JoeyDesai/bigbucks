/**
 * §10 YNAB → Homebase import (Phase 1 full import and parallel-run deltas).
 *
 * One function handles both: every entity is upserted by `ynab_id`, so a full re-run is idempotent and
 * a `last_knowledge_of_server` delta (same plan shape, only changed rows, `deleted: true` tombstones)
 * applies cleanly. `replace` first wipes YNAB-sourced *facts* (transactions with source ynab_import,
 * YNAB scheduled transactions, assignments and targets of YNAB categories); identity rows (accounts,
 * groups, categories, payees) are always upserted because synced data may reference them.
 *
 * Rules:
 *  - Kinds/hidden mirror the engine's own mapper (`ynabPlanToSnapshot`) so DB-based budgets match the
 *    golden-tested engine: cc_payment only for a non-internal category in "Credit Card Payments" whose
 *    name equals an on-budget liability account; internal categories are hidden.
 *  - Targets use the engine's `mapYnabGoal` (effective_from = goal_creation_month).
 *  - Rows already linked to a synced transaction (source ≠ ynab_import) only take YNAB-owned fields
 *    (category, memo, payee, flag, approval, splits) — §10: YNAB's categories, splits and memos win.
 *  - A new YNAB transaction that matches an unlinked synced row (§8.4: exact amount, ±3 days, fuzzy
 *    payee) is merged into it instead of inserted.
 *  - Group and category names are stored with leading/trailing emoji stripped; new categories get a
 *    lucide icon from `suggestCategoryIcon` (an icon already set is kept).
 *  - Groups/categories without a ynab_id (made by `import:ynab-snapshot` or by hand) are ADOPTED by
 *    normalized name (same group name first, else a unique name across groups) instead of duplicated.
 *    A full import also undoes the snapshot's assignments, opening carry, month note and targets first, since
 *    YNAB's real history replaces them (see ./snapshot.ts).
 */
import { and, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  accounts,
  categories,
  categoryGroups,
  monthAssignments,
  payees,
  reconciliations,
  scheduledTransactions,
  scheduledTransactionSplits,
  targets,
  transactions,
  transactionSplits,
  type Db,
  type Tx,
} from "@homebase/db";
import { normalizedKey } from "@homebase/categorizer";
import { importHash, mapYnabPlan, type YnabImportBundle, type YnabImportTransaction } from "@homebase/connectors";
import { mapYnabGoal, unwrapYnabPlan, type YnabGoalFields } from "@homebase/engine";
import { LIABILITY_KINDS, addDays, monthOf, normalizeCategoryName, stripEmoji, suggestCategoryIcon, toLocalDate, type CategoryKind, type Month } from "@homebase/shared";
import { ensureEntity, HOUSEHOLD_ENTITY } from "../ingest/accounts";
import { matchYnab } from "../ingest/matching";
import { SETTING_KEYS, getSetting, setSetting, type YnabImportSetting } from "../settings";
import { undoUiSnapshot } from "./snapshot";

export interface YnabImportOptions {
  now: Date;
  /** Wipe YNAB-sourced facts first (full import only). */
  replace?: boolean;
  /** Mark this as a delta (settings bookkeeping only). */
  delta?: boolean;
}

export interface YnabImportSummary {
  planId: string;
  planName: string;
  serverKnowledge: number | null;
  accounts: number;
  groups: number;
  categories: number;
  payees: number;
  transactions: { inserted: number; updated: number; mergedIntoSynced: number; deleted: number };
  splits: number;
  scheduled: number;
  assignments: number;
  targets: number;
  /** Groups/categories without a ynab_id that were adopted by name (snapshot import or hand-made). */
  adopted: { groups: number; categories: number };
  /** A `ynab_ui_snapshot` was undone before writing YNAB's history. */
  snapshotUndone: boolean;
  earliestMonth: Month | null;
  warnings: string[];
}

/** Display name for an imported group/category: emoji stripped (an emoji-only name is kept as is). */
export const importedName = (name: string): string => stripEmoji(name) || name.trim();

/** Icon for a category created by an importer. System categories get none (the UI draws its own). */
export function importedIcon(kind: CategoryKind, name: string): string | null {
  if (kind === "cc_payment") return "credit-card";
  if (kind !== "normal") return null;
  return suggestCategoryIcon(name);
}

const SYSTEM_GROUP_NAME = "Internal Master Category";
const CC_GROUP_NAME = "Credit Card Payments";
const STARTING_BALANCE = "Starting Balance";

/**
 * payees.normalized_key (unique): the categorizer's `normalizedKey` so keys agree with payees it
 * creates. Names with no ASCII letters/digits (emoji-only) would normalize to "" — keep those distinct.
 */
export function payeeKey(name: string): string {
  return normalizedKey(name) || `~${name.normalize("NFKC").trim().toLowerCase()}`;
}

type IdMap = Map<string, string>;

async function idMap(tx: Tx, table: typeof accounts | typeof categoryGroups | typeof categories | typeof payees): Promise<IdMap> {
  const rows = await tx.select({ id: table.id, ynabId: table.ynabId }).from(table).where(isNotNull(table.ynabId));
  return new Map(rows.map((r) => [r.ynabId!, r.id]));
}

const chunk = <T>(xs: T[], n = 500): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export async function importYnabPlan(db: Db, raw: unknown, o: YnabImportOptions): Promise<YnabImportSummary> {
  const bundle = mapYnabPlan(raw);
  const rawPlan = unwrapYnabPlan(raw).plan;
  return db.transaction((tx) => importBundle(tx, bundle, rawPlan, o));
}

export async function importBundle(tx: Tx, b: YnabImportBundle, rawPlan: Record<string, unknown>, o: YnabImportOptions): Promise<YnabImportSummary> {
  const now = o.now;
  const sum: YnabImportSummary = {
    planId: b.plan.ynabId,
    planName: b.plan.name,
    serverKnowledge: b.serverKnowledge,
    accounts: 0,
    groups: 0,
    categories: 0,
    payees: 0,
    transactions: { inserted: 0, updated: 0, mergedIntoSynced: 0, deleted: 0 },
    splits: 0,
    scheduled: 0,
    assignments: 0,
    targets: 0,
    adopted: { groups: 0, categories: 0 },
    snapshotUndone: false,
    earliestMonth: null,
    warnings: [...b.warnings],
  };
  const touchMonth = (d: string) => {
    const m = monthOf(d);
    if (!sum.earliestMonth || m < sum.earliestMonth) sum.earliestMonth = m;
  };

  if (o.replace) await wipeYnabFacts(tx);
  // YNAB is the source of truth: drop the UI snapshot's opening carry / note / targets before its history lands.
  if (!o.delta) sum.snapshotUndone = await undoUiSnapshot(tx, { assignments: true });

  // ── accounts ────────────────────────────────────────────────────────────────────────────────
  const householdId = await ensureEntity(tx, HOUSEHOLD_ENTITY);
  const existingAccounts = new Map((await tx.select().from(accounts).where(isNotNull(accounts.ynabId))).map((a) => [a.ynabId!, a]));
  for (const [i, a] of b.accounts.entries()) {
    const prev = existingAccounts.get(a.ynabId);
    const deletedAt = a.deleted ? (prev?.deletedAt ?? now) : null;
    if (prev) {
      const own = prev.source === "ynab_import";
      await tx
        .update(accounts)
        .set({ onBudget: a.onBudget, closed: a.closed, deletedAt, ...(own ? { name: a.name, kind: a.kind, note: a.note ?? null } : {}), updatedAt: now })
        .where(eq(accounts.id, prev.id));
    } else {
      await tx.insert(accounts).values({ entityId: householdId, name: a.name, kind: a.kind, onBudget: a.onBudget, closed: a.closed, source: "ynab_import", ynabId: a.ynabId, note: a.note ?? null, sort: i, deletedAt });
    }
    sum.accounts++;
  }
  const acctIds = await idMap(tx, accounts);
  const acctRows = await tx.select({ id: accounts.id, name: accounts.name, kind: accounts.kind, onBudget: accounts.onBudget, deletedAt: accounts.deletedAt }).from(accounts);

  // ── groups ──────────────────────────────────────────────────────────────────────────────────
  const existingGroups = new Map((await tx.select().from(categoryGroups).where(isNotNull(categoryGroups.ynabId))).map((g) => [g.ynabId!, g]));
  // Groups without a ynab id (snapshot import, setup:household's system groups) are adopted by name.
  const adoptableGroups = await tx.select().from(categoryGroups).where(and(isNull(categoryGroups.ynabId), isNull(categoryGroups.deletedAt)));
  for (const [i, g] of b.groups.entries()) {
    // YNAB's raw `internal` flag also marks ordinary groups (e.g. a user's "Savings"), so system groups are
    // recognized by name only: Internal Master Category, Credit Card Payments and Hidden Categories.
    const isSystem = g.isInternal || g.isCreditCardPayments || /^hidden categories$/i.test(g.name.trim());
    const values = { name: importedName(g.name), sort: i, hidden: g.hidden, isSystem, deletedAt: g.deleted ? (existingGroups.get(g.ynabId)?.deletedAt ?? now) : null };
    const prev = existingGroups.get(g.ynabId);
    if (prev) await tx.update(categoryGroups).set({ ...values, updatedAt: now }).where(eq(categoryGroups.id, prev.id));
    else {
      const key = normalizeCategoryName(g.name);
      const k = g.deleted ? -1 : adoptableGroups.findIndex((x) => x.isSystem === isSystem && normalizeCategoryName(x.name) === key);
      if (k >= 0) {
        const [adopt] = adoptableGroups.splice(k, 1);
        await tx.update(categoryGroups).set({ ...values, ynabId: g.ynabId, updatedAt: now }).where(eq(categoryGroups.id, adopt!.id));
        sum.adopted.groups++;
      } else await tx.insert(categoryGroups).values({ ...values, ynabId: g.ynabId });
    }
    sum.groups++;
  }
  const groupIds = await idMap(tx, categoryGroups);
  const groupInternal = new Map<string, boolean>();
  const groupIsCc = new Map<string, boolean>();
  for (const g of b.groups) {
    groupInternal.set(g.ynabId, g.isInternal);
    groupIsCc.set(g.ynabId, g.isCreditCardPayments);
  }

  // ── categories ──────────────────────────────────────────────────────────────────────────────
  const rawCats = new Map(((rawPlan.categories as Record<string, unknown>[] | undefined) ?? []).map((c) => [String(c.id), c]));
  const existingCats = new Map((await tx.select().from(categories).where(isNotNull(categories.ynabId))).map((c) => [c.ynabId!, c]));
  // Normal categories without a ynab id (snapshot import / hand-made) are adopted by normalized name.
  const groupNameById = new Map((await tx.select({ id: categoryGroups.id, name: categoryGroups.name }).from(categoryGroups)).map((g) => [g.id, normalizeCategoryName(g.name)]));
  const ynabGroupName = new Map(b.groups.map((g) => [g.ynabId, normalizeCategoryName(g.name)]));
  const adoptableCats = (await tx.select().from(categories).where(and(isNull(categories.ynabId), isNull(categories.deletedAt), eq(categories.kind, "normal")))).map((c) => ({
    ...c,
    key: normalizeCategoryName(c.name),
    groupKey: groupNameById.get(c.groupId) ?? "",
  }));
  const takeAdoptable = (name: string, groupYnabId: string) => {
    const key = normalizeCategoryName(name);
    if (!key) return undefined;
    const gk = ynabGroupName.get(groupYnabId);
    let k = adoptableCats.findIndex((x) => x.key === key && x.groupKey === gk);
    if (k < 0) {
      const same = adoptableCats.filter((x) => x.key === key);
      if (same.length === 1) k = adoptableCats.indexOf(same[0]!);
    }
    return k >= 0 ? adoptableCats.splice(k, 1)[0] : undefined;
  };
  const cardByName = new Map<string, string>();
  for (const a of acctRows) if (a.onBudget && LIABILITY_KINDS.includes(a.kind) && (!cardByName.has(a.name) || a.deletedAt === null)) cardByName.set(a.name, a.id);

  for (const [i, c] of b.categories.entries()) {
    const rc = rawCats.get(c.ynabId);
    let groupId = groupIds.get(c.groupYnabId);
    if (!groupId) {
      // Delta for a category whose group isn't in DB: park it in a system group.
      groupId = await ensureSystemGroup(tx, SYSTEM_GROUP_NAME);
      sum.warnings.push(`category ${c.name}: unknown group ${c.groupYnabId}`);
    }
    const internal = rc?.internal === true || groupInternal.get(c.groupYnabId) === true;
    const prev = existingCats.get(c.ynabId);
    let kind: CategoryKind = "normal";
    let linkedAccountId: string | null = null;
    if (c.kind === "internal_rta" || c.kind === "uncategorized") kind = c.kind;
    else if (groupIsCc.get(c.groupYnabId) && rc?.internal !== true) {
      linkedAccountId = cardByName.get(c.name) ?? cardByName.get(importedName(c.name)) ?? null;
      if (linkedAccountId) kind = "cc_payment";
      else sum.warnings.push(`credit card payment category "${c.name}" matches no on-budget card; imported as a normal category`);
    }
    if (prev && prev.kind !== "normal" && kind === "normal") {
      kind = prev.kind;
      linkedAccountId = prev.linkedAccountId;
    }
    const name = importedName(c.name);
    const values = { groupId, name, sort: i, hidden: c.hidden || internal, note: c.note ?? null, kind, linkedAccountId, deletedAt: c.deleted ? (prev?.deletedAt ?? now) : null };
    if (prev) {
      await tx.update(categories).set({ ...values, icon: prev.icon ?? importedIcon(kind, name), updatedAt: now }).where(eq(categories.id, prev.id));
    } else {
      // Adopt an existing singleton system category / card payment category instead of violating its unique index.
      const adopt =
        kind === "internal_rta" || kind === "uncategorized"
          ? (await tx.select({ id: categories.id, icon: categories.icon }).from(categories).where(and(eq(categories.kind, kind), isNull(categories.ynabId))))[0]
          : kind === "cc_payment" && linkedAccountId
            ? (await tx.select({ id: categories.id, icon: categories.icon }).from(categories).where(and(eq(categories.kind, "cc_payment"), eq(categories.linkedAccountId, linkedAccountId))))[0]
            : kind === "normal" && !c.deleted
              ? takeAdoptable(c.name, c.groupYnabId)
              : undefined;
      if (adopt) {
        // A snapshot-adopted category keeps its note when YNAB has none.
        const note = values.note ?? (kind === "normal" && "note" in adopt ? (adopt.note as string | null) : null);
        await tx.update(categories).set({ ...values, note, icon: adopt.icon ?? importedIcon(kind, name), ynabId: c.ynabId, updatedAt: now }).where(eq(categories.id, adopt.id));
        if (kind === "normal") sum.adopted.categories++;
      } else await tx.insert(categories).values({ ...values, icon: importedIcon(kind, name), ynabId: c.ynabId });
    }
    sum.categories++;
  }
  await ensureSystemCategories(tx);
  const catIds = await idMap(tx, categories);
  const internalCatIds = new Set((await tx.select({ id: categories.id }).from(categories).where(eq(categories.kind, "internal_rta"))).map((r) => r.id));

  // ── targets (engine mapping, §6.5) ─────────────────────────────────────────────────────────
  const fallbackMonth = b.plan.firstMonth ? monthOf(b.plan.firstMonth) : monthOf(toLocalDate(now));
  for (const c of b.categories) {
    const id = catIds.get(c.ynabId);
    const rc = rawCats.get(c.ynabId);
    if (!id || !rc || c.deleted) continue;
    const t = mapYnabGoal(rc as unknown as YnabGoalFields, fallbackMonth);
    if (!t) {
      // Target removed in YNAB: tombstone from this month on, if a live target exists.
      const live = await tx.select({ removed: targets.removed, from: targets.effectiveFrom }).from(targets).where(eq(targets.categoryId, id)).orderBy(sql`${targets.effectiveFrom} desc`).limit(1);
      if (live[0] && !live[0].removed && o.delta) {
        const m = monthOf(toLocalDate(now));
        await tx.insert(targets).values({ categoryId: id, effectiveFrom: m, type: "need_refill", createdMonth: m, removed: true }).onConflictDoUpdate({ target: [targets.categoryId, targets.effectiveFrom], set: { removed: true, updatedAt: now } });
      }
      continue;
    }
    const values = {
      type: t.type,
      amountMilli: t.amount,
      cadence: t.cadence,
      cadenceEvery: t.cadenceEvery,
      day: t.day,
      targetDate: t.targetDate,
      percent: t.percent === null ? null : String(t.percent),
      snoozedMonth: t.snoozedMonth,
      createdMonth: t.createdMonth,
      removed: false,
    };
    await tx
      .insert(targets)
      .values({ categoryId: id, effectiveFrom: t.effectiveFrom, ...values })
      .onConflictDoUpdate({ target: [targets.categoryId, targets.effectiveFrom], set: { ...values, updatedAt: now } });
    sum.targets++;
  }

  // ── payees ──────────────────────────────────────────────────────────────────────────────────
  const existingPayees = await tx.select({ id: payees.id, ynabId: payees.ynabId, key: payees.normalizedKey }).from(payees);
  const payeeByYnab = new Map(existingPayees.filter((p) => p.ynabId).map((p) => [p.ynabId!, p.id]));
  const payeeByKey = new Map(existingPayees.map((p) => [p.key, p.id]));
  const payeeAlias = new Map<string, string>(); // merged duplicates: ynab id → payee id
  for (const p of b.payees) {
    const key = payeeKey(p.name);
    const transferAccountId = p.transferAccountYnabId ? (acctIds.get(p.transferAccountYnabId) ?? null) : null;
    const deletedAt = p.deleted ? now : null;
    const prev = payeeByYnab.get(p.ynabId);
    if (prev) {
      const clash = payeeByKey.get(key);
      await tx.update(payees).set({ name: p.name, transferAccountId, deletedAt, ...(clash && clash !== prev ? {} : { normalizedKey: key }), updatedAt: now }).where(eq(payees.id, prev));
    } else if (payeeByKey.has(key)) {
      // Same normalized name as another payee: merge (payees.normalized_key is unique).
      const target = payeeByKey.get(key)!;
      payeeAlias.set(p.ynabId, target);
      const owner = await tx.select({ ynabId: payees.ynabId }).from(payees).where(eq(payees.id, target));
      if (!owner[0]?.ynabId) await tx.update(payees).set({ ynabId: p.ynabId, updatedAt: now }).where(eq(payees.id, target));
    } else {
      const [row] = await tx.insert(payees).values({ name: p.name, normalizedKey: key, transferAccountId, ynabId: p.ynabId, deletedAt }).returning({ id: payees.id });
      payeeByKey.set(key, row!.id);
      payeeByYnab.set(p.ynabId, row!.id);
    }
    sum.payees++;
  }
  const payeeIds = await idMap(tx, payees);
  for (const [y, id] of payeeAlias) payeeIds.set(y, id);
  // Names for payees not in this (delta) export come from the DB.
  const payeeNames = new Map((await tx.select({ y: payees.ynabId, name: payees.name }).from(payees).where(isNotNull(payees.ynabId))).map((r) => [r.y!, r.name]));
  for (const p of b.payees) payeeNames.set(p.ynabId, p.name);

  // ── transactions ────────────────────────────────────────────────────────────────────────────
  const txYnabIds = b.transactions.map((t) => t.ynabId);
  const existingTx = new Map<string, { id: string; source: string; deletedAt: Date | null }>();
  for (const ids of chunk(txYnabIds)) {
    for (const r of await tx.select({ id: transactions.id, ynabId: transactions.ynabId, source: transactions.source, deletedAt: transactions.deletedAt }).from(transactions).where(inArray(transactions.ynabId, ids))) {
      existingTx.set(r.ynabId!, r);
    }
  }
  // Unlinked synced rows that a new YNAB transaction may be the same as (§8.4, parallel run).
  const minDate = b.transactions.reduce<string | null>((m, t) => (m === null || t.date < m ? t.date : m), null);
  const syncedByAccount = new Map<string, { id: string; date: string; amount: bigint; texts: (string | null)[] }[]>();
  if (minDate) {
    const synced = await tx
      .select({ id: transactions.id, accountId: transactions.accountId, date: transactions.date, amount: transactions.amountMilli, raw: transactions.rawDescription, memo: transactions.memo })
      .from(transactions)
      .where(and(isNull(transactions.ynabId), isNull(transactions.deletedAt), isNotNull(transactions.externalId), ne(transactions.cleared, "pending"), gte(transactions.date, addDays(minDate, -3))));
    for (const s of synced) {
      const l = syncedByAccount.get(s.accountId) ?? [];
      l.push({ id: s.id, date: s.date, amount: s.amount, texts: [s.raw, s.memo] });
      syncedByAccount.set(s.accountId, l);
    }
  }

  const cat = (y?: string) => (y ? (catIds.get(y) ?? null) : null);
  const acct = (y?: string) => (y ? (acctIds.get(y) ?? null) : null);
  const payee = (y?: string) => (y ? (payeeIds.get(y) ?? null) : null);
  const ynabOwned = (t: YnabImportTransaction) => ({
    payeeId: payee(t.payeeYnabId),
    memo: t.memo ?? null,
    categoryId: t.isSplit ? null : cat(t.categoryYnabId),
    isSplit: t.isSplit,
    approved: t.approved,
    flag: t.flag,
    catz: { method: "ynab" as const, confidence: 1, at: now.toISOString() },
  });

  const toInsert: (typeof transactions.$inferInsert)[] = [];
  const splitParents: { ynabId: string; t: YnabImportTransaction }[] = [];
  for (const [i, t] of b.transactions.entries()) {
    const accountId = acct(t.accountYnabId);
    if (!accountId) {
      sum.warnings.push(`transaction ${t.ynabId}: unknown account ${t.accountYnabId}; skipped`);
      continue;
    }
    touchMonth(t.date);
    const payeeName = t.payeeName ?? (t.payeeYnabId ? payeeNames.get(t.payeeYnabId) : undefined);
    const rawDescription = t.importPayeeName ?? payeeName ?? null;
    const bankish = {
      accountId,
      date: t.date,
      amountMilli: t.amount,
      transferAccountId: acct(t.transferAccountYnabId),
      cleared: t.cleared,
      importOrder: i,
      isStartingBalance: payeeName === STARTING_BALANCE,
      rawDescription,
      importHash: importHash(accountId, t.date, t.amount, rawDescription ?? t.memo ?? ""),
    };
    const prev = existingTx.get(t.ynabId);
    if (prev) {
      const deletedAt = t.deleted ? (prev.deletedAt ?? now) : null;
      if (prev.source === "ynab_import") {
        await tx.update(transactions).set({ ...bankish, ...ynabOwned(t), deletedAt, updatedAt: now }).where(eq(transactions.id, prev.id));
      } else {
        // Linked to a synced row: the bank owns date/amount/cleared; YNAB owns categorization.
        await tx.update(transactions).set({ ...ynabOwned(t), transferAccountId: bankish.transferAccountId, ...(t.deleted ? { deletedAt } : {}), updatedAt: now }).where(eq(transactions.id, prev.id));
      }
      if (t.deleted) sum.transactions.deleted++;
      else sum.transactions.updated++;
      splitParents.push({ ynabId: t.ynabId, t });
      continue;
    }

    if (!t.deleted) {
      const pool = syncedByAccount.get(accountId) ?? [];
      const m = matchYnab({ date: t.date, amount: t.amount, texts: [payeeName, t.importPayeeName, t.memo] }, pool);
      if (m) {
        syncedByAccount.set(accountId, pool.filter((p) => p.id !== m.id));
        await tx.update(transactions).set({ ...ynabOwned(t), transferAccountId: bankish.transferAccountId, ynabId: t.ynabId, matchedYnabId: t.ynabId, updatedAt: now }).where(eq(transactions.id, m.id));
        existingTx.set(t.ynabId, { id: m.id, source: "synced", deletedAt: null });
        sum.transactions.mergedIntoSynced++;
        splitParents.push({ ynabId: t.ynabId, t });
        continue;
      }
    }
    toInsert.push({ ...bankish, ...ynabOwned(t), source: "ynab_import", ynabId: t.ynabId, deletedAt: t.deleted ? now : null });
    if (t.deleted) sum.transactions.deleted++;
    else sum.transactions.inserted++;
    splitParents.push({ ynabId: t.ynabId, t });
  }
  for (const rows of chunk(toInsert)) await tx.insert(transactions).values(rows);

  // ynab id → transaction id (all, including rows from earlier imports for delta pair links).
  const txIds = new Map<string, string>();
  const pairYnabIds = new Set<string>();
  for (const t of b.transactions) {
    pairYnabIds.add(t.ynabId);
    if (t.transferPairYnabId) pairYnabIds.add(t.transferPairYnabId);
    for (const s of t.subtransactions) if (s.transferPairYnabId) pairYnabIds.add(s.transferPairYnabId);
  }
  for (const ids of chunk([...pairYnabIds])) {
    for (const r of await tx.select({ id: transactions.id, ynabId: transactions.ynabId }).from(transactions).where(inArray(transactions.ynabId, ids))) txIds.set(r.ynabId!, r.id);
  }

  // Transfer pairs (self-FK: both rows exist now).
  const pairs: [string, string][] = [];
  for (const t of b.transactions) {
    const id = txIds.get(t.ynabId);
    const pid = t.transferPairYnabId ? txIds.get(t.transferPairYnabId) : undefined;
    if (id && pid) pairs.push([id, pid]);
  }
  for (const part of chunk(pairs, 1000)) {
    const values = sql.join(part.map(([a, p]) => sql`(${a}::uuid, ${p}::uuid)`), sql`, `);
    await tx.execute(sql`update ${transactions} set transfer_pair_id = v.pair from (values ${values}) as v(id, pair) where ${transactions.id} = v.id`);
  }

  // Splits: YNAB owns them; replace lines of every imported/updated parent.
  const parentIds = splitParents.map((p) => txIds.get(p.ynabId)).filter((x): x is string => !!x);
  for (const ids of chunk(parentIds)) await tx.delete(transactionSplits).where(inArray(transactionSplits.transactionId, ids));
  const splitRows: (typeof transactionSplits.$inferInsert)[] = [];
  for (const { ynabId, t } of splitParents) {
    const id = txIds.get(ynabId);
    if (!id || !t.isSplit) continue;
    t.subtransactions
      .filter((s) => !s.deleted)
      .forEach((s, k) =>
        splitRows.push({
          transactionId: id,
          amountMilli: s.amount,
          categoryId: cat(s.categoryYnabId),
          payeeId: payee(s.payeeYnabId),
          memo: s.memo ?? null,
          transferAccountId: acct(s.transferAccountYnabId),
          transferPairId: s.transferPairYnabId ? (txIds.get(s.transferPairYnabId) ?? null) : null,
          sort: k,
          ynabId: s.ynabId,
        }),
      );
  }
  for (const rows of chunk(splitRows)) {
    await tx.insert(transactionSplits).values(rows).onConflictDoUpdate({ target: transactionSplits.ynabId, set: { transactionId: sql`excluded.transaction_id`, amountMilli: sql`excluded.amount_milli`, categoryId: sql`excluded.category_id`, payeeId: sql`excluded.payee_id`, memo: sql`excluded.memo`, transferAccountId: sql`excluded.transfer_account_id`, transferPairId: sql`excluded.transfer_pair_id`, sort: sql`excluded.sort`, updatedAt: now } });
  }
  sum.splits = splitRows.length;

  // ── scheduled ───────────────────────────────────────────────────────────────────────────────
  const existingSched = new Map((await tx.select({ id: scheduledTransactions.id, ynabId: scheduledTransactions.ynabId }).from(scheduledTransactions).where(isNotNull(scheduledTransactions.ynabId))).map((r) => [r.ynabId!, r.id]));
  for (const s of b.scheduled) {
    const accountId = acct(s.accountYnabId);
    if (!accountId) continue;
    const live = s.subtransactions.filter((x) => !x.deleted);
    const values = {
      accountId,
      payeeId: payee(s.payeeYnabId),
      categoryId: live.length ? null : cat(s.categoryYnabId),
      transferAccountId: acct(s.transferAccountYnabId),
      isSplit: live.length > 0,
      amountMilli: s.amount,
      frequency: s.frequency,
      firstDate: s.dateFirst,
      nextDate: s.dateNext,
      memo: s.memo ?? null,
      flag: s.flag,
      deletedAt: s.deleted ? now : null,
    };
    let id = existingSched.get(s.ynabId);
    if (id) await tx.update(scheduledTransactions).set({ ...values, updatedAt: now }).where(eq(scheduledTransactions.id, id));
    else id = (await tx.insert(scheduledTransactions).values({ ...values, ynabId: s.ynabId }).returning({ id: scheduledTransactions.id }))[0]!.id;
    await tx.delete(scheduledTransactionSplits).where(eq(scheduledTransactionSplits.scheduledTransactionId, id));
    if (live.length) {
      await tx.insert(scheduledTransactionSplits).values(
        live.map((x, k) => ({ scheduledTransactionId: id!, amountMilli: x.amount, categoryId: cat(x.categoryYnabId), payeeId: payee(x.payeeYnabId), memo: x.memo ?? null, transferAccountId: acct(x.transferAccountYnabId), sort: k, ynabId: x.ynabId })),
      );
    }
    sum.scheduled++;
  }

  // ── month assignments (every month's `budgeted`) ────────────────────────────────────────────
  const assignRows: (typeof monthAssignments.$inferInsert)[] = [];
  for (const a of b.monthAssignments) {
    const id = catIds.get(a.categoryYnabId);
    if (!id || internalCatIds.has(id)) continue;
    assignRows.push({ month: a.month, categoryId: id, assignedMilli: a.budgeted });
    touchMonth(a.month);
  }
  for (const rows of chunk(assignRows, 1000)) {
    await tx.insert(monthAssignments).values(rows).onConflictDoUpdate({ target: [monthAssignments.month, monthAssignments.categoryId], set: { assignedMilli: sql`excluded.assigned_milli`, updatedAt: now } });
  }
  sum.assignments = assignRows.length;

  // ── bookkeeping ─────────────────────────────────────────────────────────────────────────────
  const prevSetting = await getSetting<YnabImportSetting>(tx, SETTING_KEYS.ynabImport);
  const setting: YnabImportSetting = {
    plan_id: b.plan.ynabId,
    plan_name: b.plan.name || prevSetting?.plan_name || "",
    server_knowledge: b.serverKnowledge ?? prevSetting?.server_knowledge ?? null,
    imported_at: o.delta && prevSetting ? prevSetting.imported_at : now.toISOString(),
    ...(o.delta ? { last_delta_at: now.toISOString() } : prevSetting?.last_delta_at ? { last_delta_at: prevSetting.last_delta_at } : {}),
  };
  await setSetting(tx, SETTING_KEYS.ynabImport, setting);
  return sum;
}

export async function ensureSystemGroup(tx: Tx, name: string): Promise<string> {
  const found = await tx.select({ id: categoryGroups.id }).from(categoryGroups).where(and(eq(categoryGroups.name, name), eq(categoryGroups.isSystem, true)));
  if (found[0]) return found[0].id;
  return (await tx.insert(categoryGroups).values({ name, isSystem: true, hidden: name === SYSTEM_GROUP_NAME, sort: name === SYSTEM_GROUP_NAME ? -1 : 0 }).returning({ id: categoryGroups.id }))[0]!.id;
}

/** §5.1: exactly one internal_rta and one uncategorized; a cc_payment category per on-budget card. */
export async function ensureSystemCategories(tx: Tx): Promise<void> {
  for (const [kind, name] of [
    ["internal_rta", "Inflow: Ready to Assign"],
    ["uncategorized", "Uncategorized"],
  ] as const) {
    const found = await tx.select({ id: categories.id }).from(categories).where(eq(categories.kind, kind));
    if (!found[0]) await tx.insert(categories).values({ groupId: await ensureSystemGroup(tx, SYSTEM_GROUP_NAME), name, kind, hidden: true });
  }
  const cards = await tx
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.onBudget, true), inArray(accounts.kind, ["credit_card", "line_of_credit"]), isNull(accounts.deletedAt), eq(accounts.closed, false)));
  for (const c of cards) {
    const has = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.kind, "cc_payment"), eq(categories.linkedAccountId, c.id)));
    if (!has[0]) await tx.insert(categories).values({ groupId: await ensureSystemGroup(tx, CC_GROUP_NAME), name: c.name, kind: "cc_payment", linkedAccountId: c.id, icon: "credit-card" });
  }
}

/** --replace: remove YNAB-sourced facts only. Synced rows, user-made categories etc. are untouched. */
async function wipeYnabFacts(tx: Tx): Promise<void> {
  const ynabTx = tx.select({ id: transactions.id }).from(transactions).where(eq(transactions.source, "ynab_import"));
  await tx.update(reconciliations).set({ adjustmentTxId: null }).where(inArray(reconciliations.adjustmentTxId, ynabTx));
  await tx.update(transactions).set({ transferPairId: null }).where(inArray(transactions.transferPairId, ynabTx));
  await tx.delete(transactions).where(eq(transactions.source, "ynab_import"));
  await tx.delete(scheduledTransactions).where(isNotNull(scheduledTransactions.ynabId));
  const ynabCats = tx.select({ id: categories.id }).from(categories).where(isNotNull(categories.ynabId));
  await tx.delete(monthAssignments).where(inArray(monthAssignments.categoryId, ynabCats));
  await tx.delete(targets).where(inArray(targets.categoryId, ynabCats));
}
