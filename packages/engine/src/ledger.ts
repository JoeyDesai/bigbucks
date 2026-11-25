/**
 * Ledger preparation: turns a BudgetSnapshot into ordered, classified budget "lines" (one per
 * transaction or split line), with credit-card balance tracking (§6.1, §6.4).
 * Internal module — the public surface is computeBudget().
 */
import { monthOf } from "@homebase/shared";
import type {
  BudgetSnapshot,
  EngineAccount,
  EngineCategory,
  EngineTransaction,
  ISODate,
  Milli,
  Month,
  ResolvedBudgetOptions,
} from "./types";

export const VIRTUAL_UNCATEGORIZED_ID = "__uncategorized__";
export const virtualPaymentCategoryId = (accountId: string) => `__cc_payment__:${accountId}`;

/** What a line does to the budget. */
export type LineEffect =
  /** Activity in a normal or uncategorized category. */
  | { kind: "category"; categoryId: string }
  /** Inflow (or outflow) categorized to Ready to Assign. */
  | { kind: "rta" }
  /** Credit-account line categorized to Ready to Assign under `cardRtaLines: debt_only`. */
  | { kind: "card_rta" }
  /** Categorized directly to a payment category (e.g. interest). */
  | { kind: "payment_direct"; categoryId: string }
  /** Transfer between a credit account and an on-budget cash account (payment / cash advance). */
  | { kind: "card_transfer" }
  /** No budget effect (on-budget↔on-budget transfer, card↔card transfer, card starting debt). */
  | { kind: "none" };

export interface Line {
  /** Global processing order (date, importOrder, id, split index). */
  seq: number;
  txnId: string;
  lineIndex: number;
  accountId: string;
  date: ISODate;
  month: Month;
  amount: Milli;
  categoryId: string | null;
  transferAccountId: string | null;
  isStartingBalance: boolean;
  /** Account is an on-budget credit account (card / line of credit). */
  onCredit: boolean;
  /** Counterpart of a transfer is an on-budget account. */
  transferOnBudget: boolean;
  transferIsCredit: boolean;
  effect: LineEffect;
  /** Credit accounts: payment category of this card. */
  paymentCategoryId: string | null;
  /** Outflows: magnitude paid from cash (cash account, or a card's positive balance). */
  cashPortion: Milli;
  /** Outflows on a card: magnitude that added card debt. */
  creditPortion: Milli;
  /** Inflows on a card: magnitude that raised the balance above zero. */
  positiveIncrease: Milli;
}

export interface Ledger {
  accounts: Map<string, EngineAccount>;
  categories: Map<string, EngineCategory>;
  /** Categories in display order (group sort, category sort), including virtual ones. */
  orderedCategories: EngineCategory[];
  creditAccounts: Set<string>;
  /** card accountId → payment category id */
  paymentCategoryByAccount: Map<string, string>;
  uncategorizedId: string;
  rtaIds: Set<string>;
  lines: Line[];
  /** Per credit account: balance delta by month (all non-pending, non-deleted lines). */
  cardDeltaByMonth: Map<string, Map<Month, Milli>>;
  firstMonth: Month | null;
  lastMonth: Month | null;
  warnings: string[];
}

const CREDIT_KINDS = new Set(["credit_card", "line_of_credit"]);

export function compareTxn(a: EngineTransaction, b: EngineTransaction): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ao = a.importOrder ?? Number.MAX_SAFE_INTEGER;
  const bo = b.importOrder ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildLedger(s: BudgetSnapshot, opts: Pick<ResolvedBudgetOptions, "cardStartingDebt"> & Partial<Pick<ResolvedBudgetOptions, "cardRtaLines">>): Ledger {
  const warnings: string[] = [];
  const accounts = new Map(s.accounts.map((a) => [a.id, a]));
  const categories = new Map(s.categories.map((c) => [c.id, c]));
  const groups = new Map(s.groups.map((g) => [g.id, g]));

  const rtaIds = new Set(s.categories.filter((c) => c.kind === "internal_rta").map((c) => c.id));
  let uncategorizedId = s.categories.find((c) => c.kind === "uncategorized" && !c.deleted)?.id ?? s.categories.find((c) => c.kind === "uncategorized")?.id;
  const virtual: EngineCategory[] = [];
  if (!uncategorizedId) {
    uncategorizedId = VIRTUAL_UNCATEGORIZED_ID;
    const v: EngineCategory = { id: uncategorizedId, groupId: "__internal__", name: "Uncategorized", kind: "uncategorized", linkedAccountId: null, hidden: false, sort: -1 };
    categories.set(v.id, v);
    virtual.push(v);
  }

  const paymentCategoryByAccount = new Map<string, string>();
  for (const c of s.categories) {
    if (c.kind !== "cc_payment") continue;
    if (!c.linkedAccountId) {
      warnings.push(`payment category ${c.id} has no linked account`);
      continue;
    }
    const prev = paymentCategoryByAccount.get(c.linkedAccountId);
    // prefer a non-deleted category if several point at the same card
    if (!prev || (categories.get(prev)?.deleted && !c.deleted)) paymentCategoryByAccount.set(c.linkedAccountId, c.id);
  }
  const creditAccounts = new Set<string>();
  for (const a of s.accounts) {
    if (!a.onBudget) continue;
    if (CREDIT_KINDS.has(a.kind) || paymentCategoryByAccount.has(a.id)) {
      creditAccounts.add(a.id);
      if (!paymentCategoryByAccount.has(a.id)) {
        const id = virtualPaymentCategoryId(a.id);
        const v: EngineCategory = { id, groupId: "__credit_card_payments__", name: a.name ?? a.id, kind: "cc_payment", linkedAccountId: a.id, hidden: false, sort: 0 };
        categories.set(id, v);
        virtual.push(v);
        paymentCategoryByAccount.set(a.id, id);
        warnings.push(`credit account ${a.id} has no payment category; using virtual ${id}`);
      }
    }
  }

  const groupSort = (c: EngineCategory) => groups.get(c.groupId)?.sort ?? (c.kind === "cc_payment" ? -1 : Number.MAX_SAFE_INTEGER);
  const orderedCategories = [...categories.values()].sort((a, b) => groupSort(a) - groupSort(b) || a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ── transactions → lines ──────────────────────────────────────────────────
  const txns = s.transactions.filter((t) => {
    if (t.deleted || t.cleared === "pending") return false;
    const a = accounts.get(t.accountId);
    if (!a) {
      warnings.push(`transaction ${t.id} references unknown account ${t.accountId}`);
      return false;
    }
    return a.onBudget;
  });
  txns.sort(compareTxn);

  const lines: Line[] = [];
  const cardBalance = new Map<string, Milli>();
  const cardDeltaByMonth = new Map<string, Map<Month, Milli>>();
  let firstMonth: Month | null = null;
  let lastMonth: Month | null = null;
  let seq = 0;

  for (const t of txns) {
    const month = monthOf(t.date);
    if (!firstMonth || month < firstMonth) firstMonth = month;
    if (!lastMonth || month > lastMonth) lastMonth = month;
    const onCredit = creditAccounts.has(t.accountId);
    const parts = t.splits && t.splits.length > 0 ? t.splits : [{ amount: t.amount, categoryId: t.categoryId, transferAccountId: t.transferAccountId }];
    if (t.splits && t.splits.length > 0) {
      let sum = 0n;
      for (const p of t.splits) sum += p.amount;
      if (sum !== t.amount) warnings.push(`split transaction ${t.id}: lines sum to ${sum}, parent amount ${t.amount}`);
    }
    parts.forEach((p, lineIndex) => {
      const counterpart = p.transferAccountId ? accounts.get(p.transferAccountId) : undefined;
      if (p.transferAccountId && !counterpart) warnings.push(`transaction ${t.id}: unknown transfer account ${p.transferAccountId}`);
      const transferOnBudget = !!counterpart?.onBudget;
      const transferIsCredit = !!counterpart && creditAccounts.has(counterpart.id);
      const line: Line = {
        seq: seq++,
        txnId: t.id,
        lineIndex,
        accountId: t.accountId,
        date: t.date,
        month,
        amount: p.amount,
        categoryId: p.categoryId,
        transferAccountId: p.transferAccountId,
        isStartingBalance: !!t.isStartingBalance,
        onCredit,
        transferOnBudget,
        transferIsCredit,
        effect: { kind: "none" },
        paymentCategoryId: onCredit ? (paymentCategoryByAccount.get(t.accountId) ?? null) : null,
        cashPortion: 0n,
        creditPortion: 0n,
        positiveIncrease: 0n,
      };

      // classification
      if (transferOnBudget) {
        line.effect = onCredit && !transferIsCredit ? { kind: "card_transfer" } : { kind: "none" };
      } else if (onCredit && t.isStartingBalance && p.amount < 0n && opts.cardStartingDebt === "no_budget_effect") {
        line.effect = { kind: "none" };
      } else {
        let cid = p.categoryId;
        // starting balances with no category: cash (and a card's credit balance) → Ready to Assign (§6.2)
        if (cid === null && t.isStartingBalance && (!onCredit || p.amount > 0n) && rtaIds.size > 0) cid = [...rtaIds][0]!;
        if (cid !== null && rtaIds.has(cid)) line.effect = onCredit && opts.cardRtaLines !== "income" ? { kind: "card_rta" } : { kind: "rta" };
        else {
          let cat = cid !== null ? categories.get(cid) : undefined;
          if (cid !== null && !cat) warnings.push(`transaction ${t.id}: unknown category ${cid}; treated as uncategorized`);
          if (!cat) cat = categories.get(uncategorizedId)!;
          line.effect = cat.kind === "cc_payment" ? { kind: "payment_direct", categoryId: cat.id } : { kind: "category", categoryId: cat.id };
        }
      }

      // balances / cash vs credit portions
      if (onCredit) {
        const B = cardBalance.get(t.accountId) ?? 0n;
        if (p.amount < 0n) {
          const A = -p.amount;
          const pos = B > 0n ? (A < B ? A : B) : 0n;
          line.cashPortion = pos;
          line.creditPortion = A - pos;
        } else if (p.amount > 0n) {
          const before = B > 0n ? B : 0n;
          const after = B + p.amount > 0n ? B + p.amount : 0n;
          line.positiveIncrease = after - before;
        }
        cardBalance.set(t.accountId, B + p.amount);
        const byMonth = cardDeltaByMonth.get(t.accountId) ?? new Map<Month, Milli>();
        byMonth.set(month, (byMonth.get(month) ?? 0n) + p.amount);
        cardDeltaByMonth.set(t.accountId, byMonth);
      } else if (p.amount < 0n) {
        line.cashPortion = -p.amount;
      }
      lines.push(line);
    });
  }

  return {
    accounts,
    categories,
    orderedCategories,
    creditAccounts,
    paymentCategoryByAccount,
    uncategorizedId,
    rtaIds,
    lines,
    cardDeltaByMonth,
    firstMonth,
    lastMonth,
    warnings: [...new Set(warnings)],
  };
}
