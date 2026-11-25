/**
 * In-memory CategorizerRepo for tests and the evaluation harness. Mirrors the intended SQL
 * semantics (trigram payee similarity + amount ±10% for similar transactions).
 */
import { absMilli, addDays, newId, type ISODate, type Milli } from "@homebase/shared";
import type { MerchantProfile, SimilarTxn } from "@homebase/ai";
import { normalizePayee, normalizedKey } from "./normalize";
import type { CategorizationEvent, CategorizationEventInput, CategorizerRepo, SimilarQuery } from "./repo";
import type { Rule } from "./rules";
import type { TransferTxn } from "./transfers";
import type { AccountInfo, CategoryInfo, HistoryTxn, PayeeAlias, PayeeRecord, TxnInput } from "./types";

/** A stored, finalized transaction. */
export interface StoredTxn {
  id: string;
  accountId: string;
  date: ISODate;
  amountMilli: Milli;
  rawDescription: string;
  payeeKey: string;
  payeeName: string;
  categoryId: string | null;
  isSplit?: boolean;
  isTransfer?: boolean;
  transferPaired?: boolean;
  approved?: boolean;
}

function trigrams(s: string): Set<string> {
  const t = `  ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** pg_trgm-style similarity (shared trigrams / union). */
export function trigramSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared / (x.size + y.size - shared);
}

export interface InMemorySeed {
  categories?: CategoryInfo[];
  accounts?: AccountInfo[];
  memory?: string[];
  aliases?: PayeeAlias[];
  payees?: PayeeRecord[];
  rules?: Rule[];
  transactions?: StoredTxn[];
  /** Unpaired transactions visible to transfer detection. */
  pending?: StoredTxn[];
}

export class InMemoryCategorizerRepo implements CategorizerRepo {
  categories: CategoryInfo[];
  accounts: AccountInfo[];
  memory: string[];
  aliases: PayeeAlias[];
  payees: PayeeRecord[];
  rules: Rule[];
  transactions: StoredTxn[];
  pending: StoredTxn[];
  readonly events: CategorizationEvent[] = [];
  readonly ruleHits: { ruleId: string; at: string }[] = [];
  /** Minimum trigram similarity for similarTransactions (pg_trgm default is 0.3). */
  similarThreshold = 0.3;

  constructor(seed: InMemorySeed = {}) {
    this.categories = seed.categories ?? [];
    this.accounts = seed.accounts ?? [];
    this.memory = seed.memory ?? [];
    this.aliases = seed.aliases ?? [];
    this.payees = seed.payees ?? [];
    this.rules = seed.rules ?? [];
    this.transactions = seed.transactions ?? [];
    this.pending = seed.pending ?? [];
  }

  /** Helper: build a StoredTxn from a raw descriptor using the normalizer. */
  static txn(t: Omit<StoredTxn, "payeeKey" | "payeeName"> & { payeeName?: string }): StoredTxn {
    const n = normalizePayee(t.rawDescription);
    const name = t.payeeName ?? n.name;
    return { ...t, payeeName: name, payeeKey: normalizedKey(name) };
  }

  async getCategoryCatalog() {
    return this.categories;
  }
  async getAccounts() {
    return this.accounts;
  }
  async getHouseholdMemory() {
    return this.memory;
  }
  async getAliases() {
    return this.aliases;
  }
  async getPayeeById(id: string) {
    return this.payees.find((p) => p.id === id) ?? null;
  }
  async getPayeeByKey(key: string) {
    return this.payees.find((p) => p.normalizedKey === key) ?? null;
  }
  async getPayeeHistory(payeeKey: string, opts: { before?: ISODate; limit?: number } = {}): Promise<HistoryTxn[]> {
    return this.transactions
      .filter((t) => t.payeeKey === payeeKey && (!opts.before || t.date < opts.before))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, opts.limit ?? 200)
      .map((t) => ({ id: t.id, date: t.date, amountMilli: t.amountMilli, categoryId: t.categoryId, isSplit: t.isSplit ?? false, isTransfer: t.isTransfer ?? false }));
  }
  async similarTransactions(q: SimilarQuery): Promise<SimilarTxn[]> {
    const names = new Map(this.categories.map((c) => [c.id, c.name]));
    const amt = absMilli(q.amountMilli);
    const scored = this.transactions
      .filter((t) => t.id !== q.transactionId && t.date < q.before)
      .map((t) => {
        const sim = Math.max(trigramSimilarity(t.payeeName, q.payeeName), t.payeeKey === q.payeeKey ? 1 : 0);
        const a = absMilli(t.amountMilli);
        const amountClose = amt > 0n && (a > amt ? a - amt : amt - a) * 10n <= amt;
        return { t, score: sim + (amountClose ? 0.25 : 0), sim, amountClose };
      })
      .filter((x) => x.sim >= this.similarThreshold || (x.amountClose && x.sim > 0.1))
      .sort((a, b) => b.score - a.score || (a.t.date < b.t.date ? 1 : -1))
      .slice(0, q.limit);
    return scored.map(({ t }) => ({
      payee: t.payeeName,
      rawDescription: t.rawDescription,
      amountMilli: t.amountMilli,
      date: t.date,
      categoryId: t.categoryId,
      categoryName: t.categoryId ? (names.get(t.categoryId) ?? null) : null,
      isTransfer: t.isTransfer ?? false,
    }));
  }
  async getTransferCandidates(txn: TxnInput, windowDays: number): Promise<TransferTxn[]> {
    const lo = addDays(txn.date, -windowDays);
    const hi = addDays(txn.date, windowDays);
    return [...this.pending, ...this.transactions]
      .filter((t) => t.id !== txn.id && !t.transferPaired && t.accountId !== txn.accountId && t.amountMilli === -txn.amountMilli && t.date >= lo && t.date <= hi)
      .map((t) => ({ id: t.id, accountId: t.accountId, date: t.date, amountMilli: t.amountMilli, rawDescription: t.rawDescription, payeeName: t.payeeName }));
  }
  async getRules() {
    return this.rules;
  }
  async countPriorReviewed(payeeKey: string, q: { incomeOverMilli: Milli; rtaCategoryId: string | null; before: ISODate }) {
    return this.transactions.filter(
      (t) => t.payeeKey === payeeKey && t.date < q.before && (t.approved ?? true) && (t.amountMilli > q.incomeOverMilli || (q.rtaCategoryId !== null && t.categoryId === q.rtaCategoryId)),
    ).length;
  }
  async saveEvent(e: CategorizationEventInput) {
    this.events.push({ ...e, id: newId() });
  }
  async recentEventsForPayee(payeeKey: string, limit: number) {
    return this.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.payeeKey === payeeKey)
      .sort((a, b) => (a.e.at < b.e.at ? 1 : a.e.at > b.e.at ? -1 : b.i - a.i))
      .slice(0, limit)
      .map(({ e }) => e);
  }
  async upsertMerchantProfile(payeeKey: string, payeeName: string, profile: MerchantProfile) {
    const p = this.payees.find((x) => x.normalizedKey === payeeKey);
    if (p) p.merchant = profile;
    else this.payees.push({ id: newId(), name: payeeName, normalizedKey: payeeKey, merchant: profile });
  }
  async recordRuleHit(ruleId: string, at: string) {
    this.ruleHits.push({ ruleId, at });
    const r = this.rules.find((x) => x.id === ruleId);
    if (r) {
      r.hitCount = (r.hitCount ?? 0) + 1;
      r.lastHitAt = at;
    }
  }
  async createRule(rule: Omit<Rule, "id">) {
    const r: Rule = { ...rule, id: newId() };
    this.rules.push(r);
    return r;
  }
  async setRuleEnabled(ruleId: string, enabled: boolean) {
    const r = this.rules.find((x) => x.id === ruleId);
    if (r) r.enabled = enabled;
  }
  async unapprovedTransactionIdsForPayee(payeeKey: string) {
    return this.transactions.filter((t) => t.payeeKey === payeeKey && t.approved === false).map((t) => t.id);
  }
}
