/**
 * Read model for the simple Budget screen: every visible normal category as a "bucket" with its monthly
 * goal, what was spent this month and the bar to draw. Uses `getBudgetMonth` for the category tree,
 * targets and the engine's percent-of-income numbers; spending is summed straight from the ledger.
 *
 * Savings buckets (ADR "Buckets: savings buckets") are left out of the groups and the summary and come
 * back in `savings` with their running balance.
 *
 * Not shown: card payment categories, Ready to Assign / Inflow, Uncategorized (reported separately as
 * `uncategorized`), and hidden categories / groups with no transactions this month. Hidden ones that did
 * have spending come back in a last group (`HIDDEN_GROUP_ID`) so their money still counts as spent.
 */
import { sql } from "drizzle-orm";
import { addMonths, lastDayOfMonth, monthOf, today as localToday, type ISODate, type Milli, type Month } from "@homebase/shared";
import type { DbLike } from "../context";
import { getBudgetMonth, type PlanCategory, type TargetView } from "../budget/view";
import {
  bucketBar,
  bucketTotals,
  monthPace,
  monthlyGoalAmount,
  monthlyGoalFromHistory,
  rolloverCarryIn,
  savingsProgress,
  type BucketBar,
  type BucketKind,
  type BucketTotals,
  type GoalHistoryRow,
  type GoalKind,
  type MonthPace,
} from "./math";
import { savingsMonths, savingsSettings } from "./savings";
import { spentByCategory, spentByCategoryMonth, toDay } from "./spending";

export { spentByCategory, spentByCategoryMonth } from "./spending";

export interface BucketGoal {
  type: TargetView["type"];
  /** The stored target amount. */
  targetAmount: Milli;
  /** The amount the bar measures against this month. */
  amount: Milli;
  kind: GoalKind;
  cadence: TargetView["cadence"];
  /** "Set aside $480.00 each month" (core's target label). */
  label: string;
  /** true when the goal is a plain monthly amount the simple editor can change in place. */
  simple: boolean;
}

/** A savings bucket's month (ADR "Buckets: savings buckets"). */
export interface SavingsBucketInfo {
  /** End of the month: carryIn + contributed − spent (negative after overspending). */
  balance: Milli;
  /** Added this month (negative when more was taken out). */
  contributed: Milli;
  /** Net spending this month (refunds reduce it). */
  spent: Milli;
  /** Carried in from last month (the starting balance in the first month); never negative. */
  carryIn: Milli;
  /** Optional target total. */
  target: Milli | null;
  /** balance ÷ target in [0, 1]; null without a target. */
  progress: number | null;
  /** First month that counts. */
  from: Month;
  /** Starting balance (carried into `from`). */
  opening: Milli;
  /** false for months before `from` (everything is 0 then). */
  started: boolean;
}

export interface BucketRow {
  id: string;
  /** 'savings' rows live in `BucketMonth.savings`, never in `groups`. */
  bucketKind: BucketKind;
  /** Savings buckets only. */
  savings: SavingsBucketInfo | null;
  groupId: string;
  name: string;
  icon: string | null;
  goal: BucketGoal | null;
  /** The plain monthly goal (goal.amount), or null when there is no usable goal. */
  goalAmount: Milli | null;
  /** Overflow (rollover) is on for this bucket. */
  rollover: boolean;
  /** First month the rollover counts (null when rollover is off). */
  rolloverFrom: Month | null;
  /** Leftover rolled in from last month (0 when rollover is off; never negative). */
  carryIn: Milli;
  /** What the bar measures against: goalAmount + carryIn (savings goals: the target balance); null without either. */
  budget: Milli | null;
  /** Net outflow this month (refunds reduce it; may be negative after a big refund). */
  spent: Milli;
  remaining: Milli;
  bar: BucketBar;
  /** The engine's Available (for the detail sheet only). */
  available: Milli;
  transactionCount: number;
}

export interface BucketGroup {
  id: string;
  name: string;
  rows: BucketRow[];
  /** Σ budget over rows with a goal (savings goals included). */
  budget: Milli;
  spent: Milli;
}

export interface BucketSavings {
  /** Visible savings buckets in plan order. */
  rows: BucketRow[];
  /** Σ balance at the end of the month. */
  totalSaved: Milli;
  /** Σ contributed this month (negative when more was taken out). */
  addedToSavings: Milli;
  /** Ready to save, as of today; only for the current month (null for other months). */
  ready: ReadyToSave | null;
}

/**
 * Ready to save: money that's in the bank but in no bucket. Computed from real balances rather than
 * this month's income, so leftovers from earlier months count and it can't promise money that isn't
 * there: cash (on-budget accounts, posted, cards subtracted) − what this month's buckets still hold −
 * savings bucket balances.
 */
export interface ReadyToSave {
  /** Σ posted balances of on-budget accounts through today (card debt is negative). */
  cash: Milli;
  /** Σ what's left in this month's spending buckets (overspent buckets hold 0). */
  inBuckets: Milli;
  /** Σ savings bucket balances (negative balances hold 0). */
  inSavings: Milli;
  /** cash − inBuckets − inSavings (negative: the buckets hold more than the bank has). */
  amount: Milli;
}

/** Σ posted (not pending) amounts on on-budget accounts through `today`. */
export async function budgetCash(db: DbLike, today: ISODate): Promise<Milli> {
  const res = await db.execute<{ cash: bigint }>(sql`
    SELECT coalesce(sum(t.amount_milli), 0)::bigint AS cash FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.on_budget AND t.cleared <> 'pending' AND t.date <= ${today}::date`);
  return BigInt(res.rows[0]?.cash ?? 0);
}

/** Ready to save from its parts (see `ReadyToSave`). */
export function readyToSave(cash: Milli, rows: readonly Pick<BucketRow, "budget" | "remaining" | "goal" | "carryIn">[], savingsBalances: readonly Milli[]): ReadyToSave {
  const pos = (v: Milli) => (v > 0n ? v : 0n);
  // spending buckets with a monthly amount (or a rollover carry) hold what's left of it; balance goals hold nothing monthly
  const inBuckets = rows.reduce((a, r) => a + (r.budget !== null && (r.goal?.kind === "monthly" || (!r.goal && r.carryIn > 0n)) ? pos(r.remaining) : 0n), 0n);
  const inSavings = savingsBalances.reduce((a, b) => a + pos(b), 0n);
  return { cash, inBuckets, inSavings, amount: cash - inBuckets - inSavings };
}

export interface BucketMonth {
  month: Month;
  label: string;
  range: { first: Month | null; last: Month };
  groups: BucketGroup[];
  totals: BucketTotals;
  pace: MonthPace;
  /** On-budget spending with no category this month (pending excluded). */
  uncategorized: { count: number; spent: Milli };
  /** Inflows to Ready to Assign this month (the engine's income: on-budget accounts, categorized as Income). */
  income: Milli;
  /** Savings buckets, outside the groups and the summary totals. */
  savings: BucketSavings;
}

interface RolloverRow {
  id: string;
  rollover: boolean;
  from: Month | null;
  opening: Milli;
}

/** Categories with rollover turned on. */
async function rolloverSettings(db: DbLike): Promise<Map<string, RolloverRow>> {
  const res = await db.execute<{ id: string; rollover: boolean; rollover_from: string | Date | null; rollover_opening_milli: bigint }>(sql`
    SELECT id, rollover, rollover_from, rollover_opening_milli FROM categories WHERE rollover AND deleted_at IS NULL`);
  return new Map(res.rows.map((r) => [r.id, { id: r.id, rollover: r.rollover, from: r.rollover_from === null ? null : toDay(r.rollover_from), opening: BigInt(r.rollover_opening_milli) }]));
}

/**
 * carryIn for `month` per rollover bucket: target history and spending for every earlier month since
 * the earliest `rollover_from` are read in two queries, then the carry is walked month by month.
 */
export async function rolloverCarries(db: DbLike, month: Month, settings?: Map<string, RolloverRow>): Promise<Map<string, Milli>> {
  const all = settings ?? (await rolloverSettings(db));
  const out = new Map<string, Milli>();
  const active = [...all.values()].filter((r) => r.rollover && r.from && r.from <= month);
  if (!active.length) return out;
  const prev = addMonths(month, -1);
  const walking = active.filter((r) => r.from! < month);
  const ids = walking.map((r) => r.id);
  const history = new Map<string, GoalHistoryRow[]>();
  let spent = new Map<string, Map<Month, Milli>>();
  if (ids.length) {
    const t = await db.execute<{ category_id: string; effective_from: string | Date; type: GoalHistoryRow["type"]; amount_milli: bigint; cadence: GoalHistoryRow["cadence"]; cadence_every: number; day: number | null; removed: boolean }>(sql`
      SELECT category_id, effective_from, type, amount_milli, cadence, cadence_every, day, removed FROM targets
      WHERE category_id IN ${ids} AND effective_from <= ${prev}::date`);
    for (const r of t.rows) {
      const list = history.get(r.category_id) ?? [];
      list.push({ effectiveFrom: toDay(r.effective_from), removed: r.removed, type: r.type, amount: BigInt(r.amount_milli), cadence: r.cadence, cadenceEvery: Number(r.cadence_every), day: r.day });
      history.set(r.category_id, list);
    }
    const earliest = walking.reduce((a, r) => (r.from! < a ? r.from! : a), prev);
    spent = await spentByCategoryMonth(db, earliest, prev, ids);
  }
  for (const r of active) {
    const h = history.get(r.id) ?? [];
    const s = spent.get(r.id);
    out.set(r.id, rolloverCarryIn({ enabled: true, from: r.from, opening: r.opening }, month, (m) => monthlyGoalFromHistory(h, m), (m) => s?.get(m) ?? 0n));
  }
  return out;
}

/** Uncategorized on-budget spending for the month (no category or the Uncategorized category; not transfers or splits). */
export async function uncategorizedSpending(db: DbLike, month: Month): Promise<{ count: number; spent: Milli }> {
  const end = lastDayOfMonth(month);
  const res = await db.execute<{ n: number; spent: bigint }>(sql`
    SELECT count(*)::int AS n, coalesce(-sum(t.amount_milli) FILTER (WHERE t.amount_milli < 0), 0)::bigint AS spent
    FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL AND a.on_budget AND NOT t.is_split AND NOT t.is_starting_balance AND t.transfer_account_id IS NULL
      AND (t.category_id IS NULL OR c.kind = 'uncategorized') AND t.date >= ${month}::date AND t.date <= ${end}::date`);
  const r = res.rows[0];
  return { count: Number(r?.n ?? 0), spent: BigInt(r?.spent ?? 0) };
}

function goalFor(c: PlanCategory, month: Month): BucketGoal | null {
  const t = c.target;
  if (!t) return null;
  const g = monthlyGoalAmount({ type: t.type, amount: t.amount, cadence: t.cadence, cadenceEvery: t.cadenceEvery, day: t.day }, month, { percentNeeded: t.type === "percent_of_income" ? c.needed : null });
  if (!g) return null;
  const simple = (t.type === "need_set_aside" || t.type === "need_refill" || t.type === "monthly_builder") && (t.cadence === "monthly" || t.cadence === "none") && t.cadenceEvery <= 1;
  return { type: t.type, targetAmount: t.amount, amount: g.amount, kind: g.kind, cadence: t.cadence, label: t.label, simple };
}

/** Group id for hidden buckets that had transactions this month. */
export const HIDDEN_GROUP_ID = "hidden-with-spending";

/** The Budget screen for one month. */
export async function getBucketMonth(db: DbLike, month: Month, opts: { today?: ISODate } = {}): Promise<BucketMonth> {
  const today = opts.today ?? localToday();
  const view = await getBudgetMonth(db, month, { today });
  const spent = await spentByCategory(db, month);
  const uncategorized = await uncategorizedSpending(db, month);
  const rollovers = await rolloverSettings(db);
  const carries = await rolloverCarries(db, month, rollovers);
  const saving = await savingsSettings(db);
  const savingMonths = await savingsMonths(db, month, saving);
  const groups: BucketGroup[] = [];
  const savingsRows: BucketRow[] = [];
  const hiddenUsed = view.hidden.filter((c) => c.kind === "normal" && (spent.get(c.id)?.count ?? 0) > 0);
  const planGroups = hiddenUsed.length
    ? [...view.groups, { id: HIDDEN_GROUP_ID, name: "Hidden, but used this month", sort: Number.MAX_SAFE_INTEGER, hidden: true, isSystem: false, isCreditCardPayments: false, assigned: 0n, activity: 0n, available: 0n, categories: hiddenUsed }]
    : view.groups;
  for (const g of planGroups) {
    if (g.isCreditCardPayments || g.isSystem) continue;
    const rows: BucketRow[] = [];
    for (const c of g.categories) {
      if (c.kind !== "normal" || (c.hidden && g.id !== HIDDEN_GROUP_ID)) continue;
      const s = spent.get(c.id);
      const sp = s?.spent ?? 0n;
      const sv = saving.get(c.id);
      if (sv) {
        const m = savingMonths.get(c.id)!;
        const progress = savingsProgress(m.balance, sv.target);
        savingsRows.push({
          id: c.id,
          groupId: c.groupId,
          name: c.name,
          icon: c.icon,
          bucketKind: "savings",
          savings: { balance: m.balance, contributed: m.contributed, spent: m.spent, carryIn: m.carryIn, target: sv.target, progress, from: sv.from, opening: sv.opening, started: m.started },
          goal: null,
          goalAmount: null,
          rollover: false,
          rolloverFrom: sv.from,
          carryIn: m.carryIn,
          budget: null,
          spent: m.started ? m.spent : sp,
          remaining: m.balance,
          bar: progress === null ? bucketBar(null, 0n) : { state: "under", fill: progress, over: 0, spentRatio: 0, remaining: m.balance },
          available: c.available,
          transactionCount: s?.count ?? 0,
        });
        continue;
      }
      const goal = goalFor(c, month);
      const ro = rollovers.get(c.id);
      // savings (balance) goals don't roll over: their amount is a balance, not a month's money
      const carryIn = ro && goal?.kind !== "balance" ? (carries.get(c.id) ?? 0n) : 0n;
      const goalAmount = goal?.amount ?? null;
      const budget = goal ? (goal.kind === "balance" ? goal.amount : goal.amount + carryIn) : carryIn > 0n ? carryIn : null;
      const bar = bucketBar(budget, sp);
      rows.push({
        id: c.id,
        groupId: c.groupId,
        name: c.name,
        icon: c.icon,
        bucketKind: "spending",
        savings: null,
        goal,
        goalAmount,
        rollover: !!ro,
        rolloverFrom: ro?.from ?? null,
        carryIn,
        budget,
        spent: sp,
        remaining: bar.remaining,
        bar,
        available: c.available,
        transactionCount: s?.count ?? 0,
      });
    }
    if (!rows.length) continue;
    groups.push({
      id: g.id,
      name: g.name,
      rows,
      budget: rows.reduce((a, r) => a + (r.budget ?? 0n), 0n),
      spent: rows.reduce((a, r) => a + r.spent, 0n),
    });
  }
  // a rollover bucket whose goal was removed still has its carry to spend: it counts as monthly money
  const totals = bucketTotals(groups.flatMap((g) => g.rows.map((r) => ({ budget: r.budget, spent: r.spent, kind: r.goal?.kind ?? (r.carryIn > 0n ? ("monthly" as const) : null) }))));
  const income = view.summary.income;
  const current = month === monthOf(today);
  const savings: BucketSavings = {
    rows: savingsRows,
    totalSaved: savingsRows.reduce((a, r) => a + r.savings!.balance, 0n),
    addedToSavings: savingsRows.reduce((a, r) => a + r.savings!.contributed, 0n),
    ready: current ? readyToSave(await budgetCash(db, today), groups.flatMap((g) => g.rows), savingsRows.map((r) => r.savings!.balance)) : null,
  };
  return {
    month,
    label: view.label,
    range: view.range,
    groups,
    totals,
    pace: monthPace(month, today, totals.budget, totals.budgetedSpent),
    uncategorized,
    income,
    savings,
  };
}
