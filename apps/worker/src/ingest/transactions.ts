/**
 * §8.2 step 3 + §8.4: per-account transaction upsert with pending→posted replacement,
 * scheduled→synced and YNAB-imported→synced matching. User edits (category, memo, payee, splits,
 * flag, approval) always survive: matched rows are updated in place, keeping their id.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { transactions, transactionSplits, type Account, type Tx } from "@homebase/db";
import { importHash, type ExternalTxn } from "@homebase/connectors";
import { addDays, type AccountSource, type ISODate, type Milli } from "@homebase/shared";
import { matchPendingToPosted, matchScheduled, matchYnab, type Candidate } from "./matching";

export interface TxnIngestCounts {
  added: number;
  updated: number;
  unchanged: number;
  pendingReplaced: number;
  scheduledMatched: number;
  ynabMatched: number;
  pendingRemoved: number;
  skippedDeleted: number;
}

export interface TxnIngestResult extends TxnIngestCounts {
  /** Rows inserted or whose bank data changed (for categorize.pending / transfer detection). */
  touchedIds: string[];
  /** Earliest date whose budget may have changed. */
  earliest: ISODate | null;
}

export const emptyCounts = (): TxnIngestCounts => ({ added: 0, updated: 0, unchanged: 0, pendingReplaced: 0, scheduledMatched: 0, ynabMatched: 0, pendingRemoved: 0, skippedDeleted: 0 });

type Row = typeof transactions.$inferSelect;

const minDate = (a: ISODate | null, b: ISODate | null): ISODate | null => (a === null ? b : b === null ? a : a < b ? a : b);

/** Cleared state for a synced row: pending stays pending; posted bank rows are cleared (YNAB convention). */
function clearedFor(ext: ExternalTxn, current?: Row["cleared"]): Row["cleared"] {
  if (ext.pending) return "pending";
  if (current === "reconciled" || current === "cleared") return current;
  return "cleared";
}

/**
 * Keep split lines summing to the parent when the bank amount moves (tips, holds): the delta goes on
 * the largest line. The deferred trigger checks Σ lines = parent at commit.
 */
async function rebalanceSplits(tx: Tx, txnId: string, newAmount: Milli): Promise<void> {
  const lines = await tx.select().from(transactionSplits).where(eq(transactionSplits.transactionId, txnId)).orderBy(asc(transactionSplits.sort));
  if (!lines.length) return;
  const sum = lines.reduce((s, l) => s + l.amountMilli, 0n);
  const delta = newAmount - sum;
  if (delta === 0n) return;
  const abs = (x: Milli) => (x < 0n ? -x : x);
  const biggest = lines.reduce((m, l) => (abs(l.amountMilli) > abs(m.amountMilli) ? l : m), lines[0]!);
  await tx.update(transactionSplits).set({ amountMilli: biggest.amountMilli + delta, updatedAt: new Date() }).where(eq(transactionSplits.id, biggest.id));
}

export interface IngestAccountTxnsOptions {
  source: AccountSource;
  now: Date;
  /** Range fully covered by this fetch; pending rows in it that vanished are removed. Omit to skip cleanup. */
  window?: { since: ISODate; until: ISODate } | undefined;
}

export async function ingestAccountTransactions(tx: Tx, account: Pick<Account, "id">, incoming: ExternalTxn[], o: IngestAccountTxnsOptions): Promise<TxnIngestResult> {
  const res: TxnIngestResult = { ...emptyCounts(), touchedIds: [], earliest: null };
  if (!incoming.length && !o.window) return res;
  const touch = (id: string, ...dates: ISODate[]) => {
    if (!res.touchedIds.includes(id)) res.touchedIds.push(id);
    for (const d of dates) res.earliest = minDate(res.earliest, d);
  };

  // Deduplicate within the batch (a provider can repeat a row across windows).
  const byExt = new Map<string, ExternalTxn>();
  for (const t of incoming) byExt.set(t.externalId, t);
  const batch = [...byExt.values()].sort((a, b) => Number(a.pending) - Number(b.pending) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.externalId < b.externalId ? -1 : 1));
  const extIds = batch.map((t) => t.externalId);
  const stillPendingIds = new Set(batch.filter((t) => t.pending).map((t) => t.externalId));

  // Existing rows by external id, including soft-deleted ones (the unique key covers them).
  const existing = new Map<string, Row>();
  for (let i = 0; i < extIds.length; i += 500) {
    const chunk = extIds.slice(i, i + 500);
    for (const r of await tx.select().from(transactions).where(and(eq(transactions.accountId, account.id), inArray(transactions.externalId, chunk)))) existing.set(r.externalId!, r);
  }

  // Match candidates within the batch's date span (± tolerances).
  const dates = batch.map((t) => t.date);
  const lo = addDays([...dates, o.window?.since ?? "9999-12-31"].reduce((a, b) => (a < b ? a : b)), -10);
  const hi = addDays([...dates, o.window?.until ?? "0000-01-01"].reduce((a, b) => (a > b ? a : b)), 10);
  const nearby = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.accountId, account.id), isNull(transactions.deletedAt), gte(transactions.date, lo), lte(transactions.date, hi)));
  const cand = (r: Row): Candidate & { row: Row } => ({ id: r.id, date: r.date, amount: r.amountMilli, texts: [r.rawDescription, r.memo], transfer: r.transferAccountId !== null, row: r });
  const pendingPool = nearby.filter((r) => r.cleared === "pending" && !(r.externalId && stillPendingIds.has(r.externalId))).map(cand);
  const scheduledPool = nearby.filter((r) => r.source === "scheduled" && r.externalId === null).map(cand);
  const ynabPool = nearby.filter((r) => r.ynabId !== null && r.externalId === null && r.source === "ynab_import").map(cand);
  const consumed = new Set<string>();
  const avail = <C extends { id: string }>(pool: C[]) => pool.filter((c) => !consumed.has(c.id));

  for (const ext of batch) {
    const hash = importHash(account.id, ext.date, ext.amount, ext.description);
    const postedAt = ext.postedAt ? new Date(ext.postedAt) : null;
    const prev = existing.get(ext.externalId);

    // 1. Known external id: refresh bank-owned fields only.
    if (prev) {
      if (prev.deletedAt) {
        res.skippedDeleted++;
        continue;
      }
      if (prev.cleared === "reconciled") {
        res.unchanged++;
        continue;
      }
      const cleared = clearedFor(ext, prev.cleared);
      const changed =
        prev.date !== ext.date ||
        prev.amountMilli !== ext.amount ||
        prev.cleared !== cleared ||
        (prev.rawDescription ?? "") !== ext.description ||
        (prev.postedAt?.getTime() ?? null) !== (postedAt?.getTime() ?? null);
      if (!changed) {
        res.unchanged++;
        continue;
      }
      const amountChanged = prev.amountMilli !== ext.amount;
      await tx
        .update(transactions)
        .set({ date: ext.date, amountMilli: ext.amount, cleared, rawDescription: ext.description, postedAt, importHash: hash, ...(amountChanged ? { approved: false } : {}), updatedAt: o.now })
        .where(eq(transactions.id, prev.id));
      if (amountChanged && prev.isSplit) await rebalanceSplits(tx, prev.id, ext.amount);
      res.updated++;
      touch(prev.id, prev.date, ext.date);
      continue;
    }

    const incomingForMatch = { date: ext.date, amount: ext.amount, texts: [ext.description, ext.payee, ext.memo] };

    if (!ext.pending) {
      const pend = matchPendingToPosted(incomingForMatch, avail(pendingPool));
      const ynab = matchYnab(incomingForMatch, avail(ynabPool));

      // 2. Parallel run / backfill overlap: the YNAB-imported row is the same real transaction.
      if (ynab) {
        consumed.add(ynab.id);
        await tx
          .update(transactions)
          .set({ externalId: ext.externalId, importHash: hash, postedAt, rawDescription: ext.description, matchedYnabId: ynab.row.ynabId, source: o.source, updatedAt: o.now })
          .where(eq(transactions.id, ynab.id));
        res.ynabMatched++;
        res.updated++;
        touch(ynab.id, ynab.row.date);
        if (pend) {
          // The pending copy of this transaction is now redundant (YNAB's categorization wins, §10).
          consumed.add(pend.id);
          await tx.update(transactions).set({ deletedAt: o.now, updatedAt: o.now }).where(eq(transactions.id, pend.id));
          res.pendingRemoved++;
        }
        continue;
      }

      // 3. Pending → posted: replace in place, keeping the user's edits.
      if (pend) {
        consumed.add(pend.id);
        const amountChanged = pend.row.amountMilli !== ext.amount;
        await tx
          .update(transactions)
          .set({ externalId: ext.externalId, importHash: hash, date: ext.date, amountMilli: ext.amount, postedAt, rawDescription: ext.description, cleared: "cleared", ...(amountChanged ? { approved: false } : {}), updatedAt: o.now })
          .where(eq(transactions.id, pend.id));
        if (amountChanged && pend.row.isSplit) await rebalanceSplits(tx, pend.id, ext.amount);
        res.pendingReplaced++;
        res.updated++;
        touch(pend.id, pend.row.date, ext.date);
        continue;
      }
    }

    // 4. Scheduled → synced (posted or pending: a scheduled bill often shows up pending first).
    const sched = matchScheduled(incomingForMatch, avail(scheduledPool));
    if (sched) {
      consumed.add(sched.id);
      const amountChanged = sched.row.amountMilli !== ext.amount;
      await tx
        .update(transactions)
        .set({ externalId: ext.externalId, importHash: hash, date: ext.date, amountMilli: ext.amount, postedAt, rawDescription: ext.description, cleared: clearedFor(ext), source: o.source, updatedAt: o.now })
        .where(eq(transactions.id, sched.id));
      if (amountChanged && sched.row.isSplit) await rebalanceSplits(tx, sched.id, ext.amount);
      res.scheduledMatched++;
      res.updated++;
      touch(sched.id, sched.row.date, ext.date);
      continue;
    }

    // 5. New row: unapproved, uncategorized; the categorizer fills payee/category (§8.2 step 4–5).
    const [row] = await tx
      .insert(transactions)
      .values({
        accountId: account.id,
        date: ext.date,
        postedAt,
        amountMilli: ext.amount,
        rawDescription: ext.description,
        memo: ext.memo ?? null,
        cleared: clearedFor(ext),
        approved: false,
        source: o.source,
        externalId: ext.externalId,
        importHash: hash,
      })
      .returning({ id: transactions.id });
    res.added++;
    touch(row!.id, ext.date);
  }

  // 6. Pending rows the bank no longer reports (released holds) inside a fully covered window.
  if (o.window) {
    const seen = new Set(extIds);
    const gone = await tx
      .select({ id: transactions.id, date: transactions.date, externalId: transactions.externalId })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, account.id),
          eq(transactions.cleared, "pending"),
          isNull(transactions.deletedAt),
          isNotNull(transactions.externalId),
          gte(transactions.date, o.window.since),
          lte(transactions.date, o.window.until),
        ),
      );
    for (const g of gone) {
      if (consumed.has(g.id) || (g.externalId && seen.has(g.externalId))) continue;
      await tx.update(transactions).set({ deletedAt: o.now, updatedAt: o.now }).where(eq(transactions.id, g.id));
      res.pendingRemoved++;
    }
  }
  return res;
}
