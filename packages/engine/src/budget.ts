/**
 * The budget engine (§6.1–§6.4): Available, carry, overspending, Ready to Assign and credit-card
 * payment categories, month by month. Targets (§6.5) and Age of Money (§6.7) are folded in.
 */
import { formatMilli, monthRange } from "@homebase/shared";
import { computeAgeOfMoneyByMonth } from "./ageOfMoney";
import { buildLedger, type Ledger, type Line } from "./ledger";
import { occurrencesInMonth } from "./schedule";
import { computeTargetMonth, effectiveTarget, indexTargets, type TargetMonth } from "./targets";
import {
  ENGINE_VERSION,
  type BudgetOptions,
  type BudgetResult,
  type BudgetSnapshot,
  type CategoryMonth,
  type CategoryStatus,
  type EngineCategory,
  type Milli,
  type Month,
  type MonthResult,
  type ResolvedBudgetOptions,
} from "./types";

export const DEFAULT_OPTIONS: Omit<ResolvedBudgetOptions, "through"> = {
  overspendAttribution: "cash_first",
  negativeRtaCarries: true,
  paymentCategoryNegative: "cash_overspend",
  cardStartingDebt: "no_budget_effect",
  cardPositiveBalanceToRta: "rta",
  cardRtaLines: "debt_only",
  balanceTargetIncludesActivity: false,
  rtaDisplay: "future_min",
  ageOfMoneyStartingBalances: true,
};

export function resolveOptions(o: BudgetOptions): ResolvedBudgetOptions {
  const r: ResolvedBudgetOptions = { ...DEFAULT_OPTIONS, through: o.through };
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v;
  return r;
}

const key = (month: Month, categoryId: string) => `${month}|${categoryId}`;
const max0 = (a: Milli): Milli => (a > 0n ? a : 0n);
const min = (a: Milli, b: Milli): Milli => (a < b ? a : b);

interface PaymentAccum {
  fundedSpending: Milli;
  refunds: Milli;
  payments: Milli;
  direct: Milli;
  unfundedSpending: Milli;
}

/** Status + label for a category month (§12.1 colours: red cash, yellow credit/underfunded). */
export function categoryStatus(c: Pick<CategoryMonth, "available" | "cashOverspend" | "creditOverspend" | "underfunded" | "upcoming" | "hasTarget" | "activity" | "assigned">, t: Pick<TargetMonth, "scheduleNeeded" | "targetNeeded">): { status: CategoryStatus; statusLabel: string } {
  if (c.available < 0n) {
    const over = formatMilli(-c.available);
    if (c.cashOverspend > 0n && c.creditOverspend > 0n)
      return { status: "overspent_cash", statusLabel: `Overspent ${over} (${formatMilli(c.cashOverspend)} cash, ${formatMilli(c.creditOverspend)} credit)` };
    if (c.cashOverspend > 0n) return { status: "overspent_cash", statusLabel: `Overspent ${over}` };
    return { status: "overspent_credit", statusLabel: `Overspent ${over} on credit` };
  }
  if (c.underfunded > 0n) {
    if (t.scheduleNeeded > 0n && t.scheduleNeeded >= t.targetNeeded)
      return { status: "upcoming", statusLabel: `${formatMilli(c.underfunded)} more needed for upcoming` };
    return { status: "underfunded", statusLabel: `${formatMilli(c.underfunded)} more needed` };
  }
  if (c.available === 0n && !c.hasTarget && c.upcoming === 0n) {
    return { status: "zero", statusLabel: c.activity < 0n ? "Fully spent" : "Zero" };
  }
  if (c.available === 0n && c.activity < 0n) return { status: "funded", statusLabel: "Fully spent" };
  return { status: "funded", statusLabel: "Funded" };
}

/**
 * Compute the budget for every month from the first month with data through `options.through`.
 * Pure and deterministic.
 */
export function computeBudget(snapshot: BudgetSnapshot, options: BudgetOptions): BudgetResult {
  const opts = resolveOptions(options);
  const ledger = buildLedger(snapshot, opts);
  return computeFromLedger(snapshot, ledger, opts);
}

export function computeFromLedger(snapshot: BudgetSnapshot, ledger: Ledger, opts: ResolvedBudgetOptions): BudgetResult {
  const warnings = [...ledger.warnings];
  const assigned = new Map<string, Milli>();
  let lastAssignMonth: Month | null = null;
  let firstAssignMonth: Month | null = null;
  for (const a of snapshot.assignments) {
    if (ledger.rtaIds.has(a.categoryId)) continue;
    if (!ledger.categories.has(a.categoryId)) {
      warnings.push(`assignment to unknown category ${a.categoryId} in ${a.month}`);
      continue;
    }
    const k = key(a.month, a.categoryId);
    assigned.set(k, (assigned.get(k) ?? 0n) + a.assigned);
    if (a.assigned !== 0n) {
      if (!lastAssignMonth || a.month > lastAssignMonth) lastAssignMonth = a.month;
      if (!firstAssignMonth || a.month < firstAssignMonth) firstAssignMonth = a.month;
    }
  }

  const candidatesFirst = [ledger.firstMonth, firstAssignMonth, opts.from ?? null].filter((m): m is Month => !!m);
  const first = candidatesFirst.length ? candidatesFirst.reduce((a, b) => (a < b ? a : b)) : opts.through;
  const lastComputed = [opts.through, lastAssignMonth].filter((m): m is Month => !!m).reduce((a, b) => (a > b ? a : b));
  const months = first <= lastComputed ? monthRange(first, lastComputed) : [];

  // bucket lines by month
  const linesByMonth = new Map<Month, Line[]>();
  for (const l of ledger.lines) {
    if (l.month > lastComputed) continue;
    const arr = linesByMonth.get(l.month) ?? [];
    arr.push(l);
    linesByMonth.set(l.month, arr);
  }

  const targetsByCat = indexTargets(snapshot.targets);
  const scheduled = snapshot.scheduled.filter((s) => !s.deleted);
  const categories = ledger.orderedCategories.filter((c) => c.kind !== "internal_rta");
  const ageByMonth = computeAgeOfMoneyByMonth(ledger, months, { asOf: opts.asOf, includeStartingBalances: opts.ageOfMoneyStartingBalances });

  const results: MonthResult[] = [];
  const prevAvail = new Map<string, Milli>();
  const cardBalance = new Map<string, Milli>();
  let rtaCarry = 0n;
  let prevCashOverspend = 0n;

  for (const M of months) {
    const lines = linesByMonth.get(M) ?? [];
    // card balances at month end
    for (const acct of ledger.creditAccounts) {
      const d = ledger.cardDeltaByMonth.get(acct)?.get(M) ?? 0n;
      cardBalance.set(acct, (cardBalance.get(acct) ?? 0n) + d);
    }

    // group category lines; collect RTA / payment effects
    const catLines = new Map<string, Line[]>();
    const pay = new Map<string, PaymentAccum>();
    const getPay = (pid: string) => {
      let p = pay.get(pid);
      if (!p) pay.set(pid, (p = { fundedSpending: 0n, refunds: 0n, payments: 0n, direct: 0n, unfundedSpending: 0n }));
      return p;
    };
    let income = 0n;
    let debtInflow = 0n;
    let monthActivity = 0n;
    const toRta = opts.cardPositiveBalanceToRta === "rta";
    for (const l of lines) {
      const e = l.effect;
      switch (e.kind) {
        case "rta":
          income += l.amount;
          break;
        case "card_rta":
          if (toRta) debtInflow += l.positiveIncrease;
          break;
        case "category": {
          const arr = catLines.get(e.categoryId) ?? [];
          arr.push(l);
          catLines.set(e.categoryId, arr);
          monthActivity += l.amount;
          if (l.onCredit && l.amount > 0n && l.paymentCategoryId) {
            getPay(l.paymentCategoryId).refunds -= l.amount;
            if (toRta) debtInflow += l.positiveIncrease;
          }
          break;
        }
        case "payment_direct":
          getPay(e.categoryId).direct += l.amount;
          monthActivity += l.amount;
          break;
        case "card_transfer":
          if (l.paymentCategoryId) {
            const p = getPay(l.paymentCategoryId);
            if (l.amount > 0n) {
              p.payments -= l.amount;
              if (toRta) debtInflow += l.positiveIncrease;
            } else p.payments += l.creditPortion; // cash advance: only the part that added debt
          }
          break;
        case "none":
          break;
      }
    }

    const catResults: Record<string, CategoryMonth> = {};
    const raw = new Map<string, { carryIn: Milli; assigned: Milli; activity: Milli; available: Milli; cash: Milli; credit: Milli; cashSp: Milli; creditSp: Milli }>();

    // 1) normal + uncategorized categories: funding pass (§6.4 rule 1, §6.3)
    for (const c of categories) {
      if (c.kind === "cc_payment") continue;
      const carryIn = max0(prevAvail.get(c.id) ?? 0n);
      const asg = assigned.get(key(M, c.id)) ?? 0n;
      const ls = catLines.get(c.id) ?? [];
      let activity = 0n;
      let cashSp = 0n;
      let creditSp = 0n;
      let unfunded = 0n;
      let pool = carryIn + asg;
      const fund = (l: Line) => {
        const F = min(l.creditPortion, max0(pool));
        pool -= l.creditPortion;
        unfunded += l.creditPortion - F;
        if (l.paymentCategoryId) {
          const p = getPay(l.paymentCategoryId);
          p.fundedSpending += F;
          p.unfundedSpending += l.creditPortion - F;
        }
      };
      for (const l of ls) {
        activity += l.amount;
        cashSp -= l.cashPortion;
        creditSp -= l.creditPortion;
      }
      if (opts.overspendAttribution === "cash_first") {
        for (const l of ls) pool += l.amount > 0n ? l.amount : -l.cashPortion;
        for (const l of ls) if (l.creditPortion > 0n) fund(l);
      } else {
        for (const l of ls) {
          if (l.amount >= 0n) pool += l.amount;
          else {
            pool -= l.cashPortion;
            if (l.creditPortion > 0n) fund(l);
          }
        }
      }
      const available = carryIn + asg + activity;
      let cash = 0n;
      let credit = 0n;
      if (available < 0n) {
        credit = min(-available, unfunded);
        cash = -available - credit;
      }
      raw.set(c.id, { carryIn, assigned: asg, activity, available, cash, credit, cashSp, creditSp });
    }

    // 2) payment categories (§6.4)
    for (const c of categories) {
      if (c.kind !== "cc_payment") continue;
      const prev = prevAvail.get(c.id) ?? 0n;
      const carryIn = opts.paymentCategoryNegative === "carry" ? prev : max0(prev);
      const asg = assigned.get(key(M, c.id)) ?? 0n;
      const p = pay.get(c.id) ?? { fundedSpending: 0n, refunds: 0n, payments: 0n, direct: 0n, unfundedSpending: 0n };
      const activity = p.fundedSpending + p.refunds + p.payments + p.direct;
      const available = carryIn + asg + activity;
      const cash = available < 0n && opts.paymentCategoryNegative === "cash_overspend" ? -available : 0n;
      raw.set(c.id, { carryIn, assigned: asg, activity, available, cash, credit: 0n, cashSp: 0n, creditSp: 0n });
    }

    // 3) upcoming scheduled outflows per category in M
    const upcoming = new Map<string, Milli>();
    const addUp = (cid: string, amt: Milli) => upcoming.set(cid, (upcoming.get(cid) ?? 0n) + amt);
    for (const s of scheduled) {
      const n = BigInt(occurrencesInMonth(s, M).length);
      if (n === 0n) continue;
      const acct = ledger.accounts.get(s.accountId);
      if (!acct?.onBudget) continue;
      const parts = s.splits && s.splits.length ? s.splits : [{ amount: s.amount, categoryId: s.categoryId, transferAccountId: s.transferAccountId }];
      for (const part of parts) {
        const counter = part.transferAccountId ? ledger.accounts.get(part.transferAccountId) : undefined;
        if (counter?.onBudget) {
          // a scheduled card payment counts toward that card's payment category
          if (ledger.creditAccounts.has(counter.id) && !ledger.creditAccounts.has(s.accountId) && part.amount < 0n) addUp(ledger.paymentCategoryByAccount.get(counter.id)!, -part.amount * n);
          else if (ledger.creditAccounts.has(s.accountId) && !ledger.creditAccounts.has(counter.id) && part.amount > 0n) addUp(ledger.paymentCategoryByAccount.get(s.accountId)!, part.amount * n);
          continue;
        }
        if (part.amount >= 0n) continue;
        let cid = part.categoryId;
        if (cid !== null && ledger.rtaIds.has(cid)) continue;
        if (cid === null || !ledger.categories.has(cid)) cid = ledger.uncategorizedId;
        addUp(cid, -part.amount * n);
      }
    }

    // 4) targets, status, totals
    let catTotalAssigned = 0n;
    let catTotalAvailable = 0n;
    let cashOverspending = 0n;
    let costToBeMe = 0n;
    let underfundedTotal = 0n;
    for (const c of categories) {
      const r = raw.get(c.id)!;
      const isPay = c.kind === "cc_payment";
      const acct = isPay ? c.linkedAccountId : null;
      const bal = acct ? (cardBalance.get(acct) ?? 0n) : 0n;
      const t = computeTargetMonth({
        month: M,
        kind: c.kind,
        target: effectiveTarget(targetsByCat.get(c.id), M),
        carryIn: r.carryIn,
        assigned: r.assigned,
        activity: r.activity,
        assignedIn: (m) => assigned.get(key(m, c.id)) ?? 0n,
        income,
        incomeOverrides: snapshot.incomeBasis,
        upcoming: upcoming.get(c.id) ?? 0n,
        debt: isPay ? max0(-bal) : undefined,
        balanceTargetIncludesActivity: opts.balanceTargetIncludesActivity,
      });
      const cm: CategoryMonth = {
        categoryId: c.id,
        carryIn: r.carryIn,
        assigned: r.assigned,
        activity: r.activity,
        available: r.available,
        cashOverspend: r.cash,
        creditOverspend: r.credit,
        cashSpending: r.cashSp,
        creditSpending: r.creditSp,
        needed: t.needed,
        underfunded: t.underfunded,
        overallLeft: t.overallLeft,
        pctComplete: t.pctComplete,
        upcoming: upcoming.get(c.id) ?? 0n,
        hasTarget: t.hasTarget,
        snoozed: t.snoozed,
        status: "zero",
        statusLabel: "",
      };
      Object.assign(cm, categoryStatus(cm, t));
      if (isPay && acct) {
        const p = pay.get(c.id) ?? { fundedSpending: 0n, refunds: 0n, payments: 0n, direct: 0n, unfundedSpending: 0n };
        cm.payment = { accountId: acct, ...p, cardBalance: bal, debt: max0(-bal) };
      }
      catResults[c.id] = cm;
      catTotalAssigned += r.assigned;
      catTotalAvailable += r.available;
      cashOverspending += r.cash;
      if (!c.deleted) {
        costToBeMe += t.needed;
        underfundedTotal += t.underfunded;
      }
      // next month's carry source: negative balances do not roll (except payment categories in `carry` mode)
      prevAvail.set(c.id, r.available);
    }

    // 5) Ready to Assign (§6.2)
    const leftOver = rtaCarry;
    const rta = leftOver + income + debtInflow - prevCashOverspend - catTotalAssigned;
    rtaCarry = opts.negativeRtaCarries ? rta : max0(rta);
    results.push({
      month: M,
      rta,
      readyToAssignDisplay: rta,
      assignedInFuture: 0n,
      leftOverFromLastMonth: leftOver,
      income,
      inflowFromDebtAccounts: debtInflow,
      cashOverspendingLastMonth: prevCashOverspend,
      cashOverspending,
      assigned: catTotalAssigned,
      activity: monthActivity,
      available: catTotalAvailable,
      costToBeMe,
      underfunded: underfundedTotal,
      ageOfMoney: ageByMonth.get(M) ?? null,
      categories: catResults,
    });
    prevCashOverspend = cashOverspending;
  }

  // 6) display RTA: "RTA is current in the future-most month" (§6.2)
  if (opts.rtaDisplay === "future_min") {
    let futureMin: Milli | null = null;
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i]!;
      if (r.rta >= 0n && futureMin !== null) {
        const cap = max0(futureMin);
        r.readyToAssignDisplay = r.rta < cap ? r.rta : cap;
      }
      r.assignedInFuture = r.rta - r.readyToAssignDisplay;
      futureMin = futureMin === null || r.rta < futureMin ? r.rta : futureMin;
    }
  }

  const out: Record<Month, MonthResult> = {};
  const monthList: Month[] = [];
  for (const r of results) {
    if (r.month > opts.through) continue;
    if (opts.from && r.month < opts.from) continue;
    out[r.month] = r;
    monthList.push(r.month);
  }
  return { engineVersion: ENGINE_VERSION, monthList, months: out, warnings: [...new Set(warnings)] };
}

/** Convenience: categories in display order (group sort, category sort), excluding Ready to Assign. */
export function orderedBudgetCategories(snapshot: BudgetSnapshot): EngineCategory[] {
  return buildLedger(snapshot, { cardStartingDebt: DEFAULT_OPTIONS.cardStartingDebt }).orderedCategories.filter((c) => c.kind !== "internal_rta");
}

/** Month-end card balance helper (excluding pending), for suggested payments (§6.4 rule 3). */
export function suggestedCardPayment(paymentAvailable: Milli, clearedCardBalance: Milli): Milli {
  const owed = max0(-clearedCardBalance);
  return max0(min(paymentAvailable, owed));
}
