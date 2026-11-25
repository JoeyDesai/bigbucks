import { parseMilli } from "@homebase/shared";
import type { AccountKind, Cleared } from "@homebase/shared";
import { computeBudget } from "../src/budget";
import type { BudgetOptions, BudgetResult, BudgetSnapshot, CategoryMonth, EngineCategory, EngineScheduledTransaction, EngineTarget, EngineTransaction, Milli, Month } from "../src/types";

/** Dollars → milliunits (test convenience; exact for ≤3 decimals). */
export const $ = (n: number | string): Milli => parseMilli(String(n));

export const RTA_ID = "rta";
export const UNCAT_ID = "uncat";
export const pay = (card: string) => `pay:${card}`;

export interface TxInput {
  id?: string;
  acct: string;
  date: string;
  amt: number | string;
  cat?: string | null;
  xfer?: string | null;
  splits?: { amt: number | string; cat?: string | null; xfer?: string | null }[];
  cleared?: Cleared;
  sb?: boolean;
  order?: number;
  deleted?: boolean;
}

export class SnapshotBuilder {
  s: BudgetSnapshot = {
    accounts: [],
    groups: [
      { id: "g-internal", name: "Internal", sort: 0, hidden: false },
      { id: "g-cc", name: "Credit Card Payments", sort: 1, hidden: false },
      { id: "g-main", name: "Main", sort: 2, hidden: false },
    ],
    categories: [
      { id: RTA_ID, groupId: "g-internal", name: "Inflow: Ready to Assign", kind: "internal_rta", linkedAccountId: null, hidden: false, sort: 0 },
      { id: UNCAT_ID, groupId: "g-internal", name: "Uncategorized", kind: "uncategorized", linkedAccountId: null, hidden: false, sort: 1 },
    ],
    transactions: [],
    assignments: [],
    targets: [],
    scheduled: [],
  };
  private n = 0;
  private sort = 10;

  account(id: string, kind: AccountKind = "checking", onBudget = true): this {
    this.s.accounts.push({ id, kind, onBudget, closed: false, name: id });
    return this;
  }
  /** Adds a credit card and its payment category `pay:<id>`. */
  card(id: string, kind: AccountKind = "credit_card"): this {
    this.s.accounts.push({ id, kind, onBudget: true, closed: false, name: id });
    this.s.categories.push({ id: pay(id), groupId: "g-cc", name: id, kind: "cc_payment", linkedAccountId: id, hidden: false, sort: this.sort++ });
    return this;
  }
  cat(id: string, extra: Partial<EngineCategory> = {}): this {
    this.s.categories.push({ id, groupId: "g-main", name: id, kind: "normal", linkedAccountId: null, hidden: false, sort: this.sort++, ...extra });
    return this;
  }
  group(id: string, sort: number, hidden = false): this {
    this.s.groups.push({ id, name: id, sort, hidden });
    return this;
  }
  assign(month: string, categoryId: string, amt: number | string): this {
    this.s.assignments.push({ month: month.length === 7 ? `${month}-01` : month, categoryId, assigned: $(amt) });
    return this;
  }
  tx(t: TxInput): this {
    const id = t.id ?? `t${String(++this.n).padStart(4, "0")}`;
    const splits = t.splits?.map((p) => ({ amount: $(p.amt), categoryId: p.cat ?? null, transferAccountId: p.xfer ?? null }));
    const amount = splits ? splits.reduce((a, b) => a + b.amount, 0n) : $(t.amt);
    const tx: EngineTransaction = {
      id,
      accountId: t.acct,
      date: t.date,
      amount,
      categoryId: splits ? null : t.cat === undefined ? null : t.cat,
      transferAccountId: splits ? null : (t.xfer ?? null),
      cleared: t.cleared ?? "cleared",
      importOrder: t.order ?? this.n,
      splits,
      isStartingBalance: t.sb,
      deleted: t.deleted,
    };
    this.s.transactions.push(tx);
    return this;
  }
  /** Income to Ready to Assign. */
  income(acct: string, date: string, amt: number | string): this {
    return this.tx({ acct, date, amt, cat: RTA_ID });
  }
  spend(acct: string, date: string, cat: string | null, amt: number | string): this {
    return this.tx({ acct, date, amt: -Number(amt), cat });
  }
  /** Two-sided transfer of `amt` from → to. */
  transfer(from: string, to: string, date: string, amt: number | string, cat: string | null = null): this {
    this.tx({ acct: from, date, amt: -Number(amt), xfer: to, cat });
    const toAcct = this.s.accounts.find((a) => a.id === to);
    if (toAcct?.onBudget) this.tx({ acct: to, date, amt: Number(amt), xfer: from });
    return this;
  }
  target(t: Partial<EngineTarget> & Pick<EngineTarget, "categoryId" | "type">): this {
    this.s.targets.push({ effectiveFrom: "2026-01-01", amount: 0n, cadence: "monthly", cadenceEvery: 1, day: null, targetDate: null, percent: null, snoozedMonth: null, createdMonth: "2026-01-01", ...t });
    return this;
  }
  scheduled(s: Partial<EngineScheduledTransaction> & Pick<EngineScheduledTransaction, "accountId" | "amount" | "frequency" | "nextDate">): this {
    this.s.scheduled.push({ id: `s${++this.n}`, categoryId: null, transferAccountId: null, endDate: null, ...s });
    return this;
  }
  build(): BudgetSnapshot {
    return structuredClone(this.s);
  }
  run(through: string, opts: Partial<BudgetOptions> = {}): BudgetResult {
    return computeBudget(this.build(), { through: through.length === 7 ? `${through}-01` : through, ...opts });
  }
}

export const snap = () => new SnapshotBuilder();

export function m(r: BudgetResult, month: string) {
  const key: Month = month.length === 7 ? `${month}-01` : month;
  const mr = r.months[key];
  if (!mr) throw new Error(`no month ${key}; have ${r.monthList.join(",")}`);
  return mr;
}

export function c(r: BudgetResult, month: string, cat: string): CategoryMonth {
  const cm = m(r, month).categories[cat];
  if (!cm) throw new Error(`no category ${cat} in ${month}`);
  return cm;
}
