/**
 * YNAB (§7.9, §10) — migration only, GET only. Base https://api.ynab.com/v1, /plans/... paths.
 * 200 requests/hour per token (sliding window limiter below).
 */
import { z } from "zod";
import type { AccountKind, Cadence, CategoryKind, Cleared, Flag, Frequency, ISODate, Milli, Month, TargetType } from "@homebase/shared";
import { createHttpClient, defaultSleep, type HttpClient, type HttpClientOptions } from "./http";
import { ConnectorError } from "./types";

export const YNAB_BASE_URL = "https://api.ynab.com/v1";
export const YNAB_HOURLY_LIMIT = 200;

// ---------------------------------------------------------------------------------------------------------------------
// Rate limiter (pure-ish, injectable clock)

export interface RateLimiter {
  /** Resolve when a slot is free (sleeping if needed), then consume it. */
  acquire(): Promise<void>;
  /** Consume a slot if free; false otherwise. */
  tryAcquire(): boolean;
  /** Slots left in the current window. */
  remaining(): number;
  /** Sync with server header "X-Rate-Limit: 36/200". */
  observeHeader(value: string | null): void;
}

export function createSlidingWindowLimiter(o: { limit?: number; windowMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): RateLimiter {
  const limit = o.limit ?? YNAB_HOURLY_LIMIT;
  const windowMs = o.windowMs ?? 3_600_000;
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? defaultSleep;
  let stamps: number[] = [];
  let serverUsed = 0;
  const prune = () => {
    const cutoff = now() - windowMs;
    stamps = stamps.filter((t) => t > cutoff);
  };
  const used = () => Math.max(stamps.length, serverUsed);
  const self: RateLimiter = {
    remaining() {
      prune();
      return Math.max(0, limit - used());
    },
    tryAcquire() {
      prune();
      if (used() >= limit) return false;
      stamps.push(now());
      if (serverUsed > 0) serverUsed++;
      return true;
    },
    async acquire() {
      for (let guard = 0; guard < 10_000; guard++) {
        if (self.tryAcquire()) return;
        const oldest = stamps[0] ?? now();
        const wait = Math.max(1000, oldest + windowMs - now() + 1);
        serverUsed = 0; // server count is stale once we've waited
        await sleep(wait);
      }
      throw new ConnectorError("rate_limited", "YNAB rate limiter could not acquire a slot", { provider: "ynab" });
    },
    observeHeader(value) {
      const m = value ? /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim()) : null;
      if (m) serverUsed = Number(m[1]);
    },
  };
  return self;
}

// ---------------------------------------------------------------------------------------------------------------------
// Client (GET only)

export interface YnabClient {
  getPlans(): Promise<{ plans: Array<{ id: string; name: string; last_modified_on?: string | null }>; defaultPlanId?: string | null }>;
  findPlanByName(name: string): Promise<{ id: string; name: string } | undefined>;
  /** Full export (or delta when lastKnowledgeOfServer is given). Returns `data` (has .plan and .server_knowledge). */
  getPlanExport(planId: string, lastKnowledgeOfServer?: number): Promise<YnabPlanEnvelope>;
  getMonth(planId: string, month: Month): Promise<unknown>;
  getMonths(planId: string, lastKnowledgeOfServer?: number): Promise<unknown>;
  getAccounts(planId: string, lastKnowledgeOfServer?: number): Promise<unknown>;
  getCategories(planId: string, lastKnowledgeOfServer?: number): Promise<unknown>;
  getTransactions(planId: string, o?: { sinceDate?: ISODate; lastKnowledgeOfServer?: number }): Promise<unknown>;
  getScheduledTransactions(planId: string, lastKnowledgeOfServer?: number): Promise<unknown>;
  getPayees(planId: string, lastKnowledgeOfServer?: number): Promise<unknown>;
  getPayeeLocations(planId: string): Promise<unknown>;
}

export interface YnabPlanEnvelope {
  plan: unknown;
  server_knowledge: number;
}

export function createYnabClient(token: string, o: { http?: HttpClientOptions; limiter?: RateLimiter; baseUrl?: string } = {}): YnabClient {
  const limiter = o.limiter ?? createSlidingWindowLimiter();
  const base = o.baseUrl ?? YNAB_BASE_URL;
  const http: HttpClient = createHttpClient({
    ...(o.http ?? {}),
    provider: "ynab",
    secrets: [...(o.http?.secrets ?? []), token],
    headers: { ...(o.http?.headers ?? {}), authorization: `Bearer ${token}` },
    beforeRequest: async (req) => {
      await o.http?.beforeRequest?.(req);
      await limiter.acquire();
    },
  });
  const lk = (n?: number) => (n !== undefined ? { last_knowledge_of_server: n } : {});
  async function data(path: string, query: Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    const res = await http.get(`${base}${path}`, { query });
    limiter.observeHeader(res.headers.get("x-rate-limit"));
    let j: unknown;
    try {
      j = JSON.parse(await res.text());
    } catch (e) {
      throw new ConnectorError("parse", `YNAB ${path} returned invalid JSON`, { provider: "ynab", cause: e });
    }
    const d = (j as { data?: unknown }).data;
    if (!d || typeof d !== "object") throw new ConnectorError("parse", `YNAB ${path}: missing data envelope`, { provider: "ynab" });
    return d as Record<string, unknown>;
  }
  const p = (planId: string) => `/plans/${encodeURIComponent(planId)}`;
  const client: YnabClient = {
    async getPlans() {
      const d = await data("/plans");
      const plans = (d.plans ?? d.budgets ?? []) as Array<{ id: string; name: string; last_modified_on?: string | null }>;
      const def = (d.default_plan ?? d.default_budget) as { id?: string } | null | undefined;
      return { plans, defaultPlanId: def?.id ?? null };
    },
    async findPlanByName(name) {
      const { plans } = await client.getPlans();
      return plans.find((x) => x.name === name);
    },
    async getPlanExport(planId, k) {
      const d = await data(p(planId), lk(k));
      return { plan: d.plan ?? d.budget, server_knowledge: Number(d.server_knowledge ?? 0) };
    },
    getMonth: (planId, month) => data(`${p(planId)}/months/${encodeURIComponent(month)}`),
    getMonths: (planId, k) => data(`${p(planId)}/months`, lk(k)),
    getAccounts: (planId, k) => data(`${p(planId)}/accounts`, lk(k)),
    getCategories: (planId, k) => data(`${p(planId)}/categories`, lk(k)),
    getTransactions: (planId, q = {}) => data(`${p(planId)}/transactions`, { since_date: q.sinceDate, ...lk(q.lastKnowledgeOfServer) }),
    getScheduledTransactions: (planId, k) => data(`${p(planId)}/scheduled_transactions`, lk(k)),
    getPayees: (planId, k) => data(`${p(planId)}/payees`, lk(k)),
    getPayeeLocations: (planId) => data(`${p(planId)}/payee_locations`),
  };
  return client;
}

// ---------------------------------------------------------------------------------------------------------------------
// Mapping: plan export → normalized import bundle

const id = z.string();
const nid = z.string().nullish();
const milli = z.number().int().nullish();

const YAccount = z.looseObject({ id, name: z.string(), type: z.string(), on_budget: z.boolean(), closed: z.boolean(), note: nid, balance: milli, cleared_balance: milli, uncleared_balance: milli, transfer_payee_id: nid, deleted: z.boolean().default(false) });
const YGroup = z.looseObject({ id, name: z.string(), hidden: z.boolean().default(false), deleted: z.boolean().default(false) });
const YCategory = z.looseObject({
  id,
  category_group_id: id,
  name: z.string(),
  hidden: z.boolean().default(false),
  internal: z.boolean().nullish(),
  note: nid,
  budgeted: milli,
  activity: milli,
  balance: milli,
  deleted: z.boolean().default(false),
  goal_type: z.string().nullish(),
  goal_needs_whole_amount: z.boolean().nullish(),
  goal_day: z.number().int().nullish(),
  goal_cadence: z.number().int().nullish(),
  goal_cadence_frequency: z.number().int().nullish(),
  goal_creation_month: nid,
  goal_target: milli,
  goal_target_date: nid,
  goal_target_month: nid,
  goal_snoozed_at: nid,
  goal_under_funded: milli,
  goal_overall_left: milli,
  goal_percentage_complete: z.number().nullish(),
});
const YPayee = z.looseObject({ id, name: z.string(), transfer_account_id: nid, deleted: z.boolean().default(false) });
const YTxn = z.looseObject({
  id,
  date: z.string(),
  amount: z.number().int(),
  memo: nid,
  cleared: z.string(),
  approved: z.boolean(),
  flag_color: nid,
  flag_name: nid,
  account_id: id,
  payee_id: nid,
  category_id: nid,
  transfer_account_id: nid,
  transfer_transaction_id: nid,
  matched_transaction_id: nid,
  import_id: nid,
  import_payee_name: nid,
  import_payee_name_original: nid,
  deleted: z.boolean().default(false),
  subtransactions: z.array(z.unknown()).nullish(),
});
const YSub = z.looseObject({ id, transaction_id: id, amount: z.number().int(), memo: nid, payee_id: nid, category_id: nid, transfer_account_id: nid, transfer_transaction_id: nid, deleted: z.boolean().default(false) });
const YSched = z.looseObject({ id, date_first: z.string(), date_next: z.string(), frequency: z.string(), amount: z.number().int(), memo: nid, flag_color: nid, flag_name: nid, account_id: id, payee_id: nid, category_id: nid, transfer_account_id: nid, deleted: z.boolean().default(false), subtransactions: z.array(z.unknown()).nullish() });
const YSchedSub = z.looseObject({ id, scheduled_transaction_id: id, amount: z.number().int(), memo: nid, payee_id: nid, category_id: nid, transfer_account_id: nid, deleted: z.boolean().default(false) });
const YMonth = z.looseObject({ month: z.string(), note: nid, income: milli, budgeted: milli, activity: milli, to_be_budgeted: milli, age_of_money: z.number().nullish(), deleted: z.boolean().default(false), categories: z.array(z.unknown()).nullish() });

const YPlan = z.looseObject({
  id,
  name: z.string(),
  last_modified_on: nid,
  first_month: nid,
  last_month: nid,
  accounts: z.array(z.unknown()).nullish(),
  payees: z.array(z.unknown()).nullish(),
  category_groups: z.array(z.unknown()).nullish(),
  categories: z.array(z.unknown()).nullish(),
  months: z.array(z.unknown()).nullish(),
  transactions: z.array(z.unknown()).nullish(),
  subtransactions: z.array(z.unknown()).nullish(),
  scheduled_transactions: z.array(z.unknown()).nullish(),
  scheduled_subtransactions: z.array(z.unknown()).nullish(),
});

export interface YnabImportAccount {
  ynabId: string;
  name: string;
  ynabType: string;
  kind: AccountKind;
  onBudget: boolean;
  closed: boolean;
  deleted: boolean;
  balance: Milli;
  clearedBalance: Milli;
  note?: string;
  transferPayeeId?: string;
}
export interface YnabImportGroup {
  ynabId: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
  isInternal: boolean;
  isCreditCardPayments: boolean;
}
export interface YnabImportCategory {
  ynabId: string;
  groupYnabId: string;
  /** Emoji kept as part of the name (§10). */
  name: string;
  hidden: boolean;
  deleted: boolean;
  note?: string;
  kind: CategoryKind;
  /** For cc_payment categories: the credit card account it belongs to. */
  linkedAccountYnabId?: string;
  budgeted: Milli;
  activity: Milli;
  balance: Milli;
}
export interface YnabImportTarget {
  categoryYnabId: string;
  type: TargetType;
  ynabGoalType: string;
  amount: Milli;
  cadence: Cadence;
  /** Every N units of the cadence (months for every_n_months, weeks for weekly, years for yearly). */
  cadenceFrequency: number;
  ynabCadence: number | null;
  ynabCadenceFrequency: number | null;
  /** Weekly: 0 = Sunday. Otherwise day of month; null = last day. */
  day: number | null;
  targetDate: ISODate | null;
  /** §6.5: imported targets get effective_from = goal_creation_month. */
  effectiveFrom: Month | null;
  snoozedAt: string | null;
  needsWholeAmount: boolean | null;
  /** YNAB's computed values for parity checks (fixture snapshot month only). */
  ynabUnderFunded: Milli | null;
  ynabOverallLeft: Milli | null;
}
export interface YnabImportSubtransaction {
  ynabId: string;
  amount: Milli;
  memo?: string;
  payeeYnabId?: string;
  categoryYnabId?: string;
  transferAccountYnabId?: string;
  transferPairYnabId?: string;
  deleted: boolean;
}
export interface YnabImportTransaction {
  ynabId: string;
  accountYnabId: string;
  date: ISODate;
  amount: Milli;
  memo?: string;
  cleared: Cleared;
  approved: boolean;
  flag: Flag | null;
  flagName?: string;
  payeeYnabId?: string;
  payeeName?: string;
  categoryYnabId?: string;
  transferAccountYnabId?: string;
  /** YNAB transfer_transaction_id → transfer_pair_id. */
  transferPairYnabId?: string;
  matchedTransactionYnabId?: string;
  importId?: string;
  importPayeeName?: string;
  deleted: boolean;
  isSplit: boolean;
  subtransactions: YnabImportSubtransaction[];
}
export interface YnabImportScheduled {
  ynabId: string;
  accountYnabId: string;
  dateFirst: ISODate;
  dateNext: ISODate;
  frequency: Frequency;
  ynabFrequency: string;
  amount: Milli;
  memo?: string;
  flag: Flag | null;
  payeeYnabId?: string;
  categoryYnabId?: string;
  transferAccountYnabId?: string;
  deleted: boolean;
  subtransactions: Array<{ ynabId: string; amount: Milli; memo?: string; payeeYnabId?: string; categoryYnabId?: string; transferAccountYnabId?: string; deleted: boolean }>;
}
export interface YnabImportPayee {
  ynabId: string;
  name: string;
  transferAccountYnabId?: string;
  deleted: boolean;
}
export interface YnabMonthAssignment {
  month: Month;
  categoryYnabId: string;
  budgeted: Milli;
  /** YNAB-computed, for parity checks. */
  activity: Milli;
  balance: Milli;
}
export interface YnabMonthSummary {
  month: Month;
  note?: string;
  income: Milli;
  budgeted: Milli;
  activity: Milli;
  toBeBudgeted: Milli;
  ageOfMoney: number | null;
  deleted: boolean;
}

export interface YnabImportBundle {
  plan: { ynabId: string; name: string; lastModifiedOn: string | null; firstMonth: Month | null; lastMonth: Month | null };
  serverKnowledge: number | null;
  accounts: YnabImportAccount[];
  groups: YnabImportGroup[];
  categories: YnabImportCategory[];
  targets: YnabImportTarget[];
  transactions: YnabImportTransaction[];
  scheduled: YnabImportScheduled[];
  payees: YnabImportPayee[];
  monthAssignments: YnabMonthAssignment[];
  months: YnabMonthSummary[];
  /** System categories by role. */
  system: { readyToAssignCategoryId?: string; uncategorizedCategoryId?: string; creditCardPaymentsGroupId?: string; internalGroupId?: string };
  warnings: string[];
}

export const YNAB_ACCOUNT_KIND: Record<string, AccountKind> = {
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

export const YNAB_FREQUENCY: Record<string, Frequency> = {
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

const FLAG_SET = new Set<string>(["red", "orange", "yellow", "green", "blue", "purple"]);
const toFlag = (f: string | null | undefined): Flag | null => (f && FLAG_SET.has(f) ? (f as Flag) : null);
const toCleared = (c: string): Cleared => (c === "cleared" || c === "reconciled" || c === "uncleared" ? c : "uncleared");
const m = (n: number | null | undefined): Milli => BigInt(n ?? 0);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined || (typeof v === "string" && v === "") ? undefined : v);

/** §10 goal_type mapping. */
export function mapGoalType(goalType: string, needsWholeAmount: boolean | null | undefined): TargetType | null {
  switch (goalType) {
    case "NEED":
      return needsWholeAmount === true ? "need_set_aside" : "need_refill";
    case "TB":
      return "balance";
    case "TBD":
      return "balance_by_date";
    case "MF":
      return "monthly_builder";
    case "DEBT":
      return "debt";
    default:
      return null;
  }
}

/** §6.5 cadence mapping: 0 none, 1 monthly×N, 2 weekly×N, 3–12 every 2–11 months, 13 yearly×N, 14 every 2 years. */
export function mapGoalCadence(cadence: number | null | undefined, frequency: number | null | undefined): { cadence: Cadence; frequency: number } {
  const f = frequency && frequency > 0 ? frequency : 1;
  if (cadence === null || cadence === undefined || cadence === 0) return { cadence: "none", frequency: 1 };
  if (cadence === 1) return f === 1 ? { cadence: "monthly", frequency: 1 } : { cadence: "every_n_months", frequency: f };
  if (cadence === 2) return { cadence: "weekly", frequency: f };
  if (cadence >= 3 && cadence <= 12) return { cadence: "every_n_months", frequency: cadence - 1 };
  if (cadence === 13) return { cadence: "yearly", frequency: f };
  if (cadence === 14) return { cadence: "yearly", frequency: 2 };
  return { cadence: "none", frequency: 1 };
}

const isRtaName = (n: string) => /^(inflow:\s*ready to assign|to be budgeted|ready to assign)$/i.test(n.trim());
const isUncatName = (n: string) => /^uncategori[sz]ed$/i.test(n.trim());
const isCcGroupName = (n: string) => /^credit card payments$/i.test(n.trim());
const isInternalGroupName = (n: string) => /^internal master category$/i.test(n.trim());

function parseList<T extends z.ZodType>(schema: T, list: unknown[] | null | undefined, label: string, warnings: string[]): z.infer<T>[] {
  const out: z.infer<T>[] = [];
  (list ?? []).forEach((x, i) => {
    const r = schema.safeParse(x);
    if (r.success) out.push(r.data);
    else warnings.push(`${label}[${i}] skipped: ${r.error.issues[0]?.message ?? "invalid"}`);
  });
  return out;
}

/**
 * Map a YNAB plan export (`data` envelope, `{ plan }`, or the bare plan object) to a normalized bundle.
 * Works for full exports and for `last_knowledge_of_server` deltas (deleted rows are kept with deleted=true).
 */
export function mapYnabPlan(input: unknown): YnabImportBundle {
  const env = (input ?? {}) as Record<string, unknown>;
  const planRaw = (env.plan ?? env.budget ?? (env.data as Record<string, unknown> | undefined)?.plan ?? (env.data as Record<string, unknown> | undefined)?.budget ?? input) as unknown;
  const sk = env.server_knowledge ?? (env.data as Record<string, unknown> | undefined)?.server_knowledge;
  const pr = YPlan.safeParse(planRaw);
  if (!pr.success) throw new ConnectorError("parse", "Not a YNAB plan export", { provider: "ynab" });
  const plan = pr.data;
  const warnings: string[] = [];

  const accountsRaw = parseList(YAccount, plan.accounts, "accounts", warnings);
  const groupsRaw = parseList(YGroup, plan.category_groups, "category_groups", warnings);
  const catsRaw = parseList(YCategory, plan.categories, "categories", warnings);
  const payeesRaw = parseList(YPayee, plan.payees, "payees", warnings);
  const txRaw = parseList(YTxn, plan.transactions, "transactions", warnings);
  const subRaw = parseList(YSub, plan.subtransactions, "subtransactions", warnings);
  const schedRaw = parseList(YSched, plan.scheduled_transactions, "scheduled_transactions", warnings);
  const schedSubRaw = parseList(YSchedSub, plan.scheduled_subtransactions, "scheduled_subtransactions", warnings);
  const monthsRaw = parseList(YMonth, plan.months, "months", warnings);

  const system: YnabImportBundle["system"] = {};

  const accounts: YnabImportAccount[] = accountsRaw.map((a) => {
    const kind = YNAB_ACCOUNT_KIND[a.type] ?? "other";
    if (!YNAB_ACCOUNT_KIND[a.type]) warnings.push(`account ${a.name}: unknown YNAB type ${a.type}`);
    const out: YnabImportAccount = { ynabId: a.id, name: a.name, ynabType: a.type, kind, onBudget: a.on_budget, closed: a.closed, deleted: a.deleted, balance: m(a.balance), clearedBalance: m(a.cleared_balance) };
    if (opt(a.note)) out.note = a.note!;
    if (opt(a.transfer_payee_id)) out.transferPayeeId = a.transfer_payee_id!;
    return out;
  });

  const groups: YnabImportGroup[] = groupsRaw.map((g) => {
    const isCc = isCcGroupName(g.name);
    const isInternal = isInternalGroupName(g.name);
    if (isCc) system.creditCardPaymentsGroupId = g.id;
    if (isInternal) system.internalGroupId = g.id;
    return { ynabId: g.id, name: g.name, hidden: g.hidden, deleted: g.deleted, isInternal, isCreditCardPayments: isCc };
  });
  const groupById = new Map(groups.map((g) => [g.ynabId, g]));

  // Card accounts by name for cc_payment linking (YNAB names the payment category after the account).
  const cardAccounts = accounts.filter((a) => a.kind === "credit_card" || a.kind === "line_of_credit");
  const cardByName = new Map(cardAccounts.map((a) => [a.name.trim().toLowerCase(), a]));

  const categories: YnabImportCategory[] = catsRaw.map((c) => {
    const g = groupById.get(c.category_group_id);
    let kind: CategoryKind = "normal";
    const internalish = c.internal === true || g?.isInternal === true;
    if (isRtaName(c.name) && internalish) {
      kind = "internal_rta";
      system.readyToAssignCategoryId = c.id;
    } else if (isUncatName(c.name) && internalish) {
      kind = "uncategorized";
      system.uncategorizedCategoryId = c.id;
    } else if (g?.isCreditCardPayments) kind = "cc_payment";
    const out: YnabImportCategory = { ynabId: c.id, groupYnabId: c.category_group_id, name: c.name, hidden: c.hidden, deleted: c.deleted, kind, budgeted: m(c.budgeted), activity: m(c.activity), balance: m(c.balance) };
    if (opt(c.note)) out.note = c.note!;
    if (kind === "cc_payment") {
      const card = cardByName.get(c.name.trim().toLowerCase());
      if (card) out.linkedAccountYnabId = card.ynabId;
      else warnings.push(`cc_payment category "${c.name}" has no matching credit card account`);
    }
    return out;
  });

  const targets: YnabImportTarget[] = [];
  for (const c of catsRaw) {
    if (!c.goal_type || c.deleted) continue;
    const type = mapGoalType(c.goal_type, c.goal_needs_whole_amount);
    if (!type) {
      warnings.push(`category ${c.name}: unknown goal_type ${c.goal_type}`);
      continue;
    }
    const cad = mapGoalCadence(c.goal_cadence, c.goal_cadence_frequency);
    targets.push({
      categoryYnabId: c.id,
      type,
      ynabGoalType: c.goal_type,
      amount: m(c.goal_target),
      cadence: cad.cadence,
      cadenceFrequency: cad.frequency,
      ynabCadence: c.goal_cadence ?? null,
      ynabCadenceFrequency: c.goal_cadence_frequency ?? null,
      day: c.goal_day ?? null,
      targetDate: c.goal_target_date ?? c.goal_target_month ?? null,
      effectiveFrom: c.goal_creation_month ? `${c.goal_creation_month.slice(0, 7)}-01` : null,
      snoozedAt: c.goal_snoozed_at ?? null,
      needsWholeAmount: c.goal_needs_whole_amount ?? null,
      ynabUnderFunded: c.goal_under_funded !== null && c.goal_under_funded !== undefined ? m(c.goal_under_funded) : null,
      ynabOverallLeft: c.goal_overall_left !== null && c.goal_overall_left !== undefined ? m(c.goal_overall_left) : null,
    });
  }

  const payees: YnabImportPayee[] = payeesRaw.map((p) => {
    const out: YnabImportPayee = { ynabId: p.id, name: p.name, deleted: p.deleted };
    if (opt(p.transfer_account_id)) out.transferAccountYnabId = p.transfer_account_id!;
    return out;
  });
  const payeeName = new Map(payees.map((p) => [p.ynabId, p.name]));

  const subsByTxn = new Map<string, YnabImportSubtransaction[]>();
  const pushSub = (txnId: string, s: YnabImportSubtransaction) => {
    const l = subsByTxn.get(txnId) ?? [];
    l.push(s);
    subsByTxn.set(txnId, l);
  };
  const mapSub = (s: z.infer<typeof YSub>): YnabImportSubtransaction => {
    const out: YnabImportSubtransaction = { ynabId: s.id, amount: m(s.amount), deleted: s.deleted };
    if (opt(s.memo)) out.memo = s.memo!;
    if (opt(s.payee_id)) out.payeeYnabId = s.payee_id!;
    if (opt(s.category_id)) out.categoryYnabId = s.category_id!;
    if (opt(s.transfer_account_id)) out.transferAccountYnabId = s.transfer_account_id!;
    if (opt(s.transfer_transaction_id)) out.transferPairYnabId = s.transfer_transaction_id!;
    return out;
  };
  for (const s of subRaw) pushSub(s.transaction_id, mapSub(s));

  const transactions: YnabImportTransaction[] = txRaw.map((t) => {
    // TransactionDetail (from /transactions) nests subtransactions; the plan export lists them flat.
    const nested = parseList(YSub, (t.subtransactions ?? []).map((s) => ({ transaction_id: t.id, ...(s as object) })), `transactions[${t.id}].subtransactions`, warnings).map(mapSub);
    const subs = nested.length ? nested : (subsByTxn.get(t.id) ?? []);
    const out: YnabImportTransaction = {
      ynabId: t.id,
      accountYnabId: t.account_id,
      date: t.date,
      amount: m(t.amount),
      cleared: toCleared(t.cleared),
      approved: t.approved,
      flag: toFlag(t.flag_color),
      deleted: t.deleted,
      isSplit: subs.filter((s) => !s.deleted).length > 0,
      subtransactions: subs,
    };
    if (opt(t.memo)) out.memo = t.memo!;
    if (opt(t.flag_name)) out.flagName = t.flag_name!;
    if (opt(t.payee_id)) {
      out.payeeYnabId = t.payee_id!;
      const pn = payeeName.get(t.payee_id!) ?? (t as { payee_name?: string }).payee_name;
      if (pn) out.payeeName = pn;
    }
    // Split parents carry YNAB's internal "Split" category; the subtransactions hold the real categories.
    if (opt(t.category_id) && !out.isSplit) out.categoryYnabId = t.category_id!;
    if (opt(t.transfer_account_id)) out.transferAccountYnabId = t.transfer_account_id!;
    if (opt(t.transfer_transaction_id)) out.transferPairYnabId = t.transfer_transaction_id!;
    if (opt(t.matched_transaction_id)) out.matchedTransactionYnabId = t.matched_transaction_id!;
    if (opt(t.import_id)) out.importId = t.import_id!;
    if (opt(t.import_payee_name)) out.importPayeeName = t.import_payee_name!;
    return out;
  });

  const schedSubs = new Map<string, YnabImportScheduled["subtransactions"]>();
  for (const s of schedSubRaw) {
    const l = schedSubs.get(s.scheduled_transaction_id) ?? [];
    const o: YnabImportScheduled["subtransactions"][number] = { ynabId: s.id, amount: m(s.amount), deleted: s.deleted };
    if (opt(s.memo)) o.memo = s.memo!;
    if (opt(s.payee_id)) o.payeeYnabId = s.payee_id!;
    if (opt(s.category_id)) o.categoryYnabId = s.category_id!;
    if (opt(s.transfer_account_id)) o.transferAccountYnabId = s.transfer_account_id!;
    l.push(o);
    schedSubs.set(s.scheduled_transaction_id, l);
  }
  const scheduled: YnabImportScheduled[] = schedRaw.map((s) => {
    const freq = YNAB_FREQUENCY[s.frequency];
    if (!freq) warnings.push(`scheduled ${s.id}: unknown frequency ${s.frequency}`);
    const out: YnabImportScheduled = {
      ynabId: s.id,
      accountYnabId: s.account_id,
      dateFirst: s.date_first,
      dateNext: s.date_next,
      frequency: freq ?? "once",
      ynabFrequency: s.frequency,
      amount: m(s.amount),
      flag: toFlag(s.flag_color),
      deleted: s.deleted,
      subtransactions: schedSubs.get(s.id) ?? [],
    };
    if (opt(s.memo)) out.memo = s.memo!;
    if (opt(s.payee_id)) out.payeeYnabId = s.payee_id!;
    if (opt(s.category_id) && !out.subtransactions.some((x) => !x.deleted)) out.categoryYnabId = s.category_id!;
    if (opt(s.transfer_account_id)) out.transferAccountYnabId = s.transfer_account_id!;
    return out;
  });

  const months: YnabMonthSummary[] = [];
  const monthAssignments: YnabMonthAssignment[] = [];
  for (const mo of monthsRaw) {
    const month = `${mo.month.slice(0, 7)}-01`;
    const sum: YnabMonthSummary = { month, income: m(mo.income), budgeted: m(mo.budgeted), activity: m(mo.activity), toBeBudgeted: m(mo.to_be_budgeted), ageOfMoney: mo.age_of_money ?? null, deleted: mo.deleted };
    if (opt(mo.note)) sum.note = mo.note!;
    months.push(sum);
    for (const c of parseList(YCategory, mo.categories, `months[${month}].categories`, warnings)) {
      monthAssignments.push({ month, categoryYnabId: c.id, budgeted: m(c.budgeted), activity: m(c.activity), balance: m(c.balance) });
    }
  }
  months.sort((a, b) => (a.month < b.month ? -1 : 1));

  return {
    plan: { ynabId: plan.id, name: plan.name, lastModifiedOn: plan.last_modified_on ?? null, firstMonth: plan.first_month ?? null, lastMonth: plan.last_month ?? null },
    serverKnowledge: typeof sk === "number" ? sk : null,
    accounts,
    groups,
    categories,
    targets,
    transactions,
    scheduled,
    payees,
    monthAssignments,
    months,
    system,
    warnings,
  };
}

/** Map a /months/{month} response (`{ month: {...} }`) to assignments for that month. */
export function mapYnabMonthDetail(json: unknown): { summary: YnabMonthSummary; assignments: YnabMonthAssignment[] } {
  const raw = ((json as { data?: { month?: unknown } }).data?.month ?? (json as { month?: unknown }).month ?? json) as unknown;
  const r = YMonth.safeParse(raw);
  if (!r.success) throw new ConnectorError("parse", "Not a YNAB month detail", { provider: "ynab" });
  const bundle = mapYnabPlan({ plan: { id: "month", name: "month", months: [r.data] } });
  return { summary: bundle.months[0]!, assignments: bundle.monthAssignments };
}
