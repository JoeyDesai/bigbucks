/**
 * snapshot.networth (§8.1, daily 23:55): make sure every open account has a `balances` row for today.
 *
 *  - Synced accounts that already have today's balance are left alone (the provider's figure wins).
 *  - Mortgage/loan with a `loans` row and no synced balance today → amortization schedule balance
 *    (with loan_events), stored negative. With both, drift > $50 is logged (§7.7.3).
 *  - Property → latest asset valuation.
 *  - Crypto → Σ market value of the latest holdings snapshot.
 *  - Everything else without a synced balance (manual, YNAB-imported, CSV) → ledger sum of
 *    non-pending, non-deleted transactions.
 * Synced accounts that didn't report today are skipped: v_balances_daily carries the last value forward.
 */
import { and, desc, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { accounts, assetValuations, assets, balances, holdings, loanEvents, loans, transactions, type Db } from "@homebase/db";
import { balanceDrift, buildSchedule, fractionToPercent, scheduledBalanceAsOf, type LoanEvent } from "@homebase/connectors";
import type { AccountSource, ISODate, Milli } from "@homebase/shared";
import { todayOf, type WorkerContext } from "../context";

const SYNCED: ReadonlySet<AccountSource> = new Set(["simplefin", "mercury", "coinbase", "xpub", "rentcast"]);

export interface NetworthResult {
  written: number;
  skippedSynced: number;
  drift: Array<{ accountId: string; driftMilli: string }>;
}

async function upsert(db: Db, accountId: string, asOf: ISODate, current: Milli, source: AccountSource): Promise<void> {
  await db
    .insert(balances)
    .values({ accountId, asOf, currentMilli: current, source })
    .onConflictDoUpdate({ target: [balances.accountId, balances.asOf], set: { currentMilli: current, source, updatedAt: new Date() } });
}

export async function loanBalance(db: Db, accountId: string, asOf: ISODate): Promise<Milli | null> {
  const [loan] = await db.select().from(loans).where(eq(loans.accountId, accountId));
  if (!loan) return null;
  const evRows = await db.select().from(loanEvents).where(and(eq(loanEvents.accountId, accountId), lte(loanEvents.date, asOf)));
  const events: LoanEvent[] = [];
  for (const e of evRows) {
    if (e.kind === "extra_principal" && e.amountMilli !== null) events.push({ type: "extra_principal", date: e.date, amount: e.amountMilli < 0n ? -e.amountMilli : e.amountMilli });
    else if (e.kind === "recast") events.push({ type: "recast", date: e.date, ...(e.newPaymentMilli !== null ? { newPayment: e.newPaymentMilli } : {}) });
    else if (e.kind === "rate_change" && e.newRate !== null) events.push({ type: "rate_change", date: e.date, annualRate: fractionToPercent(e.newRate), ...(e.newPaymentMilli !== null ? { newPayment: e.newPaymentMilli } : {}) });
    else if (e.kind === "statement_balance" && e.amountMilli !== null) events.push({ type: "balance_correction", date: e.date, balance: e.amountMilli < 0n ? -e.amountMilli : e.amountMilli });
  }
  const terms = { principal: loan.originalPrincipalMilli, annualRate: fractionToPercent(loan.annualRate), termMonths: loan.termMonths, firstPaymentDate: loan.firstPaymentDate };
  const schedule = buildSchedule(terms, events);
  return -scheduledBalanceAsOf(terms, schedule, asOf);
}

export async function snapshotNetworth(ctx: Pick<WorkerContext, "db" | "now" | "log">): Promise<NetworthResult> {
  const db = ctx.db;
  const asOf = todayOf(ctx);
  const out: NetworthResult = { written: 0, skippedSynced: 0, drift: [] };
  const accts = await db.select().from(accounts).where(and(isNull(accounts.deletedAt), eq(accounts.closed, false)));
  const todayRows = await db.select({ accountId: balances.accountId, current: balances.currentMilli, source: balances.source }).from(balances).where(eq(balances.asOf, asOf));
  const hasToday = new Map(todayRows.map((r) => [r.accountId, r]));

  for (const a of accts) {
    const synced = hasToday.get(a.id);
    const syncedToday = synced && SYNCED.has(synced.source);

    if (a.kind === "mortgage" || a.kind === "loan") {
      const computed = await loanBalance(db, a.id, asOf);
      if (computed !== null) {
        if (syncedToday) {
          const d = balanceDrift(synced.current, computed);
          if (d.flagged) {
            out.drift.push({ accountId: a.id, driftMilli: d.drift.toString() });
            ctx.log.warn({ accountId: a.id }, "mortgage balance drifts more than $50 from the amortization schedule");
          }
          out.skippedSynced++;
        } else {
          await upsert(db, a.id, asOf, computed, "amortization");
          out.written++;
        }
        continue;
      }
    }
    if (syncedToday) {
      out.skippedSynced++;
      continue;
    }
    if (a.source !== "manual" && a.source !== "ynab_import" && a.source !== "csv" && a.kind !== "property" && a.kind !== "crypto") {
      // Synced account that didn't report today: carried forward by v_balances_daily.
      continue;
    }

    if (a.kind === "property") {
      const [v] = await db
        .select({ value: assetValuations.valueMilli, source: assetValuations.source })
        .from(assetValuations)
        .innerJoin(assets, eq(assets.id, assetValuations.assetId))
        .where(and(eq(assets.accountId, a.id), lte(assetValuations.asOf, asOf)))
        .orderBy(desc(assetValuations.asOf))
        .limit(1);
      if (v) {
        await upsert(db, a.id, asOf, v.value, v.source === "rentcast" ? "rentcast" : "manual");
        out.written++;
        continue;
      }
    }
    if (a.kind === "crypto") {
      const [latest] = await db.select({ asOf: holdings.asOf }).from(holdings).where(and(eq(holdings.accountId, a.id), lte(holdings.asOf, asOf))).orderBy(desc(holdings.asOf)).limit(1);
      if (latest) {
        const [s] = await db.select({ total: sql<string>`coalesce(sum(${holdings.marketValueMilli}), 0)::text` }).from(holdings).where(and(eq(holdings.accountId, a.id), eq(holdings.asOf, latest.asOf)));
        await upsert(db, a.id, asOf, BigInt(s?.total ?? "0"), a.source);
        out.written++;
        continue;
      }
    }
    const [s] = await db
      .select({ total: sql<string>`coalesce(sum(${transactions.amountMilli}), 0)::text` })
      .from(transactions)
      .where(and(eq(transactions.accountId, a.id), isNull(transactions.deletedAt), ne(transactions.cleared, "pending"), lte(transactions.date, asOf)));
    await upsert(db, a.id, asOf, BigInt(s?.total ?? "0"), a.source);
    out.written++;
  }
  return out;
}
