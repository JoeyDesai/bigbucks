import "server-only";
import { householdEntityId, listAccounts, listTransactions, reviewInbox, type AccountSummary, type InboxItem, type TransactionFilters, type TransactionRow } from "@homebase/core";
import type { AccountVM, ConnectionStatus, SuggestionVM, TransactionVM, WealthSection } from "@/lib/view-models";
import { getDb } from "../db";
import { cleanLabel, sourceLabel } from "@/lib/format";

export function toTransactionVM(r: TransactionRow): TransactionVM {
  const splitLabel = r.isSplit ? `Split · ${r.splits.length} categories` : null;
  return {
    id: r.id,
    date: r.date,
    payee: r.payeeName ?? r.rawDescription ?? "No payee",
    rawDescription: r.rawDescription ?? "",
    amount: r.amount,
    accountId: r.accountId,
    accountName: r.accountName,
    categoryId: r.categoryId,
    categoryName: splitLabel ?? r.categoryName,
    memo: r.memo ?? undefined,
    cleared: r.cleared,
    approved: r.approved,
    splits: r.isSplit ? r.splits.map((s) => ({ id: s.id, categoryId: s.categoryId, categoryName: s.categoryName, amount: s.amount, memo: s.memo ?? undefined })) : undefined,
    transferAccountName: r.transferAccountName ?? undefined,
    runningBalance: r.runningBalance ?? undefined,
    payeeId: r.payeeId,
    flag: r.flag,
  };
}

export function toInboxVM(r: InboxItem): TransactionVM {
  const base = toTransactionVM(r);
  const [top, ...rest] = r.suggestions;
  const method = r.method ?? "ai";
  const suggestion: SuggestionVM | undefined =
    top && (r.confidence ?? top.confidence) >= 0.5 ? { categoryId: top.categoryId, categoryName: top.categoryName ?? "Unknown", confidence: top.confidence, method, explanation: r.explanation ?? "" } : undefined;
  const alternatives = (suggestion ? rest : r.suggestions).map((s) => ({ categoryId: s.categoryId, categoryName: s.categoryName ?? "Unknown", confidence: s.confidence, method, explanation: "" }));
  // An auto-set category with no suggestion list: show it as the suggestion.
  if (!suggestion && r.categoryId && r.catz && r.catz.method !== "user") {
    return { ...base, suggestion: { categoryId: r.categoryId, categoryName: r.categoryName ?? "", confidence: r.catz.confidence, method: r.catz.method, explanation: r.explanation ?? "" }, alternatives };
  }
  return { ...base, suggestion, alternatives };
}

const STATUS: Record<AccountSummary["statusColor"], ConnectionStatus> = { green: "ok", yellow: "needs_attention", red: "error", gray: "manual" };
const SECTION: Record<AccountSummary["kind"], WealthSection> = {
  checking: "cash",
  savings: "cash",
  cash: "cash",
  credit_card: "credit",
  line_of_credit: "credit",
  brokerage: "investments",
  hsa: "investments",
  retirement: "retirement",
  crypto: "crypto",
  property: "home",
  mortgage: "mortgage",
  loan: "mortgage",
  other: "investments",
};

/**
 * The balance to show. Tracking (off-budget) accounts use the latest reported snapshot when there is one:
 * their ledger only holds transfers (e.g. 401k contributions, mortgage payments), not market value or
 * amortization, so core's working balance is wrong for them.
 */
export function displayBalance(a: Pick<AccountSummary, "onBudget" | "syncedBalance" | "balance">): bigint {
  return !a.onBudget && a.syncedBalance !== null ? a.syncedBalance : a.balance;
}

export function toAccountVM(a: AccountSummary, householdEntityId: string | null): AccountVM {
  const updated = a.lastSyncAt ? new Date(a.lastSyncAt).toISOString() : a.syncedAsOf ? `${a.syncedAsOf}T12:00:00Z` : null;
  return {
    id: a.id,
    name: cleanLabel(a.displayName),
    institution: a.institution ?? sourceLabel(a.source),
    kind: a.kind,
    onBudget: a.onBudget,
    entity: householdEntityId && a.entityId !== householdEntityId ? "business" : "household",
    section: householdEntityId && a.entityId !== householdEntityId ? "business" : SECTION[a.kind],
    balance: displayBalance(a),
    clearedBalance: a.clearedBalance,
    unclearedBalance: a.unclearedBalance,
    closed: a.closed,
    updatedAt: a.source === "manual" || a.source === "ynab_import" ? null : updated,
    status: STATUS[a.statusColor],
    statusNote: a.connectionError ?? (a.statusColor === "yellow" ? "No fresh balance in the last 2 days. Check the connection in Settings → Connections." : undefined),
    unapprovedCount: a.unapprovedCount,
  };
}

export async function loadAccounts(today: string, opts: { includeClosed?: boolean } = {}): Promise<{ accounts: AccountVM[]; summaries: AccountSummary[] }> {
  const db = getDb();
  const summaries = await listAccounts(db, { today, includeClosed: opts.includeClosed });
  const household = await householdEntityId(db);
  return { accounts: summaries.map((a) => toAccountVM(a, household)), summaries };
}

export async function loadInbox(limit = 50) {
  const r = await reviewInbox(getDb(), { limit });
  return { count: r.count, items: r.items.map(toInboxVM), nextCursor: r.nextCursor };
}

export interface RegisterQuery {
  accountId?: string;
  q?: string;
  filter?: "all" | "uncleared" | "unapproved";
  /** Reports drill-down (§13): category ids, payee ids, date range. */
  categoryIds?: string[];
  payeeIds?: string[];
  from?: string;
  to?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `/activity?category=<id,…>&payee=&from=&to=&account=&q=&f=` into a register query. */
export function parseRegisterParams(sp: Record<string, string | string[] | undefined>, fixedAccountId?: string): RegisterQuery {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const list = (k: string) => (one(k) ?? "").split(",").map((s) => s.trim()).filter((s) => UUID.test(s)).slice(0, 50);
  const f = one("f");
  const payee = one("payee");
  const account = one("account");
  const cats = list("category");
  const payees = list("payee");
  const q = one("q")?.slice(0, 200) || (payee && !UUID.test(payee) ? payee.slice(0, 200) : undefined);
  return {
    accountId: fixedAccountId ?? (account && UUID.test(account) ? account : undefined),
    q,
    filter: f === "uncleared" || f === "unapproved" ? f : "all",
    categoryIds: cats.length ? cats : undefined,
    payeeIds: payees.length ? payees : undefined,
    from: DATE.test(one("from") ?? "") ? one("from") : undefined,
    to: DATE.test(one("to") ?? "") ? one("to") : undefined,
  };
}

export function registerFilters(q: RegisterQuery): TransactionFilters {
  return {
    accountIds: q.accountId ? [q.accountId] : undefined,
    categoryIds: q.categoryIds,
    payeeIds: q.payeeIds,
    dateFrom: q.from,
    dateTo: q.to,
    text: q.q?.trim() || undefined,
    cleared: q.filter === "uncleared" ? ["uncleared", "pending"] : undefined,
    approved: q.filter === "unapproved" ? false : undefined,
  };
}

export async function loadRegister(q: RegisterQuery, cursor?: string | null, limit = 50) {
  const page = await listTransactions(getDb(), registerFilters(q), { cursor, limit, totals: !cursor });
  return { rows: page.rows.map(toTransactionVM), nextCursor: page.nextCursor, count: page.totals?.count ?? null };
}
