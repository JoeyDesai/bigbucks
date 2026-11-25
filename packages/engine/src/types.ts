/**
 * Public types for the Homebase budget engine (spec §6).
 *
 * STABILITY: other packages (db, worker, web) code against these types. Add optional fields freely;
 * never rename or remove a field without bumping ENGINE_VERSION and updating callers.
 *
 * Conventions:
 *  - All money is bigint milliunits ($1.00 = 1000n). Outflows are negative, inflows positive.
 *  - Dates are "YYYY-MM-DD" (America/New_York calendar dates); months are "YYYY-MM-01".
 *  - The engine is pure: same snapshot + options → same result. No DB, no network, no clock
 *    (pass `asOf` explicitly when "today" matters).
 */
import type {
  AccountKind,
  AutoAssignMode,
  Cadence,
  CategoryKind,
  Cleared,
  Frequency,
  ISODate,
  Milli,
  Month,
  TargetType,
} from "@homebase/shared";

export type { Milli, Month, ISODate };

/** Bump whenever engine output can change for the same input (cache key for budget_month_cache). */
export const ENGINE_VERSION = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Input snapshot
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineAccount {
  id: string;
  kind: AccountKind;
  onBudget: boolean;
  closed: boolean;
  name?: string;
}

export interface EngineCategoryGroup {
  id: string;
  name?: string;
  sort: number;
  hidden: boolean;
}

export interface EngineCategory {
  id: string;
  groupId: string;
  name?: string;
  kind: CategoryKind;
  /** For `cc_payment` categories: the on-budget credit account K this is P(K) for. */
  linkedAccountId: string | null;
  hidden: boolean;
  sort: number;
  /** Deleted categories stay in the math (their history must add up) but are excluded from views. */
  deleted?: boolean;
}

export interface EngineSplit {
  id?: string;
  amount: Milli;
  categoryId: string | null;
  transferAccountId: string | null;
}

export interface EngineTransaction {
  id: string;
  accountId: string;
  date: ISODate;
  /** Signed: − outflow, + inflow. For a split, the sum of `splits[].amount`. */
  amount: Milli;
  /** null for splits, transfers between on-budget accounts, and uncategorized transactions. */
  categoryId: string | null;
  transferAccountId: string | null;
  /** `pending` transactions are display-only and ignored by the engine (§6.1). */
  cleared: Cleared;
  /** Tie-break within a date (YNAB order for imported data, then import order). Lower first. */
  importOrder?: number;
  /** Non-empty → split transaction; each line is processed separately (§6.4 rule 7). */
  splits?: EngineSplit[];
  deleted?: boolean;
  /** The account's "Starting Balance" transaction (§6.1). See `BudgetOptions.cardStartingDebt`. */
  isStartingBalance?: boolean;
}

export interface EngineAssignment {
  month: Month;
  categoryId: string;
  assigned: Milli;
}

export type IncomeBasis = "rta_inflows" | "gross_pay";

/**
 * A target row with history (§6.5). The row in effect for month M is the one with the greatest
 * `effectiveFrom` ≤ M. A row with `removed: true` means "no target from effectiveFrom onward".
 */
export interface EngineTarget {
  categoryId: string;
  effectiveFrom: Month;
  type: TargetType;
  /** Target amount X. For `percent_of_income`, ignored (use `percent`). */
  amount: Milli;
  cadence: Cadence;
  /** Every N (weeks for weekly, months for monthly/every_n_months, years for yearly). Default 1. */
  cadenceEvery: number;
  /** Weekly: weekday 0=Sun…6=Sat. Otherwise day of month (null = end of month). */
  day: number | null;
  /** Next due date / target date ("by" date). Required for balance_by_date; anchors repeating periods. */
  targetDate: ISODate | null;
  /** `percent_of_income`: decimal percent as a string or number, e.g. "10" or "12.5". */
  percent: string | number | null;
  /** The target is snoozed for this month only (needed = 0). */
  snoozedMonth: Month | null;
  createdMonth: Month;
  /** `percent_of_income` only. Default `rta_inflows`. */
  incomeBasis?: IncomeBasis;
  removed?: boolean;
}

export interface EngineScheduledSplit {
  amount: Milli;
  categoryId: string | null;
  transferAccountId: string | null;
}

export interface EngineScheduledTransaction {
  id: string;
  accountId: string;
  categoryId: string | null;
  transferAccountId: string | null;
  amount: Milli;
  frequency: Frequency;
  /** Next not-yet-entered occurrence. */
  nextDate: ISODate;
  endDate: ISODate | null;
  splits?: EngineScheduledSplit[];
  deleted?: boolean;
}

/** Explicit income basis for a month (e.g. Gusto gross pay, Phase 8), overriding the computed one. */
export interface IncomeBasisOverride {
  month: Month;
  basis: IncomeBasis;
  amount: Milli;
}

export interface BudgetSnapshot {
  accounts: EngineAccount[];
  groups: EngineCategoryGroup[];
  categories: EngineCategory[];
  transactions: EngineTransaction[];
  assignments: EngineAssignment[];
  targets: EngineTarget[];
  scheduled: EngineScheduledTransaction[];
  incomeBasis?: IncomeBasisOverride[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetOptions {
  /** Last month to return (inclusive). */
  through: Month;
  /**
   * First month to return. The engine always computes from the earliest month with data (carry and
   * RTA depend on all history); `from` only trims the output (and may add empty leading months).
   */
  from?: Month;
  /** "Today", for upcoming scheduled transactions and Age of Money cut-off. Default: none (all). */
  asOf?: ISODate;
  /**
   * How a category's Funds are consumed when it has both cash and credit outflows (§6.3/§6.4).
   *  - `cash_first` (default; verified by the §6.9 golden run, ADR-E1): Funds(c) = carry + the
   *    month's assigned + every inflow to c in the month; cash outflows consume it first, then
   *    card outflows in (date, importOrder, id) order. Matches YNAB's "takes the cash out first".
   *  - `chronological` (spec §6.4 as first written): one ordered pass over inflows and outflows.
   */
  overspendAttribution?: "chronological" | "cash_first";
  /** Negative RTA carries into the next month (default true; YNAB docs, ADR-E3). */
  negativeRtaCarries?: boolean;
  /**
   * A negative payment-category balance at month end (paid more than set aside):
   *  - `cash_overspend` (default; YNAB shows it red = cash overspending, ADR-E4): reset to 0 and
   *    subtract from next month's RTA.
   *  - `carry`: carry the negative balance forward.
   */
  paymentCategoryNegative?: "cash_overspend" | "carry";
  /**
   * Card "Starting Balance" transactions with a negative amount (pre-existing debt):
   *  - `no_budget_effect` (default, YNAB docs): ignored by every category and RTA; it only adds to
   *    the card's debt, so P(K) shows underfunded.
   *  - `as_categorized`: treat like any other transaction.
   */
  cardStartingDebt?: "no_budget_effect" | "as_categorized";
  /**
   * Inflow to a credit card that pushes its balance above zero (overpayment / big refund):
   *  - `rta` (default, YNAB "Inflow from Debt Account"): the above-zero portion is added to RTA.
   *  - `none`: no RTA effect.
   */
  cardPositiveBalanceToRta?: "rta" | "none";
  /**
   * Lines on a credit account categorized to Ready to Assign (statement credits, balance
   * adjustments, card refunds sent to RTA):
   *  - `debt_only` (default; verified against YNAB parity data, ADR-E12): no RTA income and no
   *    payment-category effect — only the card balance changes (a part that pushes the card above
   *    zero still reaches RTA as "Inflow from Debt Account").
   *  - `income`: count them as Ready to Assign income.
   */
  cardRtaLines?: "debt_only" | "income";
  /** `balance` targets measure Available including this month's activity (default false = spec). */
  balanceTargetIncludesActivity?: boolean;
  /**
   * How `readyToAssignDisplay` accounts for later months:
   *  - `future_min` (default): RTA shown = min(rta(M), max(min rta of later months, 0)) — YNAB
   *    "RTA is current in the future-most month"; assigned-in-future is the difference.
   *  - `raw`: no future adjustment.
   */
  rtaDisplay?: "future_min" | "raw";
  /** Count starting balances as Age-of-Money buckets (default true). */
  ageOfMoneyStartingBalances?: boolean;
}

export type ResolvedBudgetOptions = Required<Omit<BudgetOptions, "from" | "asOf">> & {
  from?: Month;
  asOf?: ISODate;
};

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

export type CategoryStatus =
  | "funded"
  | "underfunded"
  | "overspent_cash"
  | "overspent_credit"
  | "zero"
  | "upcoming";

/** Extra breakdown for credit-card payment categories P(K). */
export interface PaymentCategoryDetail {
  accountId: string;
  /** + funded card spending moved in this month. */
  fundedSpending: Milli;
  /** − card refunds/returns moved back out to spending categories. */
  refunds: Milli;
  /** − payments (transfers into the card), + cash advances (transfers out of the card). */
  payments: Milli;
  /** Amounts categorized directly to P(K) (e.g. interest). */
  direct: Milli;
  /** Card balance at month end (signed; negative = owed), excluding pending. */
  cardBalance: Milli;
  /** max(−cardBalance, 0). */
  debt: Milli;
  /** Credit spending this month that could not be funded (credit overspending, all categories). */
  unfundedSpending: Milli;
}

export interface CategoryMonth {
  categoryId: string;
  /** max(Available(M−1), 0); for payment categories with `paymentCategoryNegative: carry`, may be < 0. */
  carryIn: Milli;
  assigned: Milli;
  activity: Milli;
  /** carryIn + assigned + activity. */
  available: Milli;
  /** Portion of a negative Available that is cash overspending (≥ 0; hits next month's RTA). */
  cashOverspend: Milli;
  /** Portion of a negative Available that is credit overspending (≥ 0; stays card debt). */
  creditOverspend: Milli;
  /** Sum of outflows from cash accounts (and from cards while their balance is positive). ≤ 0. */
  cashSpending: Milli;
  /** Sum of outflows that added card debt. ≤ 0. */
  creditSpending: Milli;
  /** Target need for the month before subtracting this month's assigned (§6.5). */
  needed: Milli;
  /** max(needed − assigned, 0). */
  underfunded: Milli;
  /** Funding still needed to complete the target in the current target period. */
  overallLeft: Milli;
  /** 0–100 integer. */
  pctComplete: number;
  /** Outflows of upcoming scheduled transactions in this month (≥ 0 magnitude). */
  upcoming: Milli;
  /** True when an effective (possibly snoozed) target exists for this month. */
  hasTarget: boolean;
  snoozed: boolean;
  status: CategoryStatus;
  statusLabel: string;
  payment?: PaymentCategoryDetail;
}

export interface MonthResult {
  month: Month;
  /** Raw Ready to Assign for the month (cumulative; no future-month adjustment). */
  rta: Milli;
  /** What the UI shows: rta minus money assigned in future months. */
  readyToAssignDisplay: Milli;
  assignedInFuture: Milli;
  /** RTA carried in from the previous month (after the negative-carry rule). */
  leftOverFromLastMonth: Milli;
  /** Inflows categorized to Ready to Assign this month. */
  income: Milli;
  /** Above-zero portion of credit-card inflows ("Inflow from Debt Account"). */
  inflowFromDebtAccounts: Milli;
  /** Cash overspending of the previous month, subtracted from this month's RTA (≥ 0). */
  cashOverspendingLastMonth: Milli;
  /** Cash overspending this month (≥ 0), subtracted from next month's RTA. */
  cashOverspending: Milli;
  /** Σ assigned this month (all categories). */
  assigned: Milli;
  /** Σ of transactions this month excluding RTA inflows and excluding card-payment moves. */
  activity: Milli;
  /** Σ Available across categories (excluding Ready to Assign). */
  available: Milli;
  /** Σ needed (§6.5). */
  costToBeMe: Milli;
  /** Σ underfunded. */
  underfunded: Milli;
  /** Days; null until 10 qualifying outflows (§6.7). */
  ageOfMoney: number | null;
  categories: Record<string, CategoryMonth>;
}

export interface BudgetResult {
  engineVersion: number;
  /** Months in ascending order. */
  monthList: Month[];
  months: Record<Month, MonthResult>;
  /** Non-fatal data problems (unknown accounts/categories, missing payment categories, …). */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Money operations and auto-assign
// ─────────────────────────────────────────────────────────────────────────────

/** One assignment cell change: Assigned(categoryId, month) goes from `from` to `to`. */
export interface AssignmentChange {
  month: Month;
  categoryId: string;
  from: Milli;
  to: Milli;
}

/** `"rta"` is Ready to Assign. */
export type MoneyEndpoint = string | "rta";

export type { AutoAssignMode };

export interface AutoAssignOptions {
  month: Month;
  mode: AutoAssignMode;
  /** Category ids to act on. Empty/undefined → all visible categories. */
  selection?: string[];
  /**
   * Underfunded ordering:
   *  - `spec` (default, §6.6): targets in group/category sort order, then upcoming scheduled
   *    transactions, then overspending, then payment-category underfunding.
   *  - `ynab`: YNAB's documented order (overspending, then by due date, then end-of-month targets,
   *    then future-dated targets, then credit card payments; ties top-to-bottom).
   */
  order?: "spec" | "ynab";
  /**
   * Stop when Ready to Assign runs out. Default: true when nothing is selected, false when a
   * selection is given (YNAB funds selected categories fully, even if RTA goes negative).
   */
  capToRta?: boolean;
  /** Budget options to use when the engine must be (re)run. `through` defaults to `month`. */
  budget?: Partial<BudgetOptions>;
}
