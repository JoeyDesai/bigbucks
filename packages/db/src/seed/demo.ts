/**
 * Deterministic demo data (spec §14): 18 months of household finances, May 2025 → Oct 2026, "today" = 2026-10-22.
 * The story is fictional: every person, business, amount, address, town, merchant and bank in it is made up
 * (the banks borrow the usual sample names: Contoso, Woodgrove, Fabrikam, Litware, Proseware).
 * `buildDemoData()` is pure (same output every run, ids included); `seedDemo()` truncates every table and inserts it.
 * `buildDemoData(today)` rolls the same story forward whole months so it ends on `today` (the public demo).
 *
 *   pnpm seed:demo            # refuses to wipe a database that holds non-demo data
 *   pnpm seed:demo --force
 *   pnpm seed:demo --rolling  # ends on today's date instead of 2026-10-22
 *   pnpm seed:demo --public   # --rolling, with the admin in the brand's gold (the public demo site)
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import {
  type AccountKind,
  type AccountSource,
  type Catz,
  type Month,
  addDays,
  addMonths,
  daysInMonth,
  divRound,
  monthOf,
  monthRange,
  monthsBetween,
  parseMilli,
  roundToCents,
  stripEmoji,
  suggestCategoryIcon,
  sumMilli,
  today as localToday,
  weekday,
} from "@homebase/shared";
import * as s from "../schema";
import { createDb, type Db } from "../client";
import { env } from "../env";
import { Rng } from "./random";

export const DEMO_SEED = 20261022;
export const DEMO_TODAY = "2026-10-22";
export const DEMO_FIRST_MONTH: Month = "2025-05-01";
export const DEMO_LAST_MONTH: Month = monthOf(DEMO_TODAY);

const $ = (amount: string) => parseMilli(amount);

type Ins<T extends PgTable> = T["$inferInsert"];
type WithId<T> = T & { id: string };

export interface DemoData {
  users: Ins<typeof s.users>[];
  entities: Ins<typeof s.entities>[];
  accounts: WithId<Ins<typeof s.accounts>>[];
  categoryGroups: Ins<typeof s.categoryGroups>[];
  categories: Ins<typeof s.categories>[];
  payees: Ins<typeof s.payees>[];
  payeeAliases: Ins<typeof s.payeeAliases>[];
  targets: Ins<typeof s.targets>[];
  monthAssignments: Ins<typeof s.monthAssignments>[];
  monthNotes: Ins<typeof s.monthNotes>[];
  scheduledTransactions: Ins<typeof s.scheduledTransactions>[];
  scheduledTransactionSplits: Ins<typeof s.scheduledTransactionSplits>[];
  transactions: WithId<Ins<typeof s.transactions>>[];
  transactionSplits: Ins<typeof s.transactionSplits>[];
  reconciliations: Ins<typeof s.reconciliations>[];
  budgetOperations: Ins<typeof s.budgetOperations>[];
  rules: Ins<typeof s.rules>[];
  categorizationEvents: Ins<typeof s.categorizationEvents>[];
  balances: Ins<typeof s.balances>[];
  holdings: Ins<typeof s.holdings>[];
  assets: Ins<typeof s.assets>[];
  assetValuations: Ins<typeof s.assetValuations>[];
  loans: Ins<typeof s.loans>[];
  loanEvents: Ins<typeof s.loanEvents>[];
  payrollRuns: Ins<typeof s.payrollRuns>[];
  householdMemory: Ins<typeof s.householdMemory>[];
  savedReports: Ins<typeof s.savedReports>[];
  auditLog: Ins<typeof s.auditLog>[];
  settings: Ins<typeof s.settings>[];
}

/** Insert order respects foreign keys. */
const INSERT_ORDER: { key: keyof DemoData; table: PgTable }[] = [
  { key: "users", table: s.users },
  { key: "entities", table: s.entities },
  { key: "accounts", table: s.accounts },
  { key: "categoryGroups", table: s.categoryGroups },
  { key: "categories", table: s.categories },
  { key: "payees", table: s.payees },
  { key: "payeeAliases", table: s.payeeAliases },
  { key: "targets", table: s.targets },
  { key: "monthAssignments", table: s.monthAssignments },
  { key: "monthNotes", table: s.monthNotes },
  { key: "scheduledTransactions", table: s.scheduledTransactions },
  { key: "scheduledTransactionSplits", table: s.scheduledTransactionSplits },
  { key: "transactions", table: s.transactions },
  { key: "transactionSplits", table: s.transactionSplits },
  { key: "reconciliations", table: s.reconciliations },
  { key: "budgetOperations", table: s.budgetOperations },
  { key: "rules", table: s.rules },
  { key: "categorizationEvents", table: s.categorizationEvents },
  { key: "balances", table: s.balances },
  { key: "holdings", table: s.holdings },
  { key: "assets", table: s.assets },
  { key: "assetValuations", table: s.assetValuations },
  { key: "loans", table: s.loans },
  { key: "loanEvents", table: s.loanEvents },
  { key: "payrollRuns", table: s.payrollRuns },
  { key: "householdMemory", table: s.householdMemory },
  { key: "savedReports", table: s.savedReports },
  { key: "auditLog", table: s.auditLog },
  { key: "settings", table: s.settings },
];

type Account = Ins<typeof s.accounts> & { id: string; kind: AccountKind; source: AccountSource };
type Category = Ins<typeof s.categories> & { id: string };
type Payee = Ins<typeof s.payees> & { id: string };
type Txn = Ins<typeof s.transactions> & { id: string; date: string; amountMilli: bigint };

export function normalizePayeeKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** bigint fixed-point → decimal string, e.g. fixed(12345n, 2) = "123.45". */
function fixed(n: bigint, scale: number): string {
  const neg = n < 0n;
  const a = (neg ? -n : n).toString().padStart(scale + 1, "0");
  const out = scale === 0 ? a : `${a.slice(0, -scale)}.${a.slice(-scale)}`;
  return neg ? `-${out}` : out;
}

const at = (date: string, hourUtc = 16) => new Date(`${date}T${String(hourUtc).padStart(2, "0")}:00:00Z`);

const monthName = (m: Month) => new Date(`${m}T12:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

export function buildDemoData(today: string = DEMO_TODAY): DemoData {
  // The story is written for 2026-10-22. For another `today`, every fixed date moves by the same number of
  // whole months (so paydays, bills and budget months stay aligned) and "the last few days" stay relative to today.
  const TODAY = today;
  const LAST = monthOf(TODAY);
  const FIRST = addMonths(LAST, -17);
  const delta = monthsBetween(DEMO_LAST_MONTH, LAST) - 1;
  const rel = (date: string) => {
    const m = addMonths(monthOf(date), delta);
    return `${m.slice(0, 8)}${String(Math.min(Number(date.slice(8, 10)), daysInMonth(m))).padStart(2, "0")}`;
  };
  /** A moved date, but never after today (for things that already happened). */
  const recent = (date: string) => (rel(date) > TODAY ? TODAY : rel(date));
  const rng = new Rng(DEMO_SEED, Date.UTC(2026, 9, 22, 12));
  const d: DemoData = {
    users: [], entities: [], accounts: [], categoryGroups: [], categories: [], payees: [], payeeAliases: [], targets: [],
    monthAssignments: [], monthNotes: [], scheduledTransactions: [], scheduledTransactionSplits: [], transactions: [],
    transactionSplits: [], reconciliations: [], budgetOperations: [], rules: [], categorizationEvents: [], balances: [],
    holdings: [], assets: [], assetValuations: [], loans: [], loanEvents: [], payrollRuns: [], householdMemory: [],
    savedReports: [], auditLog: [], settings: [],
  };
  const months = monthRange(FIRST, LAST);
  const firstDay = FIRST;
  const dateIn = (month: Month, day: number) => `${month.slice(0, 8)}${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
  const isPast = (date: string) => date <= TODAY;
  const allDays: string[] = [];
  for (let day = firstDay; day <= TODAY; day = addDays(day, 1)) allDays.push(day);

  // --- users & entities -----------------------------------------------------
  const alex = { id: rng.uuid(), tailscaleLogin: "alex@example.com", username: "alex", displayName: "Alex", role: "admin" as const, accent: "blue" };
  const sam = { id: rng.uuid(), tailscaleLogin: null, username: "sam", displayName: "Sam", role: "member" as const, accent: "pink" };
  d.users.push(alex, sam);
  const household = { id: rng.uuid(), name: "Household", sort: 0 };
  const business = { id: rng.uuid(), name: "Northwind Studio LLC", sort: 1 };
  d.entities.push(household, business);

  // --- accounts ---------------------------------------------------------------
  const account = (o: Omit<Account, "id" | "entityId" | "sort"> & { entityId?: string }): Account => {
    const a: Account = { id: rng.uuid(), entityId: household.id, sort: d.accounts.length, ...o };
    d.accounts.push(a);
    return a;
  };
  const checking = account({ name: "Checking", institution: "Contoso Bank", kind: "checking", onBudget: true, source: "simplefin" });
  const savings = account({ name: "Savings", institution: "Woodgrove Bank", kind: "savings", onBudget: true, source: "simplefin" });
  const cashBackCard = account({ name: "Cash Back Card", institution: "Fabrikam", kind: "credit_card", onBudget: true, source: "simplefin", statementDueDay: 12 });
  const rewardsCard = account({ name: "Rewards Card", institution: "Contoso Bank", kind: "credit_card", onBudget: true, source: "simplefin", statementDueDay: 18 });
  const brokerage = account({ name: "Litware Brokerage", institution: "Litware", kind: "brokerage", onBudget: false, source: "simplefin" });
  const k401Alex = account({ name: "Litware 401k (Alex)", institution: "Litware", kind: "retirement", onBudget: false, source: "simplefin", monthlyContributionMilli: $("1100") });
  const k401Sam = account({ name: "Sam's 401k", institution: "Proseware", kind: "retirement", onBudget: false, source: "manual", monthlyContributionMilli: $("450") });
  const coinbase = account({ name: "Coinbase", institution: "Coinbase", kind: "crypto", onBudget: false, source: "coinbase" });
  const river = account({ name: "River (BTC)", institution: "River", kind: "crypto", onBudget: false, source: "river_csv" });
  const home = account({ name: "Home", kind: "property", onBudget: false, source: "rentcast", note: "123 Maple St" });
  const mortgage = account({ name: "Mortgage", institution: "Woodgrove Bank", kind: "mortgage", onBudget: false, source: "amortization" });
  const mercury = account({ name: "Mercury Checking", institution: "Mercury", kind: "checking", onBudget: false, source: "mercury", entityId: business.id });
  const cards = [cashBackCard, rewardsCard];

  // --- categories (the example tree in spec Appendix A) ------------------------------
  const group = (name: string, o: Partial<Ins<typeof s.categoryGroups>> = {}) => {
    const g = { id: rng.uuid(), name, sort: d.categoryGroups.length, ...o };
    d.categoryGroups.push(g);
    return g;
  };
  // Names are written YNAB-style (with emoji) and stored the way importers store them: emoji stripped,
  // icon from suggestCategoryIcon (card payment categories get "credit-card", system ones none).
  const cat = (g: { id: string }, rawName: string, o: Partial<Ins<typeof s.categories>> = {}): Category => {
    const name = stripEmoji(rawName) || rawName;
    const kind = o.kind ?? "normal";
    const icon = kind === "cc_payment" ? "credit-card" : kind === "normal" ? suggestCategoryIcon(name) : null;
    const c: Category = { id: rng.uuid(), groupId: g.id, name, icon, sort: d.categories.filter((x) => x.groupId === g.id).length, kind: "normal", ...o };
    d.categories.push(c);
    return c;
  };
  const internal = group("Internal Master Category", { hidden: true, isSystem: true });
  const rta = cat(internal, "Inflow: Ready to Assign", { kind: "internal_rta", alwaysReview: true });
  const uncategorized = cat(internal, "Uncategorized", { kind: "uncategorized", alwaysReview: true });
  const ccGroup = group("Credit Card Payments", { isSystem: true });
  const ccFor = new Map<string, Category>([
    [cashBackCard.id, cat(ccGroup, "Cash Back Card", { kind: "cc_payment", linkedAccountId: cashBackCard.id })],
    [rewardsCard.id, cat(ccGroup, "Rewards Card", { kind: "cc_payment", linkedAccountId: rewardsCard.id })],
  ]);
  const bills = group("Bills");
  const needs = group("Needs");
  const wants = group("Wants");
  const savingsGroup = group("Savings");
  const C = {
    health: cat(bills, "Health Insurance"),
    trash: cat(bills, "Trash"),
    mortgage: cat(bills, "🏠 Mortgage"),
    internet: cat(bills, "🛜 Internet"),
    electricity: cat(bills, "⚡️ Electricity"),
    phone: cat(bills, "📱 Phone"),
    autoInsurance: cat(bills, "🛠 Auto insurance"),
    music: cat(bills, "🎵 Music"),
    costcoMembership: cat(bills, "Costco (membership)"),
    appleStorage: cat(bills, "🍎 Apple Storage"),
    idProtection: cat(bills, "🛡️ ID Protection", { icon: "shield" }),
    familyCalendar: cat(bills, "📅 Family Calendar", { icon: "calendar" }),
    news: cat(bills, "📰 News", { icon: "newspaper" }),
    ynab: cat(bills, "🌳 YNAB subscription", { note: "Annual renewal; sinking fund until cutover (§10)." }),
    houseCosts: cat(bills, "House Costs", { hidden: true, note: "Old catch-all; pest control still lands here." }),
    alexRetirement: cat(needs, "👴 Alex's Retirement"),
    samRetirement: cat(needs, "👵 Sam's Retirement"),
    pets: cat(needs, "🐢 Pets"),
    medical: cat(needs, "🚑 Medical Expenses"),
    gas: cat(needs, "⛽️ Gas"),
    groceries: cat(needs, "🛒 Groceries"),
    misc: cat(needs, "🤷‍♂️ Misc", { alwaysReview: true }),
    car: cat(needs, "🚗 Car Expenses"),
    eatingOut: cat(wants, "🍽️ Eating Out"),
    dates: cat(wants, "❤️ Dates"),
    entertainment: cat(wants, "🍿 Entertainment"),
    giving: cat(wants, "🤝 Giving", { icon: "hand-heart" }),
    gifts: cat(wants, "🎁 Gifts"),
    alexSpending: cat(wants, "🏎️ Alex's Spending Money"),
    samSpending: cat(wants, "👗 Sam's Spending Money"),
    extraHouse: cat(savingsGroup, "Extra House Payments", { alwaysReview: true }),
    houseProjects: cat(savingsGroup, "House Projects", { alwaysReview: true }),
    taxes: cat(savingsGroup, "Taxes", { alwaysReview: true }),
    emergency: cat(savingsGroup, "🚨 Emergency Fund", { alwaysReview: true }),
    savings: cat(savingsGroup, "💰 Savings", { alwaysReview: true }),
  };

  // --- targets and the monthly assignment plan -------------------------------------------
  type Plan = { monthly?: (m: Month) => bigint; refillTo?: bigint; initial?: bigint };
  const plans = new Map<string, Plan>();
  const target = (c: Category, o: Omit<Ins<typeof s.targets>, "categoryId" | "createdMonth" | "effectiveFrom"> & { effectiveFrom?: string }) => {
    const effectiveFrom = o.effectiveFrom ?? FIRST;
    d.targets.push({ categoryId: c.id, cadence: "monthly", cadenceEvery: 1, createdMonth: effectiveFrom, ...o, effectiveFrom });
  };
  const monthly = (c: Category, amount: string, plan: Partial<Plan> = {}, type: "need_set_aside" | "monthly_builder" = "need_set_aside") => {
    target(c, { type, amountMilli: $(amount) });
    plans.set(c.id, { monthly: () => $(amount), ...plan });
  };
  monthly(C.health, "480");
  monthly(C.trash, "32");
  monthly(C.mortgage, "2466.77");
  monthly(C.internet, "79.99");
  target(C.electricity, { type: "need_refill", amountMilli: $("240") });
  plans.set(C.electricity.id, { refillTo: $("240") });
  monthly(C.phone, "147.18", { monthly: (m) => (m < rel("2026-03-01") ? $("142.18") : $("147.18")) });
  target(C.autoInsurance, { type: "need_set_aside", amountMilli: $("1140"), cadence: "every_n_months", cadenceEvery: 6, targetDate: rel("2026-12-05") });
  plans.set(C.autoInsurance.id, { monthly: () => $("190"), initial: $("950") });
  monthly(C.music, "19.99", { monthly: (m) => (m < rel("2026-07-01") ? $("16.99") : $("19.99")) });
  target(C.costcoMembership, { type: "need_set_aside", amountMilli: $("130"), cadence: "yearly", targetDate: rel("2027-03-14") });
  plans.set(C.costcoMembership.id, { monthly: () => $("10.84"), initial: $("110") });
  monthly(C.appleStorage, "9.99");
  monthly(C.idProtection, "12");
  monthly(C.familyCalendar, "4.99");
  monthly(C.news, "10");
  target(C.ynab, { type: "need_set_aside", amountMilli: $("109"), cadence: "yearly", targetDate: rel("2027-02-10") });
  plans.set(C.ynab.id, { monthly: () => $("9.09"), initial: $("85") });
  plans.set(C.houseCosts.id, { monthly: () => $("32") });
  monthly(C.alexRetirement, "300", {}, "monthly_builder");
  monthly(C.samRetirement, "200", {}, "monthly_builder");
  monthly(C.pets, "110");
  target(C.medical, { type: "need_refill", amountMilli: $("300") });
  plans.set(C.medical.id, { refillTo: $("300") });
  monthly(C.gas, "220");
  monthly(C.groceries, "950");
  monthly(C.misc, "550");
  monthly(C.car, "100");
  monthly(C.eatingOut, "320");
  monthly(C.dates, "150");
  monthly(C.entertainment, "80");
  // A flat monthly gift, raised in January 2026, so the target has history.
  target(C.giving, { type: "need_set_aside", amountMilli: $("450") });
  target(C.giving, { type: "need_set_aside", amountMilli: $("500"), effectiveFrom: rel("2026-01-01") });
  plans.set(C.giving.id, { monthly: (m) => (m < rel("2026-01-01") ? $("450") : $("500")) });
  monthly(C.gifts, "100", { initial: $("300") });
  monthly(C.alexSpending, "100");
  monthly(C.samSpending, "100");
  monthly(C.extraHouse, "300", {}, "monthly_builder");
  monthly(C.houseProjects, "150", { initial: $("500") }, "monthly_builder");
  monthly(C.taxes, "400", { initial: $("900") });
  target(C.emergency, { type: "balance_by_date", amountMilli: $("20000"), cadence: "none", targetDate: rel("2027-12-01") });
  plans.set(C.emergency.id, { monthly: () => $("200"), initial: $("15000") });

  // --- payees -----------------------------------------------------------------------
  const payeeByKey = new Map<string, Payee>();
  const payee = (name: string, defaultCategory?: Category, aliases: { pattern: string; match: "exact" | "prefix" | "regex" }[] = []): Payee => {
    const key = normalizePayeeKey(name);
    let p = payeeByKey.get(key);
    if (!p) {
      p = { id: rng.uuid(), name, normalizedKey: key, defaultCategoryId: defaultCategory?.id ?? null };
      payeeByKey.set(key, p);
      d.payees.push(p);
      for (const a of aliases) d.payeeAliases.push({ id: rng.uuid(), payeeId: p.id, ...a });
    }
    return p;
  };
  const transferPayee = new Map<string, Payee>();
  for (const a of d.accounts) {
    const p: Payee = { id: rng.uuid(), name: `Transfer : ${a.name}`, normalizedKey: `transfer ${normalizePayeeKey(a.name)}`, transferAccountId: a.id };
    transferPayee.set(a.id, p);
    d.payees.push(p);
  }
  const startingBalancePayee = payee("Starting Balance");

  // --- transactions -----------------------------------------------------------------
  interface TxIn {
    account: Account;
    date: string;
    amount: bigint;
    payee?: Payee;
    category?: Category | null;
    memo?: string;
    raw?: string;
    splits?: { amount: bigint; category: Category; memo?: string }[];
    transferAccount?: Account;
    startingBalance?: boolean;
    approved?: boolean;
    catz?: Catz;
  }
  const txMeta = new Map<string, { explicitCatz: boolean }>();
  let externalSeq = 0;
  const tx = (o: TxIn): Txn => {
    const synced = o.account.source === "simplefin" || o.account.source === "mercury";
    const raw = o.raw ?? null;
    const t: Txn = {
      id: rng.uuid(),
      accountId: o.account.id,
      date: o.date,
      amountMilli: o.amount,
      payeeId: o.payee?.id ?? null,
      rawDescription: raw,
      memo: o.memo ?? null,
      categoryId: o.splits ? null : (o.category?.id ?? null),
      isSplit: !!o.splits,
      transferAccountId: o.transferAccount?.id ?? null,
      isStartingBalance: !!o.startingBalance,
      cleared: "cleared",
      approved: o.approved ?? true,
      source: o.startingBalance || !synced ? "manual" : o.account.source,
      externalId: synced && !o.startingBalance ? `demo-${o.account.source}-${++externalSeq}` : null,
      importHash: raw
        ? createHash("sha256").update(`${o.account.id}|${o.date}|${o.amount}|${normalizePayeeKey(raw)}`).digest("hex")
        : null,
      catz: o.catz ?? null,
    };
    d.transactions.push(t);
    txMeta.set(t.id, { explicitCatz: !!o.catz });
    if (o.splits) {
      const total = sumMilli(o.splits.map((x) => x.amount));
      if (total !== o.amount) throw new Error(`demo split for ${o.date} sums to ${total}, expected ${o.amount}`);
      o.splits.forEach((line, i) =>
        d.transactionSplits.push({ id: rng.uuid(), transactionId: t.id, amountMilli: line.amount, categoryId: line.category.id, memo: line.memo ?? null, sort: i }),
      );
    }
    return t;
  };
  /** Moves `amount` (> 0) from → to. A categorized transfer crosses the budget boundary; the budget side carries the category. */
  const transfer = (from: Account, to: Account, date: string, amount: bigint, o: { category?: Category; memo?: string } = {}) => {
    const crossing = from.onBudget !== to.onBudget;
    const out = tx({ account: from, date, amount: -amount, payee: transferPayee.get(to.id)!, transferAccount: to, category: crossing && from.onBudget ? o.category : null, memo: o.memo, raw: from.onBudget || from === mercury ? `ONLINE TRANSFER TO ${to.name.toUpperCase()}` : undefined });
    const inn = tx({ account: to, date, amount, payee: transferPayee.get(from.id)!, transferAccount: from, category: crossing && to.onBudget ? o.category : null, memo: o.memo, raw: to.onBudget || to === mercury ? `ONLINE TRANSFER FROM ${from.name.toUpperCase()}` : undefined });
    out.transferPairId = inn.id;
    inn.transferPairId = out.id;
    return { out, inn };
  };
  const balanceOn = (a: Account, date: string) => sumMilli(d.transactions.filter((t) => t.accountId === a.id && t.date <= date).map((t) => t.amountMilli));
  const splitPct = (total: bigint, lines: [Category, bigint, string?][]) => {
    let left = total;
    return lines.map(([category, pct, memo], i) => {
      const amount = i === lines.length - 1 ? left : roundToCents(divRound(total * pct, 100n));
      left -= amount;
      return { amount, category, memo };
    });
  };

  // Merchants: payee, how its bank description looks, default category, which card it usually hits.
  const code = () => Array.from({ length: 6 }, () => rng.pick([..."ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"])).join("");
  interface Merchant { payee: Payee; raw: () => string; category: Category; cards: Account[] }
  const merchant = (name: string, category: Category, raw: () => string, cardChoices: Account[], alias?: { pattern: string; match: "exact" | "prefix" | "regex" }): Merchant => ({
    payee: payee(name, category, alias ? [alias] : []),
    raw,
    category,
    cards: cardChoices,
  });
  const P = (prefix: string) => ({ pattern: prefix, match: "prefix" as const });
  const E = (exact: string) => ({ pattern: exact, match: "exact" as const });
  const M = {
    kroger: merchant("Kroger", C.groceries, () => `KROGER #0${rng.pick(["412", "377", "538"])} FAIRVIEW VA`, [cashBackCard, cashBackCard, rewardsCard], P("KROGER #")),
    costco: merchant("Costco", C.groceries, () => "COSTCO WHSE #1205 FAIRVIEW VA", [cashBackCard], P("COSTCO WHSE")),
    aldi: merchant("Aldi", C.groceries, () => "ALDI 72031 MILTON VA", [rewardsCard], P("ALDI ")),
    lowes: merchant("Lowe's", C.misc, () => `LOWE'S #${rng.pick(["0487", "1720"])} FAIRVIEW VA`, [cashBackCard], P("LOWE'S #")),
    homeDepot: merchant("The Home Depot", C.houseProjects, () => "THE HOME DEPOT #4618", [cashBackCard], P("THE HOME DEPOT")),
    amazon: merchant("Amazon", C.misc, () => `AMAZON MKTPL*${code()}`, [cashBackCard], P("AMAZON MKTPL*")),
    target: merchant("Target", C.misc, () => "TARGET 00018234 FAIRVIEW VA", [rewardsCard], P("TARGET 000")),
    walmart: merchant("Walmart", C.misc, () => "WAL-MART #1351 MILTON VA", [rewardsCard], P("WAL-MART #")),
    dollarTree: merchant("Dollar Tree", C.misc, () => "DOLLAR TREE #4471", [rewardsCard], P("DOLLAR TREE")),
    netflix: merchant("Netflix", C.entertainment, () => "NETFLIX.COM", [rewardsCard], E("NETFLIX.COM")),
    disney: merchant("Disney+", C.entertainment, () => "DISNEY PLUS", [cashBackCard], E("DISNEY PLUS")),
    spotify: merchant("Spotify", C.music, () => "SPOTIFY USA", [cashBackCard], E("SPOTIFY USA")),
    icloud: merchant("Apple iCloud", C.appleStorage, () => "APPLE.COM/BILL", [cashBackCard], E("APPLE.COM/BILL")),
    idProtection: merchant("Sentinel ID", C.idProtection, () => "SENTINEL ID* SUBSCRIPTION", [rewardsCard], P("SENTINEL ID*")),
    news: merchant("Morning Ledger", C.news, () => "MORNING LEDGER DIGITAL", [rewardsCard], P("MORNING LEDGER")),
    cozi: merchant("Cozi", C.familyCalendar, () => "COZI GOLD", [cashBackCard], E("COZI GOLD")),
    fiber: merchant("Hilltop Fiber", C.internet, () => "HILLTOP FIBER 800-555-0142", [rewardsCard], P("HILLTOP FIBER")),
    verizon: merchant("Verizon", C.phone, () => "VZWRLSS*APOCC VISB", [rewardsCard], P("VZWRLSS*")),
    shell: merchant("Shell", C.gas, () => `SHELL OIL 57444${rng.int(100, 999)}`, [rewardsCard], P("SHELL OIL")),
    circleK: merchant("Circle K", C.gas, () => "CIRCLE K 0466 FAIRVIEW VA", [rewardsCard], P("CIRCLE K ")),
    chickfila: merchant("Chick-fil-A", C.eatingOut, () => "CHICK-FIL-A #01842", [rewardsCard, rewardsCard, cashBackCard], P("CHICK-FIL-A")),
    chipotle: merchant("Chipotle", C.eatingOut, () => "CHIPOTLE 2213", [rewardsCard, cashBackCard], P("CHIPOTLE ")),
    cornerCup: merchant("Corner Cup Cafe", C.eatingOut, () => "SQ *CORNER CUP CAFE Fairview VA", [rewardsCard, cashBackCard], P("SQ *CORNER CUP")),
    starbucks: merchant("Starbucks", C.eatingOut, () => "STARBUCKS STORE 11024", [rewardsCard], P("STARBUCKS")),
    copperKettle: merchant("Copper Kettle", C.eatingOut, () => "COPPER KETTLE RESTAURANT", [rewardsCard], P("COPPER KETTLE")),
    harvestTable: merchant("Harvest Table", C.dates, () => "HARVEST TABLE RESTAURANT", [rewardsCard], P("HARVEST TABLE")),
    amc: merchant("AMC Theatres", C.dates, () => "AMC 5121 FAIRVIEW", [cashBackCard], P("AMC ")),
    chewy: merchant("Chewy", C.pets, () => "CHEWY.COM", [cashBackCard], E("CHEWY.COM")),
    vet: merchant("Fairview Animal Hospital", C.pets, () => "FAIRVIEW ANIMAL HOSPITAL", [cashBackCard], P("FAIRVIEW ANIMAL")),
    cvs: merchant("CVS Pharmacy", C.medical, () => "CVS/PHARMACY #07211", [rewardsCard], P("CVS/PHARMACY")),
    clinic: merchant("Fairview Family Medicine", C.medical, () => "FAIRVIEW FAMILY MED PATIENT PAY", [cashBackCard], P("FAIRVIEW FAMILY MED")),
    valvoline: merchant("Valvoline", C.car, () => "VALVOLINE INSTANT OIL 1123", [rewardsCard], P("VALVOLINE")),
    carWash: merchant("Tidal Wave Auto Spa", C.car, () => "TIDAL WAVE AUTO SPA", [rewardsCard], P("TIDAL WAVE")),
    steam: merchant("Steam", C.alexSpending, () => "STEAMGAMES.COM 4259522985", [cashBackCard], P("STEAMGAMES.COM")),
    barnes: merchant("Barnes & Noble", C.alexSpending, () => "BARNES & NOBLE #2681", [rewardsCard], P("BARNES & NOBLE")),
    oldNavy: merchant("Old Navy", C.samSpending, () => "OLD NAVY ON-LINE", [rewardsCard], P("OLD NAVY")),
    etsy: merchant("Etsy", C.gifts, () => "ETSY.COM - ANNIEMAKES", [cashBackCard], P("ETSY.COM")),
    ynab: merchant("YNAB", C.ynab, () => "YNAB.COM", [cashBackCard], E("YNAB.COM")),
    costcoRenewal: merchant("Costco Membership", C.costcoMembership, () => "COSTCO *ANNUAL RENEWAL", [cashBackCard], E("COSTCO *ANNUAL RENEWAL")),
    terminix: merchant("Terminix", C.houseCosts, () => "TERMINIX 4471", [checking], P("TERMINIX")),
  };
  const anthem = payee("Anthem Blue Cross", C.health, [P("ANTHEM BLUE CROSS")]);
  const countyTrash = payee("Fairview County Solid Waste", C.trash, [P("FAIRVIEW CO SOLID WASTE")]);
  const power = payee("Fairview Power", C.electricity, [P("FAIRVIEW POWER")]);
  const givingFund = payee("Community Fund", C.giving, [P("COMMUNITY FUND")]);
  const progressive = payee("Progressive", C.autoInsurance, [P("PROGRESSIVE INS")]);
  const irs = payee("IRS", C.taxes, [P("IRS USATAXPYMT")]);
  const employerPayroll = payee("Northwind Studio", rta, [P("NORTHWIND STUDIO PAYROLL")]);
  const savingsBank = payee("Woodgrove Bank", rta, [E("INTEREST PAYMENT")]);
  const acme = payee("Acme Health", undefined, [P("ACME HEALTH")]);
  const blueRidge = payee("Blue Ridge Analytics", undefined, [P("BLUE RIDGE ANALYTICS")]);
  const gusto = payee("Gusto", undefined, [P("GUSTO ")]);
  const aws = payee("AWS", undefined, [P("AWS EMEA"), P("AMAZON WEB SERVICES")]);
  const github = payee("GitHub", undefined, [P("GITHUB")]);
  const gworkspace = payee("Google Workspace", undefined, [P("GOOGLE *GSUITE")]);
  const anthropic = payee("Anthropic", undefined, [P("ANTHROPIC")]);

  const buy = (m: Merchant, date: string, amount: bigint, o: Partial<TxIn> = {}) => {
    if (!isPast(date)) return undefined;
    return tx({ account: rng.pick(m.cards), date, amount: -amount, payee: m.payee, category: m.category, raw: m.raw(), ...o });
  };
  const randomDay = (m: Month) => dateIn(m, rng.int(1, daysInMonth(m)));

  // Payroll (Gusto via Northwind Studio): gross, employee taxes, 401k deferral 6%, employer match 4% (made-up figures).
  const payrollFor = (m: Month) =>
    m < rel("2026-01-01")
      ? { gross: $("10500"), taxes: $("1940"), deferral: $("630"), match: $("420"), employerTaxes: $("803.25") }
      : { gross: $("11000"), taxes: $("2035"), deferral: $("660"), match: $("440"), employerTaxes: $("841.50") };
  const payday = (m: Month) => {
    let date = dateIn(m, 25);
    while (weekday(date) === 0 || weekday(date) === 6) date = addDays(date, -1);
    return date;
  };
  const payrollDates = new Set<string>();
  const brokerageBuys = new Map<string, bigint>();
  const extraPrincipal = { date: rel("2026-03-15"), amount: $("3000") };

  // Starting balances (May 1, 2025).
  tx({ account: checking, date: firstDay, amount: $("12000"), payee: startingBalancePayee, category: rta, startingBalance: true });
  tx({ account: savings, date: firstDay, amount: $("24500"), payee: startingBalancePayee, category: rta, startingBalance: true });
  tx({ account: cashBackCard, date: firstDay, amount: $("-1240.55"), payee: startingBalancePayee, startingBalance: true });
  tx({ account: rewardsCard, date: firstDay, amount: $("-612.30"), payee: startingBalancePayee, startingBalance: true });
  tx({ account: mercury, date: firstDay, amount: $("48500"), payee: startingBalancePayee, startingBalance: true });

  months.forEach((m, mi) => {
    const mm = Number(m.slice(5, 7));
    /** Month of year in the original story (yearly/quarterly bills keep their spacing from today). */
    const sm = Number(addMonths(m, -delta).slice(5, 7));
    const days = Array.from({ length: daysInMonth(m) }, (_, i) => dateIn(m, i + 1)).filter(isPast);

    // Fixed bills and transfers from Checking.
    if (isPast(dateIn(m, 1))) {
      transfer(checking, mortgage, dateIn(m, 1), $("2466.77"), { category: C.mortgage, memo: "P&I 1,946.77 + escrow 520.00" });
      tx({ account: checking, date: dateIn(m, 1), amount: $("-480"), payee: anthem, category: C.health, raw: "ANTHEM BLUE CROSS PREM" });
    }
    if (isPast(dateIn(m, 2))) {
      tx({ account: checking, date: dateIn(m, 2), amount: -(m < rel("2026-01-01") ? $("450") : $("500")), payee: givingFund, category: C.giving, raw: "COMMUNITY FUND ONLINE GIVING" });
    }
    if (isPast(dateIn(m, 5))) tx({ account: checking, date: dateIn(m, 5), amount: $("-32"), payee: countyTrash, category: C.trash, raw: "FAIRVIEW CO SOLID WASTE" });
    if (isPast(dateIn(m, 12))) {
      const seasonal: Record<number, number> = { 1: 115, 2: 100, 6: 35, 7: 85, 8: 90, 9: 30, 12: 70 };
      const electric = rng.milli(118, 142) + BigInt(seasonal[mm] ?? 0) * 1000n;
      tx({ account: checking, date: dateIn(m, 12), amount: -electric, payee: power, category: C.electricity, raw: "FAIRVIEW POWER BILL PAY" });
    }
    if ((sm === 6 || sm === 12) && isPast(dateIn(m, 5))) {
      tx({ account: checking, date: dateIn(m, 5), amount: $("-1140"), payee: progressive, category: C.autoInsurance, raw: "PROGRESSIVE INS PREM" });
    }
    if ([1, 4, 6, 9].includes(sm) && isPast(dateIn(m, 15))) {
      tx({ account: checking, date: dateIn(m, 15), amount: $("-1200"), payee: irs, category: C.taxes, raw: "IRS USATAXPYMT", memo: "Estimated tax" });
    }
    if (sm % 3 === 2 && isPast(dateIn(m, 20))) {
      tx({ account: checking, date: dateIn(m, 20), amount: $("-95"), payee: M.terminix.payee, category: C.houseCosts, raw: M.terminix.raw() });
    }
    if ([1, 4, 7, 10].includes(sm) && isPast(dateIn(m, 15))) {
      transfer(mercury, checking, dateIn(m, 15), $("3000"), { category: rta, memo: "Owner distribution" });
    }
    if (m === monthOf(extraPrincipal.date)) {
      transfer(savings, mortgage, extraPrincipal.date, extraPrincipal.amount, { category: C.extraHouse, memo: "Extra principal" });
    }

    // Payroll lands in Checking; Gusto debits Mercury for net pay, taxes and 401k.
    const pd = payday(m);
    const pr = payrollFor(m);
    const net = pr.gross - pr.taxes - pr.deferral;
    if (isPast(pd)) {
      payrollDates.add(pd);
      const deposit = tx({ account: checking, date: pd, amount: net, payee: employerPayroll, category: rta, raw: `NORTHWIND STUDIO PAYROLL ${pd.replaceAll("-", "").slice(2)}` });
      d.payrollRuns.push({
        id: rng.uuid(),
        externalId: `demo-payroll-${m.slice(0, 7)}`,
        checkDate: pd,
        grossMilli: pr.gross,
        employeeTaxesMilli: pr.taxes,
        employerTaxesMilli: pr.employerTaxes,
        deductions: { "401k": pr.deferral.toString(), "401k_match": pr.match.toString() },
        netMilli: net,
        matchedTransactionId: deposit.id,
      });
      const gd = addDays(pd, -1);
      tx({ account: mercury, date: gd, amount: -net, payee: gusto, raw: "GUSTO NET 4587121" });
      tx({ account: mercury, date: gd, amount: -(pr.taxes + pr.employerTaxes), payee: gusto, raw: "GUSTO TAX 4587121" });
      tx({ account: mercury, date: gd, amount: -(pr.deferral + pr.match), payee: gusto, raw: "GUSTO 401K 4587121" });
    }

    // Northwind Studio revenue and software spend (tracking, off budget).
    if (isPast(dateIn(m, 5))) tx({ account: mercury, date: dateIn(m, 5), amount: $("14500"), payee: acme, raw: "ACME HEALTH INC ACH PMT" });
    if (mi % 2 === 1 && isPast(dateIn(m, 20))) tx({ account: mercury, date: dateIn(m, 20), amount: $("6200"), payee: blueRidge, raw: "BLUE RIDGE ANALYTICS LLC" });
    if (isPast(dateIn(m, 1))) tx({ account: mercury, date: dateIn(m, 1), amount: $("-28.80"), payee: gworkspace, raw: "GOOGLE *GSUITE_northwind" });
    if (isPast(dateIn(m, 3))) tx({ account: mercury, date: dateIn(m, 3), amount: -rng.milli(176, 244), payee: aws, raw: "AWS EMEA aws.amazon.co" });
    if (isPast(dateIn(m, 7))) tx({ account: mercury, date: dateIn(m, 7), amount: $("-44"), payee: github, raw: "GITHUB, INC." });
    if (isPast(dateIn(m, 15))) tx({ account: mercury, date: dateIn(m, 15), amount: $("-100"), payee: anthropic, raw: "ANTHROPIC CLAUDE API" });

    // Retirement contributions and savings sweep on the 26th.
    const d26 = dateIn(m, 26);
    if (isPast(d26)) {
      transfer(checking, brokerage, d26, $("300"), { category: C.alexRetirement, memo: "Alex Roth IRA" });
      transfer(checking, brokerage, d26, $("200"), { category: C.samRetirement, memo: "Sam Roth IRA" });
      brokerageBuys.set(d26, $("500"));
      transfer(checking, savings, d26, $("500"));
    }

    // Card payments: pay the previous statement (balance at end of last month) in full.
    for (const card of cards) {
      const due = dateIn(m, card.statementDueDay!);
      if (!isPast(due)) continue;
      const owed = -balanceOn(card, addDays(m, -1));
      if (owed > 0n) transfer(checking, card, due, owed, { memo: "Autopay" });
    }

    // Savings interest at month end (4.20% APY, monthly).
    const eom = dateIn(m, 31);
    if (isPast(eom)) {
      const interest = roundToCents(divRound(balanceOn(savings, eom) * 42n, 12_000n));
      tx({ account: savings, date: eom, amount: interest, payee: savingsBank, category: rta, raw: "INTEREST PAYMENT" });
    }

    // Subscriptions.
    buy(M.spotify, dateIn(m, 3), m < rel("2026-07-01") ? $("16.99") : $("19.99"));
    buy(M.news, dateIn(m, 6), $("10"));
    buy(M.carWash, dateIn(m, 8), $("19.99"));
    buy(M.netflix, dateIn(m, 9), m < rel("2026-01-01") ? $("15.49") : $("17.99"));
    buy(M.cozi, dateIn(m, 11), $("4.99"));
    buy(M.icloud, dateIn(m, 14), $("9.99"));
    buy(M.disney, dateIn(m, 15), $("13.99"));
    buy(M.fiber, dateIn(m, 17), $("79.99"));
    buy(M.idProtection, dateIn(m, 20), $("12"));
    buy(M.verizon, dateIn(m, 22), m < rel("2026-03-01") ? $("142.18") : $("147.18"));
    if (sm === 2) buy(M.ynab, dateIn(m, 10), $("109"));
    if (sm === 3) buy(M.costcoRenewal, dateIn(m, 14), $("130"));

    // Amazon Subscribe & Save, split across three categories.
    const sns = dateIn(m, 28);
    if (isPast(sns)) {
      tx({
        account: cashBackCard, date: sns, amount: $("-85.60"), payee: M.amazon.payee, raw: `AMAZON MKTPL*${code()}`, memo: "Subscribe & Save",
        splits: [
          { amount: $("-35"), category: C.groceries, memo: "coffee, snacks" },
          { amount: $("-28.50"), category: C.pets, memo: "cat litter" },
          { amount: $("-22.10"), category: C.misc, memo: "paper towels" },
        ],
      });
    }

    // Day-by-day variable spending.
    let costcoTrips = 0;
    for (const date of days) {
      const wd = weekday(date);
      if (wd === 6) buy(M.kroger, date, rng.milli(70, 160));
      if (wd === 3 && rng.chance(0.3)) buy(M.kroger, date, rng.milli(14, 45));
      if (wd === 0 && rng.chance(0.5)) {
        const amount = rng.milli(140, 300);
        const split = costcoTrips++ % 2 === 0;
        if (isPast(date)) {
          tx({
            account: cashBackCard, date, amount: -amount, payee: M.costco.payee, raw: M.costco.raw(),
            ...(split ? { splits: splitPct(-amount, [[C.groceries, 80n], [C.misc, 20n, "household"]]) } : { category: C.groceries }),
          });
        }
      }
      if (wd === 1) buy(M.shell, date, rng.milli(38, 62));
    }
    buy(M.aldi, dateIn(m, 10), rng.milli(45, 95));
    for (let i = 0; i < rng.int(1, 2); i++) buy(M.circleK, randomDay(m), rng.milli(30, 55));
    for (let i = 0; i < 6; i++) buy(M.amazon, randomDay(m), rng.milli(8, 60));
    for (let i = 0; i < 3; i++) buy(M.lowes, randomDay(m), rng.milli(12, 75));
    for (let i = 0; i < 2; i++) buy(M.target, randomDay(m), rng.milli(15, 70));
    for (let i = 0; i < 2; i++) buy(M.walmart, randomDay(m), rng.milli(6, 35));
    buy(M.dollarTree, randomDay(m), rng.milli(5, 25));
    if (mi % 3 === 1) buy(M.homeDepot, randomDay(m), rng.milli(250, 600));
    else if (rng.chance(0.3)) buy(M.lowes, randomDay(m), rng.milli(120, 260), { category: C.houseProjects });
    for (let i = 0; i < 3; i++) buy(M.chickfila, randomDay(m), rng.milli(14, 32));
    for (let i = 0; i < 2; i++) buy(M.chipotle, randomDay(m), rng.milli(18, 34));
    for (let i = 0; i < 2; i++) buy(M.cornerCup, randomDay(m), rng.milli(22, 48));
    for (let i = 0; i < 3; i++) buy(M.starbucks, randomDay(m), rng.milli(6, 13));
    if (rng.chance(0.3)) buy(M.copperKettle, randomDay(m), rng.milli(60, 110));
    buy(M.harvestTable, randomDay(m), rng.milli(70, 130));
    if (rng.chance(0.4)) buy(M.amc, randomDay(m), rng.milli(28, 45));
    if (rng.chance(0.25)) buy(M.amc, randomDay(m), rng.milli(15, 30), { category: C.entertainment });
    buy(M.chewy, dateIn(m, 5), rng.milli(48, 72));
    if (mi % 4 === 2) buy(M.vet, randomDay(m), rng.milli(150, 260));
    for (let i = 0; i < rng.int(1, 2); i++) buy(M.cvs, randomDay(m), rng.milli(9, 45));
    if (rng.chance(0.35)) buy(M.clinic, randomDay(m), rng.milli(40, 180));
    if (mi % 3 === 0) buy(M.valvoline, randomDay(m), $("79.99"));
    buy(M.etsy, randomDay(m), rng.milli(25, 60));
    if (mm === 11 || mm === 12) for (let i = 0; i < 3; i++) buy(M.amazon, randomDay(m), rng.milli(40, 120), { category: C.gifts, memo: "Christmas" });
    buy(M.steam, randomDay(m), rng.milli(10, 40));
    if (rng.chance(0.5)) buy(M.barnes, randomDay(m), rng.milli(12, 35));
    buy(M.oldNavy, randomDay(m), rng.milli(25, 70));
    if (rng.chance(0.4)) buy(M.etsy, randomDay(m), rng.milli(15, 40), { category: C.samSpending });
  });

  // Refunds (inflows on cards back to the spending category).
  tx({ account: cashBackCard, date: rel("2025-09-14"), amount: $("58.12"), payee: M.lowes.payee, category: C.houseProjects, raw: "LOWE'S #0487 FAIRVIEW VA RETURN", memo: "Returned extra pavers" });
  tx({ account: cashBackCard, date: rel("2026-06-09"), amount: $("34.99"), payee: M.amazon.payee, category: C.misc, raw: `AMAZON MKTPL*${code()} REFUND` });

  // Last 10 days: Amazon charges the categorizer couldn't place (Uncategorized activity −$426.50).
  const aiAt = (date: string) => `${date}T14:05:00.000Z`;
  const uncategorizedSuggestion = (date: string): Catz => ({
    method: "ai", confidence: 0.52, model: "claude-haiku-5-5", explanation: "Amazon order; items unknown", at: aiAt(date),
    suggestions: [{ category_id: C.misc.id, confidence: 0.52 }, { category_id: C.gifts.id, confidence: 0.21 }, { category_id: C.houseProjects.id, confidence: 0.12 }],
  });
  for (const [date, amount] of [[addDays(TODAY, -8), "141.37"], [addDays(TODAY, -5), "98.64"], [addDays(TODAY, -2), "186.49"]] as const) {
    tx({ account: cashBackCard, date, amount: -$(amount), payee: M.amazon.payee, category: null, raw: `AMAZON MKTPL*${code()}`, approved: false, catz: uncategorizedSuggestion(date) });
  }
  // One pending card swipe from today (display-only until it posts).
  const pendingGas = tx({ account: rewardsCard, date: TODAY, amount: $("-41.87"), payee: M.shell.payee, category: C.gas, raw: "SHELL OIL 57444211 PENDING", approved: false });

  // Two September Lowe's runs Sam moved Misc → House Projects (what the §9.5 learned-rule suggestion is built from).
  const lowesCorrections = d.transactions
    .filter((t) => t.payeeId === M.lowes.payee.id && t.date >= addMonths(LAST, -1) && t.date < LAST && t.categoryId === C.misc.id)
    .slice(0, 2);
  for (const t of lowesCorrections) {
    t.categoryId = C.houseProjects.id;
    t.catz = { method: "user", confidence: 1, at: `${t.date}T23:10:00.000Z` };
    txMeta.set(t.id, { explicitCatz: true });
  }

  // --- assignments: simulate category balances month by month --------------------------------
  // Each month's plan is funded from what was left to assign at the end of the previous month (last month's
  // payroll), overspending is covered in the month it happens, and the remainder goes to Savings.
  // Exception (Appendix A): Oct 2026 is left overspent on credit in Misc and Eating Out.
  const onBudget = new Set(d.accounts.filter((a) => a.onBudget).map((a) => a.id));
  const activity = new Map<string, bigint>();
  const addActivity = (month: Month, categoryId: string | null | undefined, amount: bigint) => {
    if (!categoryId) return;
    const key = `${month}|${categoryId}`;
    activity.set(key, (activity.get(key) ?? 0n) + amount);
  };
  const splitsByTx = new Map<string, Ins<typeof s.transactionSplits>[]>();
  for (const line of d.transactionSplits) splitsByTx.set(line.transactionId, [...(splitsByTx.get(line.transactionId) ?? []), line]);
  for (const t of d.transactions) {
    if (!onBudget.has(t.accountId) || t.id === pendingGas.id) continue;
    if (t.isSplit) for (const line of splitsByTx.get(t.id) ?? []) addActivity(monthOf(t.date), line.categoryId, line.amountMilli);
    else addActivity(monthOf(t.date), t.categoryId, t.amountMilli);
  }
  const act = (m: Month, c: Category) => activity.get(`${m}|${c.id}`) ?? 0n;

  /** n days ago, kept inside this month (the overspending belongs to it). */
  const thisMonthAgo = (n: number) => (addDays(TODAY, -n) < LAST ? LAST : addDays(TODAY, -n));
  const overspend = new Map<string, { amount: bigint; merchant: Merchant; date: string; card: Account }>([
    [C.misc.id, { amount: $("137.42"), merchant: M.lowes, date: thisMonthAgo(3), card: cashBackCard }],
    [C.eatingOut.id, { amount: $("64.18"), merchant: M.copperKettle, date: thisMonthAgo(4), card: rewardsCard }],
  ]);
  const LEFTOVER_RTA = $("412.18");
  const futureAssignments: [Category, bigint][] = [[C.autoInsurance, $("190")], [C.gifts, $("100")]];
  const carry = new Map<string, bigint>();
  let pool = 0n;
  const rtaInflow = (m: Month, onlyPayroll: boolean) =>
    sumMilli(
      d.transactions
        .filter((t) => onBudget.has(t.accountId) && t.categoryId === rta.id && monthOf(t.date) === m && (t.payeeId === employerPayroll.id) === onlyPayroll)
        .map((t) => t.amountMilli),
    );
  for (const m of months) {
    const isFirst = m === FIRST;
    const isLast = m === LAST;
    const budget = pool + rtaInflow(m, false);
    const assigned = new Map<string, bigint>();
    for (const c of d.categories as Category[]) {
      const plan = plans.get(c.id);
      if (!plan) continue;
      const carried = carry.get(c.id) ?? 0n;
      let a = plan.monthly ? plan.monthly(m) : plan.refillTo! > carried ? plan.refillTo! - carried : 0n;
      if (isFirst) a += plan.initial ?? 0n;
      const os = isLast ? overspend.get(c.id) : undefined;
      if (os) {
        const available = carried + a + act(m, c);
        if (available > -os.amount) {
          const extra = available + os.amount;
          tx({ account: os.card, date: os.date, amount: -extra, payee: os.merchant.payee, category: c, raw: os.merchant.raw() });
          addActivity(m, c.id, -extra);
        }
      } else {
        const available = carried + a + act(m, c);
        if (available < 0n) a -= available;
      }
      assigned.set(c.id, a);
    }
    if (isFirst) for (const card of cards) assigned.set(ccFor.get(card.id)!.id, -balanceOn(card, firstDay));
    let total = sumMilli(assigned.values());
    const future = isLast ? sumMilli(futureAssignments.map(([, a]) => a)) : 0n;
    const toSavings = budget - total - (isLast ? LEFTOVER_RTA + future : 0n);
    const savingsAvailable = (carry.get(C.savings.id) ?? 0n) + toSavings + act(m, C.savings);
    if (savingsAvailable < 0n) throw new Error(`demo plan overspends Savings in ${m} by ${-savingsAvailable}`);
    assigned.set(C.savings.id, toSavings);
    total += toSavings;
    pool = budget + rtaInflow(m, true) - total;
    for (const [categoryId, assignedMilli] of assigned) {
      if (assignedMilli !== 0n) d.monthAssignments.push({ month: m, categoryId, assignedMilli });
      if (plans.has(categoryId) || categoryId === C.savings.id) {
        const c = d.categories.find((x) => x.id === categoryId) as Category;
        const end = (carry.get(categoryId) ?? 0n) + assignedMilli + act(m, c);
        carry.set(categoryId, end > 0n ? end : 0n);
      }
    }
  }
  const nextMonth = addMonths(LAST, 1);
  for (const [c, a] of futureAssignments) d.monthAssignments.push({ month: nextMonth, categoryId: c.id, assignedMilli: a });

  // --- statuses, catz, ordering ---------------------------------------------------------
  d.transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const orderByDate = new Map<string, number>();
  const recentApprovalCutoff = addDays(TODAY, -9);
  const reconciledThrough = addDays(LAST, -1);
  const cutover = addMonths(LAST, -1);
  const unapprovedPayees = new Set([M.amazon, M.lowes, M.target, M.walmart, M.cornerCup, M.chipotle, M.copperKettle, M.etsy, M.clinic].map((x) => x.payee.id));
  const ruleIds = { kroger: rng.uuid(), payroll: rng.uuid(), netflix: rng.uuid(), chickfila: rng.uuid(), shell: rng.uuid(), lowes: rng.uuid() };
  const rulePayees = new Map([
    [M.kroger.payee.id, ruleIds.kroger],
    [employerPayroll.id, ruleIds.payroll],
    [M.netflix.payee.id, ruleIds.netflix],
    [M.chickfila.payee.id, ruleIds.chickfila],
    [M.shell.payee.id, ruleIds.shell],
  ]);
  const categoryById = new Map(d.categories.map((c) => [c.id, c as Category]));
  const aiCandidates: Txn[] = [];
  for (const t of d.transactions) {
    const n = (orderByDate.get(t.date) ?? 0) + 1;
    orderByDate.set(t.date, n);
    t.importOrder = n;
    const age = (Date.parse(TODAY) - Date.parse(t.date)) / 86_400_000;
    t.cleared = age >= 4 ? (t.accountId === checking.id && t.date <= reconciledThrough ? "reconciled" : "cleared") : "uncleared";
    t.postedAt = t.cleared === "uncleared" ? null : at(addDays(t.date, 1), 11);
    if (t.id === pendingGas.id) {
      t.cleared = "pending";
      t.postedAt = null;
    }
    if (txMeta.get(t.id)?.explicitCatz || t.isStartingBalance) continue;
    const when = `${t.date}T13:00:00.000Z`;
    if (t.transferAccountId) t.catz = { method: "transfer", confidence: 1, at: when };
    else if (t.date < cutover) t.catz = { method: "ynab", confidence: 1, at: when };
    else if (t.payeeId && rulePayees.has(t.payeeId)) t.catz = { method: "rule", confidence: 1, rule_id: rulePayees.get(t.payeeId)!, at: when };
    else if (t.date >= recentApprovalCutoff && t.payeeId && unapprovedPayees.has(t.payeeId) && t.approved) aiCandidates.push(t);
    else t.catz = { method: "history", confidence: 0.96, at: when };
  }
  // Recent, non-recurring purchases: categorized by AI but waiting for review (§9.4 0.75–0.95 band).
  for (const t of aiCandidates) {
    if (rng.chance(0.75)) {
      t.approved = false;
      const c = categoryById.get(t.categoryId ?? (splitsByTx.get(t.id)?.[0]?.categoryId ?? ""))!;
      const confidence = Math.round((0.76 + rng.next() * 0.17) * 100) / 100;
      t.catz = {
        method: "ai", confidence, model: "claude-haiku-5-5", explanation: "Matches how past purchases at this merchant were categorized",
        at: aiAt(t.date), suggestions: [{ category_id: c.id, confidence }, { category_id: (c.id === C.misc.id ? C.houseProjects : C.misc).id, confidence: Math.round((1 - confidence) * 60) / 100 }],
      };
    } else {
      t.catz = { method: "history", confidence: 0.96, at: `${t.date}T13:00:00.000Z` };
    }
  }

  // Learning log for Sept–Oct (the post-cutover window).
  for (const t of d.transactions) {
    if (t.date < cutover || !t.catz || t.catz.method === "transfer" || t.catz.method === "user") continue;
    d.categorizationEvents.push({
      id: rng.uuid(), transactionId: t.id, suggestedCategoryId: t.catz.suggestions?.[0]?.category_id ?? t.categoryId ?? null,
      finalCategoryId: t.approved ? t.categoryId : null, method: t.catz.method, confidence: t.catz.confidence,
      model: t.catz.model ?? null, inputTokens: t.catz.method === "ai" ? 1840 : null, outputTokens: t.catz.method === "ai" ? 62 : null,
      costUsd: t.catz.method === "ai" ? "0.002150" : null, accepted: t.approved ? true : null, at: new Date(t.catz.at),
    });
  }
  for (const t of lowesCorrections) {
    d.categorizationEvents.push({ id: rng.uuid(), transactionId: t.id, suggestedCategoryId: C.misc.id, finalCategoryId: C.houseProjects.id, method: "history", confidence: 0.81, accepted: false, userId: sam.id, at: at(t.date, 23) });
  }
  // --- reconciliations (Checking, monthly through September) ---------------------------------
  for (const m of months) {
    const eom = dateIn(m, 31);
    if (eom > reconciledThrough) break;
    const bal = balanceOn(checking, eom);
    d.reconciliations.push({ id: rng.uuid(), accountId: checking.id, at: at(addDays(eom, 1), 14), statementDate: eom, statementBalanceMilli: bal, clearedBalanceMilli: bal, userId: alex.id });
  }

  // --- balances, holdings, home value, mortgage -----------------------------------------------
  const ledgerAccounts = [checking, savings, cashBackCard, rewardsCard, mercury];
  for (const a of ledgerAccounts) {
    const byDate = new Map<string, bigint>();
    for (const t of d.transactions) if (t.accountId === a.id && t.cleared !== "pending") byDate.set(t.date, (byDate.get(t.date) ?? 0n) + t.amountMilli);
    let bal = 0n;
    for (const day of allDays) {
      bal += byDate.get(day) ?? 0n;
      d.balances.push({ accountId: a.id, asOf: day, currentMilli: bal, availableMilli: a.kind === "credit_card" ? null : bal, source: a.source });
    }
  }

  // Prices: integer 1e-4 dollars; quantities: integer 1e-8 units. value (milli) = qty × price / 1e9.
  interface Instrument { symbol: string; name: string; priceE4: bigint; drift: number; vol: number; weekdaysOnly: boolean }
  const instrument = (symbol: string, name: string, price: string, drift: number, vol: number, weekdaysOnly = true): Instrument => ({
    symbol, name, priceE4: parseMilli(price) * 10n, drift, vol, weekdaysOnly,
  });
  const I = {
    fxaix: instrument("FXAIX", "Fidelity 500 Index Fund", "205.40", 0.0007, 0.009),
    fzilx: instrument("FZILX", "Fidelity ZERO International Index Fund", "14.20", 0.00025, 0.008),
    spaxx: instrument("SPAXX", "Fidelity Government Money Market", "1", 0, 0),
    fdeex: instrument("FDEEX", "Fidelity Freedom 2055 Fund", "17.10", 0.00032, 0.007),
    vffvx: instrument("VFFVX", "Vanguard Target Retirement 2055 Fund", "54.30", 0.0006, 0.007),
    btc: instrument("BTC", "Bitcoin", "94000", -0.001, 0.02, false),
    eth: instrument("ETH", "Ethereum", "1800", 0.0006, 0.035, false),
  };
  interface Position { account: Account; inst: Instrument; lotKey: string | null; qtyE8: bigint; costMilli: bigint }
  const valueOf = (qtyE8: bigint, priceE4: bigint) => divRound(qtyE8 * priceE4, 1_000_000_000n);
  const position = (account: Account, inst: Instrument, qty: string, lotKey: string | null = null): Position => {
    const qtyE8 = BigInt(fixedToInt(qty, 8));
    return { account, inst, lotKey, qtyE8, costMilli: roundToCents(divRound(valueOf(qtyE8, inst.priceE4) * 88n, 100n)) };
  };
  const positions: Position[] = [
    position(brokerage, I.fxaix, "160"),
    position(brokerage, I.fzilx, "600"),
    position(brokerage, I.spaxx, "1250"),
    position(k401Alex, I.fdeex, "2900", "deferral"),
    position(k401Alex, I.fdeex, "1100", "match"),
    position(k401Sam, I.vffvx, "520"),
    position(coinbase, I.btc, "0.08214"),
    position(coinbase, I.eth, "1.4205"),
    position(river, I.btc, "0.215"),
  ];
  const buyInto = (p: Position, amount: bigint) => {
    p.qtyE8 += divRound(amount * 1_000_000_000n, p.inst.priceE4);
    p.costMilli += amount;
  };
  const findPos = (a: Account, inst: Instrument, lot: string | null = null) => positions.find((p) => p.account === a && p.inst === inst && p.lotKey === lot)!;
  const investmentAccounts = [brokerage, k401Alex, k401Sam, coinbase, river];
  for (const [i, day] of allDays.entries()) {
    const wd = weekday(day);
    if (i > 0) {
      for (const inst of Object.values(I)) {
        if (inst.vol === 0 || (inst.weekdaysOnly && (wd === 0 || wd === 6))) continue;
        const ppm = BigInt(Math.round((inst.drift + inst.vol * rng.gauss()) * 1_000_000));
        inst.priceE4 = divRound(inst.priceE4 * (1_000_000n + ppm), 1_000_000n);
      }
    }
    const brokerageBuy = brokerageBuys.get(day);
    if (brokerageBuy) buyInto(findPos(brokerage, I.fxaix), brokerageBuy);
    if (payrollDates.has(day)) {
      const pr = payrollFor(monthOf(day));
      buyInto(findPos(k401Alex, I.fdeex, "deferral"), pr.deferral);
      buyInto(findPos(k401Alex, I.fdeex, "match"), pr.match);
    }
    if (day.endsWith("-15")) buyInto(findPos(k401Sam, I.vffvx), $("450"));
    for (const a of investmentAccounts) {
      let total = 0n;
      for (const p of positions.filter((x) => x.account === a)) {
        const value = valueOf(p.qtyE8, p.inst.priceE4);
        total += value;
        d.holdings.push({
          id: rng.uuid(), accountId: a.id, asOf: day, symbol: p.inst.symbol, name: p.inst.name, quantity: fixed(p.qtyE8, 8),
          price: fixed(p.inst.priceE4, 4), marketValueMilli: value, costBasisMilli: p.costMilli, lotKey: p.lotKey,
        });
      }
      d.balances.push({ accountId: a.id, asOf: day, currentMilli: total, source: a.source });
    }
  }

  // Home: valued monthly (RentCast on the 2nd), balance follows the latest valuation.
  const homeAsset = { id: rng.uuid(), kind: "home" as const, name: "Home", address: "123 Maple St, Fairview, VA 00000", purchasePriceMilli: $("385000"), purchaseDate: "2023-06-15", accountId: home.id };
  d.assets.push(homeAsset);
  let homeValue = 402_000;
  const valuationDates = [firstDay, ...months.slice(1).map((m) => dateIn(m, 2))].filter(isPast);
  const valueByDate = new Map<string, bigint>();
  for (const [i, day] of valuationDates.entries()) {
    if (i > 0) homeValue = Math.round((homeValue * (1.0025 + 0.006 * rng.gauss())) / 1000) * 1000;
    const value = BigInt(homeValue) * 1000n;
    valueByDate.set(day, value);
    d.assetValuations.push({
      id: rng.uuid(), assetId: homeAsset.id, asOf: day, valueMilli: value,
      lowMilli: BigInt(Math.round((homeValue * 0.94) / 1000) * 1000) * 1000n, highMilli: BigInt(Math.round((homeValue * 1.06) / 1000) * 1000) * 1000n,
      source: i === 0 ? "manual" : "rentcast",
      comps: i === 0 ? null : [{ address: "131 Maple St", price: homeValue + 6000, distance_mi: 0.1 }, { address: "88 Oak Hollow Rd", price: homeValue - 11000, distance_mi: 0.4 }],
    });
  }
  let currentHome = 0n;
  for (const day of allDays) {
    currentHome = valueByDate.get(day) ?? currentHome;
    d.balances.push({ accountId: home.id, asOf: day, currentMilli: currentHome, source: "rentcast" });
  }

  // Mortgage: 6.5% fixed, 30 years, first payment 2023-08-01; balance after each payment, exact in milli.
  const loan = { principal: $("308000"), pi: $("1946.77"), escrow: $("520"), firstPayment: "2023-08-01" };
  d.loans.push({ accountId: mortgage.id, servicer: "Woodgrove Bank", originalPrincipalMilli: loan.principal, annualRate: "0.065000", termMonths: 360, firstPaymentDate: loan.firstPayment, piPaymentMilli: loan.pi, escrowMilli: loan.escrow });
  let principal = loan.principal;
  const pay = () => {
    const interest = divRound(principal * 65n, 12_000n);
    principal -= loan.pi - interest;
  };
  for (let m: Month = loan.firstPayment; m < firstDay; m = addMonths(m, 1)) pay();
  for (const day of allDays) {
    if (day.endsWith("-01")) pay();
    if (day === extraPrincipal.date) principal -= extraPrincipal.amount;
    d.balances.push({ accountId: mortgage.id, asOf: day, currentMilli: -principal, source: "amortization" });
  }
  d.loanEvents.push(
    { id: rng.uuid(), accountId: mortgage.id, date: extraPrincipal.date, kind: "extra_principal", amountMilli: extraPrincipal.amount, note: "From Extra House Payments" },
    { id: rng.uuid(), accountId: mortgage.id, date: LAST, kind: "statement_balance", amountMilli: principal, note: `${monthName(LAST)} statement` },
  );

  // --- scheduled transactions ---------------------------------------------------------------
  /** The next time day-of-month `day` comes around after today. */
  const nextOn = (day: number) => (dateIn(LAST, day) > TODAY ? dateIn(LAST, day) : dateIn(addMonths(LAST, 1), day));
  const nextPayday = payday(LAST) > TODAY ? payday(LAST) : payday(addMonths(LAST, 1));
  const scheduled = (o: Omit<Ins<typeof s.scheduledTransactions>, "id" | "firstDate"> & { firstDate?: string }, lines?: [Category, string, string?][]) => {
    const row = { id: rng.uuid(), firstDate: o.firstDate ?? FIRST, ...o, isSplit: !!lines };
    d.scheduledTransactions.push(row);
    lines?.forEach(([c, amount, memo], i) =>
      d.scheduledTransactionSplits.push({ id: rng.uuid(), scheduledTransactionId: row.id, categoryId: c.id, amountMilli: $(amount), memo: memo ?? null, sort: i }),
    );
  };
  scheduled({ accountId: checking.id, payeeId: employerPayroll.id, categoryId: rta.id, amountMilli: $("8305"), frequency: "monthly", nextDate: nextPayday, memo: "Payroll (25th or prior business day)" });
  scheduled({ accountId: checking.id, payeeId: transferPayee.get(mortgage.id)!.id, categoryId: C.mortgage.id, transferAccountId: mortgage.id, amountMilli: $("-2466.77"), frequency: "monthly", nextDate: nextOn(1) });
  scheduled({ accountId: checking.id, payeeId: anthem.id, categoryId: C.health.id, amountMilli: $("-480"), frequency: "monthly", nextDate: nextOn(1) });
  scheduled({ accountId: checking.id, payeeId: givingFund.id, categoryId: C.giving.id, amountMilli: $("-500"), frequency: "monthly", nextDate: nextOn(2) });
  scheduled({ accountId: checking.id, payeeId: power.id, categoryId: C.electricity.id, amountMilli: $("-150"), frequency: "monthly", nextDate: nextOn(12), memo: "Estimate" });
  scheduled({ accountId: checking.id, payeeId: progressive.id, categoryId: C.autoInsurance.id, amountMilli: $("-1140"), frequency: "twice_yearly", nextDate: rel("2026-12-05"), firstDate: rel("2025-06-05") });
  scheduled({ accountId: checking.id, payeeId: transferPayee.get(savings.id)!.id, transferAccountId: savings.id, amountMilli: $("-500"), frequency: "monthly", nextDate: nextOn(26) });
  scheduled({ accountId: checking.id, payeeId: transferPayee.get(brokerage.id)!.id, transferAccountId: brokerage.id, categoryId: C.alexRetirement.id, amountMilli: $("-300"), frequency: "monthly", nextDate: nextOn(26), memo: "Alex Roth IRA" });
  scheduled({ accountId: checking.id, payeeId: transferPayee.get(brokerage.id)!.id, transferAccountId: brokerage.id, categoryId: C.samRetirement.id, amountMilli: $("-200"), frequency: "monthly", nextDate: nextOn(26), memo: "Sam Roth IRA" });
  scheduled({ accountId: rewardsCard.id, payeeId: M.netflix.payee.id, categoryId: C.entertainment.id, amountMilli: $("-17.99"), frequency: "monthly", nextDate: nextOn(9) });
  scheduled({ accountId: cashBackCard.id, payeeId: M.ynab.payee.id, categoryId: C.ynab.id, amountMilli: $("-109"), frequency: "yearly", nextDate: rel("2027-02-10"), firstDate: rel("2026-02-10") });
  scheduled({ accountId: cashBackCard.id, payeeId: M.costcoRenewal.payee.id, categoryId: C.costcoMembership.id, amountMilli: $("-130"), frequency: "yearly", nextDate: rel("2027-03-14"), firstDate: rel("2026-03-14") });
  scheduled({ accountId: cashBackCard.id, payeeId: M.amazon.payee.id, amountMilli: $("-85.60"), frequency: "monthly", nextDate: nextOn(28), memo: "Subscribe & Save" }, [
    [C.groceries, "-35", "coffee, snacks"],
    [C.pets, "-28.50", "cat litter"],
    [C.misc, "-22.10", "paper towels"],
  ]);

  // --- rules, memory, notes, settings, history ---------------------------------------------
  const contains = (field: string, value: string) => ({ field, op: "contains", value });
  const setCategory = (c: Category) => ({ type: "set_category", category_id: c.id });
  d.rules.push(
    { id: ruleIds.kroger, name: "Kroger → Groceries", priority: 10, source: "user", conditions: { all: [contains("raw_description", "KROGER")] }, actions: [setCategory(C.groceries), { type: "approve" }], hitCount: 81, lastHitAt: at(recent("2026-10-17")), createdBy: alex.id },
    { id: ruleIds.payroll, name: "Northwind payroll → Ready to Assign", priority: 10, source: "user", conditions: { all: [contains("raw_description", "NORTHWIND STUDIO PAYROLL")] }, actions: [{ type: "set_payee", payee_id: employerPayroll.id }, setCategory(rta)], hitCount: 17, lastHitAt: at(recent("2026-09-25")), createdBy: alex.id },
    { id: ruleIds.netflix, name: "Netflix → Entertainment", priority: 20, source: "user", conditions: { all: [contains("raw_description", "NETFLIX")] }, actions: [setCategory(C.entertainment), { type: "approve" }], hitCount: 18, lastHitAt: at(recent("2026-10-09")), createdBy: sam.id },
    { id: ruleIds.chickfila, name: "Chick-fil-A → Eating Out", priority: 100, source: "learned", conditions: { all: [contains("payee", "Chick-fil-A")] }, actions: [setCategory(C.eatingOut), { type: "approve" }], hitCount: 9, lastHitAt: at(recent("2026-10-16")) },
    { id: ruleIds.shell, name: "Shell → Gas", priority: 100, source: "learned", conditions: { all: [contains("raw_description", "SHELL OIL")] }, actions: [setCategory(C.gas), { type: "approve" }], hitCount: 12, lastHitAt: at(recent("2026-10-19")) },
    { id: ruleIds.lowes, name: "Lowe's over $100 → House Projects", priority: 150, enabled: false, source: "ai_suggested", conditions: { all: [contains("payee", "Lowe's"), { field: "amount_milli", op: "lte", value: "-100000" }] }, actions: [setCategory(C.houseProjects)] },
  );
  for (const [text, by] of [
    [`Giving is a flat $500 a month from January ${rel("2026-01-01").slice(0, 4)}.`, alex],
    ["Costco runs are mostly groceries; about a fifth is household supplies.", sam],
    ["Lowe's purchases over $100 are usually House Projects, not Misc.", sam],
    ["Alex is paid monthly by Northwind Studio via Gusto on the 25th (or the business day before).", alex],
    ["Mercury accounts belong to Northwind Studio LLC and never count toward the household budget.", alex],
  ] as const) d.householdMemory.push({ id: rng.uuid(), text, createdBy: by.id });
  d.monthNotes.push(
    { id: rng.uuid(), month: LAST, categoryId: null, note: `Car registration due in ${monthName(addMonths(LAST, 1))}.` },
    { id: rng.uuid(), month: LAST, categoryId: C.misc.id, note: "Fence repair at Lowe's — should probably move to House Projects." },
  );
  d.savedReports.push({ id: rng.uuid(), name: "Eating out: this year vs last", pinned: true, createdBy: alex.id, spec: { type: "bar", title: "Eating out by year", x: "year", y: "spend_milli", format: "currency", source: "v_transactions_flat", filters: { category: "Eating Out" } } });
  const opAt = at(recent("2026-10-03"), 1);
  d.budgetOperations.push(
    { id: rng.uuid(), at: opAt, userId: alex.id, kind: "auto_assign", month: LAST, payload: { mode: "underfunded" }, inverse: { mode: "reset_assigned" } },
    { id: rng.uuid(), at: at(recent("2026-10-10"), 22), userId: sam.id, kind: "move", month: LAST, payload: { from: C.entertainment.id, to: C.dates.id, amount_milli: "20000" }, inverse: { from: C.dates.id, to: C.entertainment.id, amount_milli: "20000" } },
  );
  d.auditLog.push(
    { id: rng.uuid(), at: opAt, userId: alex.id, actor: "user", action: "budget.auto_assign", entity: "month", entityId: LAST, after: { mode: "underfunded" } },
    { id: rng.uuid(), at: at(recent("2026-10-10"), 22), userId: sam.id, actor: "user", action: "budget.move", entity: "category", entityId: C.dates.id, before: { assigned_milli: "150000" }, after: { assigned_milli: "170000" } },
  );
  d.settings.push(
    { key: "demo_seed", value: { seed: DEMO_SEED, today: TODAY, first_month: FIRST } },
    { key: "approval_policy", value: { auto_approve_rule_history_min_confidence: 0.95, auto_approve_ai_min_confidence: 0.95, auto_approve_ai_max_abs_milli: "150000", auto_categorize_min_confidence: 0.75, income_review_over_milli: "500000", income_review_first_n: 3 } },
    { key: "ai_models", value: { categorize: "claude-haiku-5-5", merchant_lookup: "claude-sonnet-5-5", chat: "claude-sonnet-5-5" } },
    { key: "timezone", value: "America/New_York" },
  );

  return d;
}

/** The public demo: the same (already fictional) data. Visitors sign in as the admin; give them the brand's default gold. */
export function publicDemoData(d: DemoData): DemoData {
  return { ...d, users: d.users.map((u) => (u.role === "admin" ? { ...u, accent: "gold" } : u)) };
}

/** "1.4205" → 142050000 at scale 8 (exact; no floats). */
function fixedToInt(value: string, scale: number): string {
  const [whole, frac = ""] = value.split(".");
  return `${whole}${frac.padEnd(scale, "0").slice(0, scale)}`.replace(/^0+(?=\d)/, "");
}

export function allTableNames(): string[] {
  return Object.values(s as Record<string, unknown>)
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getTableName(t));
}

export type DemoCounts = Record<keyof DemoData, number>;

/** Truncate every table and insert the demo data in one transaction. */
export async function seedDemo(db: Db, opts: { force?: boolean; today?: string; public?: boolean } = {}): Promise<DemoCounts> {
  const data = opts.public ? publicDemoData(buildDemoData(opts.today)) : buildDemoData(opts.today);
  await db.transaction(async (tx) => {
    if (!opts.force) {
      const marker = await tx.select({ key: s.settings.key }).from(s.settings).where(sql`${s.settings.key} = 'demo_seed'`);
      const hasData = await tx.select({ id: s.transactions.id }).from(s.transactions).limit(1);
      if (marker.length === 0 && hasData.length > 0) {
        throw new Error("Refusing to seed: this database has transactions that are not demo data. Re-run with --force to wipe it.");
      }
    }
    await tx.execute(sql.raw(`TRUNCATE ${allTableNames().map((n) => `"${n}"`).join(", ")} RESTART IDENTITY CASCADE`));
    for (const { key, table } of INSERT_ORDER) {
      // Self-referencing transfer pairs are linked after all rows exist.
      const rows = key === "transactions" ? data.transactions.map((t) => ({ ...t, transferPairId: null })) : (data[key] as unknown[]);
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(table).values(rows.slice(i, i + 500) as never);
      }
    }
    const pairs = data.transactions.filter((t) => t.transferPairId);
    for (let i = 0; i < pairs.length; i += 1000) {
      const values = sql.join(pairs.slice(i, i + 1000).map((t) => sql`(${t.id}::uuid, ${t.transferPairId}::uuid)`), sql`, `);
      await tx.execute(sql`UPDATE transactions t SET transfer_pair_id = v.pair FROM (VALUES ${values}) AS v(id, pair) WHERE t.id = v.id`);
    }
  });
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (v as unknown[]).length])) as DemoCounts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { db, pool } = createDb(env().DATABASE_URL);
  const isPublic = process.argv.includes("--public");
  const today = isPublic || process.argv.includes("--rolling") ? localToday() : DEMO_TODAY;
  seedDemo(db, { force: process.argv.includes("--force"), today, public: isPublic })
    .then((counts) => {
      console.log(`demo data seeded (today = ${today}):`);
      for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(28)} ${n}`);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
