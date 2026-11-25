/**
 * YNAB API v1 plan export (`GET /plans/{plan_id}`) → BudgetSnapshot (§10, §6.9).
 * Used by the golden parity harness and by the importer. Read-only, pure, no network.
 *
 * Accepts the raw response (`{ data: { plan | budget, server_knowledge } }`) or the plan object.
 * Amounts are milliunits (JSON integers) and become bigint.
 */
import { monthOf } from "@homebase/shared";
import type { AccountKind, CategoryKind, Cleared, Frequency } from "@homebase/shared";
import { mapYnabGoal, type YnabGoalFields } from "./targets";
import type {
  BudgetSnapshot,
  EngineAccount,
  EngineAssignment,
  EngineCategory,
  EngineCategoryGroup,
  EngineScheduledTransaction,
  EngineSplit,
  EngineTarget,
  EngineTransaction,
  Milli,
  Month,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Raw YNAB shapes (only the fields we use)
// ─────────────────────────────────────────────────────────────────────────────

export interface YnabAccount {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  deleted?: boolean;
  balance?: number;
}
export interface YnabCategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  internal?: boolean;
  deleted?: boolean;
}
export interface YnabCategory extends YnabGoalFields {
  id: string;
  category_group_id: string;
  name: string;
  hidden: boolean;
  internal?: boolean;
  deleted?: boolean;
  budgeted?: number;
  activity?: number;
  balance?: number;
  goal_under_funded?: number | null;
  goal_overall_left?: number | null;
  goal_percentage_complete?: number | null;
}
export interface YnabMonth {
  month: string;
  to_be_budgeted: number;
  income?: number;
  budgeted?: number;
  activity?: number;
  age_of_money?: number | null;
  deleted?: boolean;
  categories: YnabCategory[];
}
export interface YnabTransaction {
  id: string;
  date: string;
  amount: number;
  cleared: string;
  approved?: boolean;
  account_id: string;
  payee_id?: string | null;
  category_id?: string | null;
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
  deleted?: boolean;
}
export interface YnabSubTransaction {
  id: string;
  transaction_id: string;
  amount: number;
  category_id?: string | null;
  transfer_account_id?: string | null;
  deleted?: boolean;
}
export interface YnabScheduledTransaction {
  id: string;
  date_first?: string;
  date_next: string;
  frequency: string;
  amount: number;
  account_id: string;
  category_id?: string | null;
  transfer_account_id?: string | null;
  deleted?: boolean;
}
export interface YnabScheduledSubTransaction {
  id: string;
  scheduled_transaction_id: string;
  amount: number;
  category_id?: string | null;
  transfer_account_id?: string | null;
  deleted?: boolean;
}
export interface YnabPayee {
  id: string;
  name: string;
  transfer_account_id?: string | null;
  deleted?: boolean;
}
export interface YnabPlan {
  id: string;
  name?: string;
  first_month?: string;
  last_month?: string;
  accounts: YnabAccount[];
  payees?: YnabPayee[];
  category_groups: YnabCategoryGroup[];
  categories: YnabCategory[];
  months: YnabMonth[];
  transactions: YnabTransaction[];
  subtransactions?: YnabSubTransaction[];
  scheduled_transactions?: YnabScheduledTransaction[];
  scheduled_subtransactions?: YnabScheduledSubTransaction[];
}

/** YNAB's own per-month, per-category figures, used as the parity oracle. */
export interface YnabExpectedMonth {
  month: Month;
  toBeBudgeted: Milli;
  ageOfMoney: number | null;
  income: Milli | null;
  budgeted: Milli | null;
  activity: Milli | null;
  categories: Record<string, { budgeted: Milli; activity: Milli; balance: Milli; goalUnderFunded: Milli | null; goalType: string | null }>;
}

export interface YnabMapResult {
  snapshot: BudgetSnapshot;
  expected: YnabExpectedMonth[];
  planId: string;
  planName: string | null;
  serverKnowledge: number | null;
  firstMonth: Month | null;
  lastMonth: Month | null;
  /** Category id → display name, for diff tables. */
  categoryNames: Record<string, string>;
  warnings: string[];
}

export interface YnabMapOptions {
  /** Month used as effectiveFrom for goals with no goal_creation_month. */
  fallbackGoalMonth?: Month;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers (no zod: the engine depends only on @homebase/shared)
// ─────────────────────────────────────────────────────────────────────────────

function fail(path: string, msg: string): never {
  throw new Error(`ynabPlanToSnapshot: ${path}: ${msg}`);
}
function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function arr(o: Record<string, unknown>, k: string, path: string, optional = false): Record<string, unknown>[] {
  const v = o[k];
  if (v === undefined || v === null) {
    if (optional) return [];
    fail(`${path}.${k}`, "missing array");
  }
  if (!Array.isArray(v)) fail(`${path}.${k}`, "not an array");
  v.forEach((x, i) => {
    if (!isObj(x)) fail(`${path}.${k}[${i}]`, "not an object");
  });
  return v as Record<string, unknown>[];
}
function str(o: Record<string, unknown>, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== "string") fail(`${path}.${k}`, "expected string");
  return v;
}
function milli(v: unknown, path: string): Milli {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  fail(path, `expected integer milliunits, got ${String(v)}`);
}
function optMilli(v: unknown, path: string): Milli | null {
  return v === undefined || v === null ? null : milli(v, path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Enum mapping
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT_KIND: Record<string, AccountKind> = {
  checking: "checking",
  savings: "savings",
  cash: "cash",
  creditCard: "credit_card",
  lineOfCredit: "line_of_credit",
  otherAsset: "other",
  otherLiability: "loan",
  mortgage: "mortgage",
  autoLoan: "loan",
  studentLoan: "loan",
  personalLoan: "loan",
  medicalDebt: "loan",
  otherDebt: "loan",
};

const FREQUENCY: Record<string, Frequency> = {
  never: "once",
  daily: "daily",
  weekly: "weekly",
  everyOtherWeek: "biweekly",
  twiceAMonth: "twice_monthly",
  every4Weeks: "every_4_weeks",
  monthly: "monthly",
  everyOtherMonth: "every_other_month",
  every3Months: "every_3_months",
  every4Months: "every_4_months",
  twiceAYear: "twice_yearly",
  yearly: "yearly",
  everyOtherYear: "every_other_year",
};

const CLEARED: Record<string, Cleared> = { cleared: "cleared", uncleared: "uncleared", reconciled: "reconciled", pending: "pending" };

const RTA_NAMES = new Set(["inflow: ready to assign", "inflow: to be budgeted", "ready to assign", "to be budgeted", "income: ready to assign"]);
const INTERNAL_GROUP = "internal master category";
const CC_GROUP = "credit card payments";
const LIABILITY_TYPES = new Set(["creditCard", "lineOfCredit", "otherLiability", "mortgage", "autoLoan", "studentLoan", "personalLoan", "medicalDebt", "otherDebt"]);

/** Unwrap `{ data: { plan | budget } }`, `{ plan }`, or a bare plan. */
export function unwrapYnabPlan(raw: unknown): { plan: Record<string, unknown>; serverKnowledge: number | null } {
  if (!isObj(raw)) fail("$", "not an object");
  const data = isObj(raw.data) ? raw.data : raw;
  const plan = isObj(data.plan) ? data.plan : isObj(data.budget) ? data.budget : data;
  if (!Array.isArray(plan.accounts) || !Array.isArray(plan.categories)) fail("$", "no plan found (expected data.plan or data.budget with accounts and categories)");
  const sk = typeof data.server_knowledge === "number" ? data.server_knowledge : null;
  return { plan, serverKnowledge: sk };
}

/** Map a raw YNAB plan export to a BudgetSnapshot plus YNAB's own monthly figures. */
export function ynabPlanToSnapshot(raw: unknown, opts: YnabMapOptions = {}): YnabMapResult {
  const { plan, serverKnowledge } = unwrapYnabPlan(raw);
  const warnings: string[] = [];
  const P = "plan";

  // accounts
  const rawAccounts = arr(plan, "accounts", P);
  const accounts: EngineAccount[] = rawAccounts.map((a, i) => {
    const p = `${P}.accounts[${i}]`;
    const type = str(a, "type", p);
    const kind = ACCOUNT_KIND[type];
    if (!kind) warnings.push(`${p}: unknown account type ${type}; mapped to other`);
    return { id: str(a, "id", p), name: str(a, "name", p), kind: kind ?? "other", onBudget: a.on_budget === true, closed: a.closed === true || a.deleted === true };
  });
  const accountTypes = new Map(rawAccounts.map((a) => [String(a.id), String(a.type)]));

  // groups
  const rawGroups = arr(plan, "category_groups", P);
  const groupName = new Map<string, string>();
  const groupInternal = new Map<string, boolean>();
  const groups: EngineCategoryGroup[] = rawGroups.map((g, i) => {
    const p = `${P}.category_groups[${i}]`;
    const id = str(g, "id", p);
    const name = str(g, "name", p);
    groupName.set(id, name);
    groupInternal.set(id, g.internal === true || name.toLowerCase() === INTERNAL_GROUP);
    return { id, name, sort: i, hidden: g.hidden === true || g.deleted === true };
  });

  // card name → account id (on-budget liabilities), for linking payment categories
  const cardByName = new Map<string, string>();
  for (const a of rawAccounts) {
    if (a.on_budget === true && LIABILITY_TYPES.has(String(a.type))) {
      const n = String(a.name);
      if (!cardByName.has(n) || a.deleted !== true) cardByName.set(n, String(a.id));
    }
  }

  // categories
  const rawCats = arr(plan, "categories", P);
  const categoryNames: Record<string, string> = {};
  const targets: EngineTarget[] = [];
  const categories: EngineCategory[] = rawCats.map((c, i) => {
    const p = `${P}.categories[${i}]`;
    const id = str(c, "id", p);
    const name = str(c, "name", p);
    const gid = str(c, "category_group_id", p);
    categoryNames[id] = name;
    const gname = (groupName.get(gid) ?? "").toLowerCase();
    const internal = c.internal === true || groupInternal.get(gid) === true;
    let kind: CategoryKind = "normal";
    let linkedAccountId: string | null = null;
    if (RTA_NAMES.has(name.toLowerCase()) && (internal || gname === INTERNAL_GROUP)) kind = "internal_rta";
    else if (internal && name.toLowerCase() === "uncategorized") kind = "uncategorized";
    else if (gname === CC_GROUP && c.internal !== true) {
      linkedAccountId = cardByName.get(name) ?? null;
      if (linkedAccountId) kind = "cc_payment";
      else warnings.push(`${p}: credit card payment category "${name}" matches no on-budget card; mapped as normal`);
    }
    const goal = mapYnabGoal(c as unknown as YnabGoalFields, opts.fallbackGoalMonth);
    if (goal && c.deleted !== true) targets.push(goal);
    return { id, groupId: gid, name, kind, linkedAccountId, hidden: c.hidden === true || internal, sort: i, deleted: c.deleted === true };
  });
  if (!categories.some((c) => c.kind === "internal_rta")) warnings.push("no 'Inflow: Ready to Assign' category found");

  // payees (Starting Balance detection)
  const payeeName = new Map(arr(plan, "payees", P, true).map((p) => [String(p.id), String(p.name)]));

  // subtransactions
  const subsByTxn = new Map<string, EngineSplit[]>();
  arr(plan, "subtransactions", P, true).forEach((s, i) => {
    if (s.deleted === true) return;
    const p = `${P}.subtransactions[${i}]`;
    const tid = str(s, "transaction_id", p);
    const list = subsByTxn.get(tid) ?? [];
    list.push({ id: str(s, "id", p), amount: milli(s.amount, `${p}.amount`), categoryId: (s.category_id as string | null) ?? null, transferAccountId: (s.transfer_account_id as string | null) ?? null });
    subsByTxn.set(tid, list);
  });

  // transactions
  const transactions: EngineTransaction[] = arr(plan, "transactions", P).map((t, i) => {
    const p = `${P}.transactions[${i}]`;
    const id = str(t, "id", p);
    const splits = subsByTxn.get(id);
    const cleared = CLEARED[String(t.cleared)];
    if (!cleared) warnings.push(`${p}: unknown cleared status ${String(t.cleared)}`);
    const payee = t.payee_id ? payeeName.get(String(t.payee_id)) : undefined;
    return {
      id,
      accountId: str(t, "account_id", p),
      date: str(t, "date", p),
      amount: milli(t.amount, `${p}.amount`),
      categoryId: splits && splits.length ? null : ((t.category_id as string | null) ?? null),
      transferAccountId: (t.transfer_account_id as string | null) ?? null,
      cleared: cleared ?? "cleared",
      importOrder: i,
      splits: splits && splits.length ? splits : undefined,
      deleted: t.deleted === true,
      isStartingBalance: payee === "Starting Balance",
    };
  });

  // assignments + expected figures from months
  const assignments: EngineAssignment[] = [];
  const expected: YnabExpectedMonth[] = [];
  arr(plan, "months", P).forEach((m, i) => {
    const p = `${P}.months[${i}]`;
    if (m.deleted === true) return;
    const month = monthOf(str(m, "month", p));
    const cats: YnabExpectedMonth["categories"] = {};
    arr(m, "categories", p).forEach((c, j) => {
      const cp = `${p}.categories[${j}]`;
      const id = str(c, "id", cp);
      const budgeted = milli(c.budgeted ?? 0, `${cp}.budgeted`);
      if (budgeted !== 0n) assignments.push({ month, categoryId: id, assigned: budgeted });
      cats[id] = {
        budgeted,
        activity: milli(c.activity ?? 0, `${cp}.activity`),
        balance: milli(c.balance ?? 0, `${cp}.balance`),
        goalUnderFunded: optMilli(c.goal_under_funded, `${cp}.goal_under_funded`),
        goalType: (c.goal_type as string | null) ?? null,
      };
    });
    expected.push({
      month,
      toBeBudgeted: milli(m.to_be_budgeted ?? 0, `${p}.to_be_budgeted`),
      ageOfMoney: typeof m.age_of_money === "number" ? m.age_of_money : null,
      income: optMilli(m.income, `${p}.income`),
      budgeted: optMilli(m.budgeted, `${p}.budgeted`),
      activity: optMilli(m.activity, `${p}.activity`),
      categories: cats,
    });
  });
  expected.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

  // scheduled
  const schedSubs = new Map<string, { amount: Milli; categoryId: string | null; transferAccountId: string | null }[]>();
  arr(plan, "scheduled_subtransactions", P, true).forEach((s, i) => {
    if (s.deleted === true) return;
    const p = `${P}.scheduled_subtransactions[${i}]`;
    const sid = str(s, "scheduled_transaction_id", p);
    const list = schedSubs.get(sid) ?? [];
    list.push({ amount: milli(s.amount, `${p}.amount`), categoryId: (s.category_id as string | null) ?? null, transferAccountId: (s.transfer_account_id as string | null) ?? null });
    schedSubs.set(sid, list);
  });
  const scheduled: EngineScheduledTransaction[] = arr(plan, "scheduled_transactions", P, true).map((s, i) => {
    const p = `${P}.scheduled_transactions[${i}]`;
    const id = str(s, "id", p);
    const freq = FREQUENCY[String(s.frequency)];
    if (!freq) warnings.push(`${p}: unknown frequency ${String(s.frequency)}; treated as once`);
    const splits = schedSubs.get(id);
    return {
      id,
      accountId: str(s, "account_id", p),
      categoryId: (s.category_id as string | null) ?? null,
      transferAccountId: (s.transfer_account_id as string | null) ?? null,
      amount: milli(s.amount, `${p}.amount`),
      frequency: freq ?? "once",
      nextDate: str(s, "date_next", p),
      endDate: null,
      splits: splits && splits.length ? splits : undefined,
      deleted: s.deleted === true,
    };
  });

  // sanity: payment categories should link to liability accounts
  for (const c of categories) if (c.kind === "cc_payment" && c.linkedAccountId && !LIABILITY_TYPES.has(accountTypes.get(c.linkedAccountId) ?? "")) warnings.push(`payment category ${c.id} links to non-liability account`);

  const months = expected.map((e) => e.month);
  return {
    snapshot: { accounts, groups, categories, transactions, assignments, targets, scheduled },
    expected,
    planId: typeof plan.id === "string" ? plan.id : "",
    planName: typeof plan.name === "string" ? plan.name : null,
    serverKnowledge,
    firstMonth: months[0] ?? null,
    lastMonth: months[months.length - 1] ?? null,
    categoryNames,
    warnings,
  };
}
