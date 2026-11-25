/** Home and mortgage detail (spec §7.6, §7.7, §12.3). */
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { accounts, assetValuations, assets, balances, loanEvents, loans, type Asset, type AssetValuation } from "@homebase/db";
import { today as localToday, type ISODate, type Milli } from "@homebase/shared";
import { writeAudit } from "../audit";
import { withTx, type Ctx, type DbLike } from "../context";
import { NotFoundError, ValidationError } from "../errors";
import { balanceAsOf, buildSchedule, interestPaidThrough, levelPayment, parseRate, type LoanEventInput, type LoanTerms, type Schedule } from "./amortization";
import { balancesAt } from "./netWorth";

/** Owed amount (≥ 0) from a stored (negative) liability balance. */
const owed = (b: Milli) => (b < 0n ? -b : b);

async function mortgageAccountsFor(db: DbLike, entityId: string): Promise<string[]> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.entityId, entityId), eq(accounts.kind, "mortgage"), eq(accounts.closed, false), isNull(accounts.deletedAt)));
  return rows.map((r) => r.id);
}

export interface HomeDetail {
  asset: Asset;
  accountId: string | null;
  latest: (Pick<AssetValuation, "asOf" | "source" | "comps"> & { value: Milli; low: Milli | null; high: Milli | null }) | null;
  valuations: { date: ISODate; value: Milli; low: Milli | null; high: Milli | null; source: AssetValuation["source"] }[];
  mortgageAccountIds: string[];
  mortgageBalance: Milli;
  equity: Milli | null;
  /** Equity at each valuation date (value − mortgage owed then). */
  equitySeries: { date: ISODate; value: Milli; mortgage: Milli; equity: Milli }[];
  purchasePrice: Milli | null;
  purchaseDate: ISODate | null;
  appreciation: Milli | null;
}

/** Home detail: valuation history with range band, comps, equity (value − mortgage). */
export async function homeDetail(db: DbLike, opts: { assetId?: string; accountId?: string; mortgageAccountIds?: string[]; today?: ISODate } = {}): Promise<HomeDetail> {
  const today = opts.today ?? localToday();
  const cond = opts.assetId ? eq(assets.id, opts.assetId) : opts.accountId ? eq(assets.accountId, opts.accountId) : eq(assets.kind, "home");
  const [asset] = await db.select().from(assets).where(cond).orderBy(asc(assets.createdAt)).limit(1);
  if (!asset) throw new NotFoundError("home", opts.assetId ?? opts.accountId ?? "(any)");
  const vals = await db.select().from(assetValuations).where(eq(assetValuations.assetId, asset.id)).orderBy(asc(assetValuations.asOf), asc(assetValuations.source));
  // one point per date; a manual override beats RentCast on the same day
  const byDate = new Map<string, AssetValuation>();
  for (const v of vals) {
    const prev = byDate.get(v.asOf);
    if (!prev || v.source === "manual") byDate.set(v.asOf, v);
  }
  const series = [...byDate.values()].sort((a, b) => (a.asOf < b.asOf ? -1 : 1)).filter((v) => v.asOf <= today);
  const last = series[series.length - 1] ?? null;
  let mortgageIds = opts.mortgageAccountIds ?? [];
  if (!opts.mortgageAccountIds && asset.accountId) {
    const [acct] = await db.select({ entityId: accounts.entityId }).from(accounts).where(eq(accounts.id, asset.accountId));
    if (acct) mortgageIds = await mortgageAccountsFor(db, acct.entityId);
  }
  const dates = [...new Set([...series.map((v) => v.asOf), today])];
  const bal = mortgageIds.length ? await balancesAt(db, dates, { includeBusiness: true, accountIds: mortgageIds }) : [];
  const mortgageOn = (d: ISODate) => bal.filter((b) => b.date === d).reduce((s, b) => s + owed(b.balance), 0n);
  const mortgageBalance = mortgageOn(today);
  return {
    asset,
    accountId: asset.accountId,
    latest: last ? { asOf: last.asOf, source: last.source, comps: last.comps, value: last.valueMilli, low: last.lowMilli, high: last.highMilli } : null,
    valuations: series.map((v) => ({ date: v.asOf, value: v.valueMilli, low: v.lowMilli, high: v.highMilli, source: v.source })),
    mortgageAccountIds: mortgageIds,
    mortgageBalance,
    equity: last ? last.valueMilli - mortgageBalance : null,
    equitySeries: series.map((v) => {
      const m = mortgageOn(v.asOf);
      return { date: v.asOf, value: v.valueMilli, mortgage: m, equity: v.valueMilli - m };
    }),
    purchasePrice: asset.purchasePriceMilli,
    purchaseDate: asset.purchaseDate,
    appreciation: last && asset.purchasePriceMilli !== null ? last.valueMilli - asset.purchasePriceMilli : null,
  };
}

/** Manual home value override (§12.3): a `manual` valuation plus the property account's balance. */
export async function setHomeValue(ctx: Ctx, input: { assetId: string; value: Milli; asOf?: ISODate; low?: Milli | null; high?: Milli | null }): Promise<void> {
  if (input.value <= 0n) throw new ValidationError("value must be positive");
  await withTx(ctx, async (tx, c) => {
    const [asset] = await tx.select().from(assets).where(eq(assets.id, input.assetId));
    if (!asset) throw new NotFoundError("asset", input.assetId);
    const asOf = input.asOf ?? c.today ?? localToday();
    const row = { assetId: asset.id, asOf, valueMilli: input.value, lowMilli: input.low ?? null, highMilli: input.high ?? null, source: "manual" as const };
    await tx
      .insert(assetValuations)
      .values(row)
      .onConflictDoUpdate({ target: [assetValuations.assetId, assetValuations.asOf, assetValuations.source], set: { valueMilli: row.valueMilli, lowMilli: row.lowMilli, highMilli: row.highMilli, updatedAt: new Date() } });
    if (asset.accountId) {
      await tx
        .insert(balances)
        .values({ accountId: asset.accountId, asOf, currentMilli: input.value, source: "manual" })
        .onConflictDoUpdate({ target: [balances.accountId, balances.asOf], set: { currentMilli: input.value, source: "manual", updatedAt: new Date() } });
    }
    await writeAudit(tx, c, { action: "wealth.set_home_value", entity: "asset", entityId: asset.id, after: { asOf, value: input.value } });
  });
}

// ── mortgage ────────────────────────────────────────────────────────────────

export interface MortgageScenario {
  /** Extra principal with every payment from `extraFrom` (default: today) on. */
  extraMonthly?: Milli;
  extraFrom?: ISODate;
  /** One-time extra principal. */
  lumpSum?: { date: ISODate; amount: Milli };
  /** Recast: optional lump sum, then the payment is re-levelled over the remaining term (or set). */
  recast?: { date: ISODate; lumpSum?: Milli; newPayment?: Milli };
}

export interface MortgageDetail {
  accountId: string;
  name: string;
  servicer: string | null;
  terms: LoanTerms & { annualRatePct: string };
  /** Owed per the schedule (all payments and loan_events ≤ today). */
  scheduledBalance: Milli;
  /** Owed per the latest synced (non-amortization) balance snapshot. */
  syncedBalance: Milli | null;
  syncedAsOf: ISODate | null;
  /** synced − scheduled; flagged beyond $50 (§7.7). */
  drift: Milli | null;
  driftFlagged: boolean;
  payoffDate: ISODate | null;
  interestPaidToDate: Milli;
  principalPaidToDate: Milli;
  remainingInterest: Milli;
  nextPayment: { date: ISODate; principal: Milli; interest: Milli; escrow: Milli; total: Milli } | null;
  schedule: Schedule;
  events: LoanEventInput[];
  scenario: null | {
    schedule: Schedule;
    payoffDate: ISODate | null;
    totalInterest: Milli;
    interestSaved: Milli;
    monthsSaved: number;
    newPayment: Milli | null;
  };
}

export async function mortgageDetail(db: DbLike, accountId: string, opts: { today?: ISODate; scenario?: MortgageScenario } = {}): Promise<MortgageDetail> {
  const today = opts.today ?? localToday();
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!acct) throw new NotFoundError("account", accountId);
  const [loan] = await db.select().from(loans).where(eq(loans.accountId, accountId));
  if (!loan) throw new NotFoundError("loan terms for account", accountId);
  const evRows = await db.select().from(loanEvents).where(eq(loanEvents.accountId, accountId)).orderBy(asc(loanEvents.date));
  const terms: LoanTerms = {
    principal: loan.originalPrincipalMilli,
    annualRate: loan.annualRate,
    termMonths: loan.termMonths,
    firstPaymentDate: loan.firstPaymentDate,
    payment: loan.piPaymentMilli,
    escrow: loan.escrowMilli,
  };
  const events: LoanEventInput[] = evRows.map((e) => ({ date: e.date, kind: e.kind, amount: e.amountMilli, newPayment: e.newPaymentMilli, newRate: e.newRate }));
  const schedule = buildSchedule(terms, events);
  const scheduledBalance = balanceAsOf(terms, schedule, today);
  const [synced] = await db
    .select({ bal: balances.currentMilli, asOf: balances.asOf })
    .from(balances)
    .where(and(eq(balances.accountId, accountId), ne(balances.source, "amortization")))
    .orderBy(desc(balances.asOf))
    .limit(1);
  const syncedBalance = synced ? owed(synced.bal) : null;
  const drift = syncedBalance === null ? null : syncedBalance - scheduledBalance;
  const interestPaid = interestPaidThrough(schedule, today);
  const next = schedule.rows.find((r) => r.date > today) ?? null;
  const ratePct = (Number(parseRate(loan.annualRate)) / 1e7).toFixed(3);

  let scenario: MortgageDetail["scenario"] = null;
  if (opts.scenario && (opts.scenario.extraMonthly || opts.scenario.lumpSum || opts.scenario.recast)) {
    const s = opts.scenario;
    const extraEvents: LoanEventInput[] = [];
    if (s.lumpSum) extraEvents.push({ date: s.lumpSum.date, kind: "extra_principal", amount: s.lumpSum.amount, newPayment: null, newRate: null });
    let newPayment: Milli | null = null;
    if (s.recast) {
      if (s.recast.newPayment) newPayment = s.recast.newPayment;
      else {
        const balAt = balanceAsOf(terms, schedule, s.recast.date) - (s.recast.lumpSum ?? 0n);
        const paid = schedule.rows.filter((r) => r.date <= s.recast!.date).length;
        newPayment = levelPayment(balAt > 0n ? balAt : 0n, parseRate(loan.annualRate), Math.max(1, terms.termMonths - paid));
      }
      extraEvents.push({ date: s.recast.date, kind: "recast", amount: s.recast.lumpSum ?? null, newPayment, newRate: null });
    }
    const sched = buildSchedule(terms, events, { extraMonthly: s.extraMonthly, extraFrom: s.extraFrom ?? today, extraEvents });
    scenario = {
      schedule: sched,
      payoffDate: sched.payoffDate,
      totalInterest: sched.totalInterest,
      interestSaved: schedule.totalInterest - sched.totalInterest,
      monthsSaved: schedule.rows.length - sched.rows.length,
      newPayment,
    };
  }

  return {
    accountId,
    name: acct.nickname ?? acct.name,
    servicer: loan.servicer,
    terms: { ...terms, annualRatePct: ratePct },
    scheduledBalance,
    syncedBalance,
    syncedAsOf: synced?.asOf ?? null,
    drift,
    driftFlagged: drift !== null && (drift < 0n ? -drift : drift) > 50_000n,
    payoffDate: schedule.payoffDate,
    interestPaidToDate: interestPaid,
    principalPaidToDate: terms.principal - scheduledBalance,
    remainingInterest: schedule.totalInterest - interestPaid,
    nextPayment: next ? { date: next.date, principal: next.principal, interest: next.interest, escrow: terms.escrow, total: next.principal + next.interest + terms.escrow } : null,
    schedule,
    events,
    scenario,
  };
}
