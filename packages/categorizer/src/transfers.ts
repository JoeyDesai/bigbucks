/**
 * §8.3 transfer detection. A pair needs: opposite equal amounts, dates within 5 days, and at least
 * one transfer-looking description ("PAYMENT", "ONLINE TRANSFER", "MERCURY", "AUTOPAY", the
 * counterpart account's name, card payment patterns).
 *
 * Auto-applied: card payments (checking/savings → card), business (Mercury) → household on-budget
 * account (household side categorized to Ready to Assign), and unambiguous household on-budget
 * moves where both sides look like transfers. Everything else, or anything with more than one
 * candidate, is only suggested for the review queue.
 */
import { absMilli, daysBetween, type ISODate, type Milli } from "@homebase/shared";
import type { AccountInfo } from "./types";

export const TRANSFER_WINDOW_DAYS = 5;

export const TRANSFER_PATTERNS: RegExp[] = [
  /\bPAYMENT\b/i,
  /\bPMT\b/i,
  /\bONLINE TRANSFER\b/i,
  /\bTRANSFER\b/i,
  /\bXFER\b/i,
  /\bMERCURY\b/i,
  /\bAUTO ?PAY\b/i,
  /\bE-?PAYMENT\b/i,
  /\bEPAY\b/i,
  /\bCRCARDPMT\b/i,
  /\bCARD ?PMT\b/i,
  /\bTHANK YOU\b/i,
];

export interface TransferTxn {
  id: string;
  accountId: string;
  date: ISODate;
  amountMilli: Milli;
  rawDescription: string;
  payeeName?: string | null;
  /** Already part of a transfer pair. */
  paired?: boolean;
}

export type TransferKind = "card_payment" | "business_to_household" | "internal" | "other";

export interface TransferMatch {
  kind: TransferKind;
  /** Apply without review. */
  auto: boolean;
  outflowId: string;
  inflowId: string;
  outflowAccountId: string;
  inflowAccountId: string;
  amountMilli: Milli;
  daysApart: number;
  confidence: number;
  /** For business → household: the household side's category (Ready to Assign). */
  householdCategoryId: string | null;
  reason: string;
}

export interface TransferOptions {
  /** id of the internal_rta category. */
  rtaCategoryId: string | null;
  windowDays?: number;
}

const GENERIC_WORDS = new Set(["CHECKING", "SAVINGS", "CARD", "ACCOUNT", "CREDIT", "BANK", "JOINT", "PERSONAL", "BUSINESS", "MONEY", "MARKET"]);

/** Does the description mention the counterpart account (full name/nickname/institution, or all its distinctive words)? */
function mentionsAccount(description: string, a: AccountInfo): boolean {
  const d = ` ${description.toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `;
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  for (const phrase of [a.name, a.nickname ?? "", a.institution ?? ""].map(clean)) {
    if (phrase.length >= 4 && d.includes(` ${phrase} `)) return true;
  }
  for (const label of [a.name, a.nickname ?? ""]) {
    const words = clean(label)
      .split(" ")
      .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
    if (words.length > 0 && words.every((w) => d.includes(` ${w} `))) return true;
  }
  return false;
}

export function looksLikeTransfer(description: string, counterpart?: AccountInfo): boolean {
  if (TRANSFER_PATTERNS.some((re) => re.test(description))) return true;
  return counterpart ? mentionsAccount(description, counterpart) : false;
}

const isCash = (a: AccountInfo) => a.kind === "checking" || a.kind === "savings" || a.kind === "cash";
const isCard = (a: AccountInfo) => a.kind === "credit_card" || a.kind === "line_of_credit";

function classify(out: AccountInfo, inn: AccountInfo, bothLookLikeTransfer: boolean): { kind: TransferKind; autoEligible: boolean; reason: string } {
  if (!out.isBusiness && !inn.isBusiness && isCash(out) && isCard(inn)) {
    return { kind: "card_payment", autoEligible: true, reason: `card payment ${out.name} → ${inn.name}` };
  }
  if (out.isBusiness && !inn.isBusiness && inn.onBudget) {
    return { kind: "business_to_household", autoEligible: true, reason: `${out.name} → ${inn.name}: business draw to household (Ready to Assign)` };
  }
  if (!out.isBusiness && !inn.isBusiness && out.onBudget && inn.onBudget) {
    return { kind: "internal", autoEligible: bothLookLikeTransfer, reason: `transfer ${out.name} → ${inn.name}` };
  }
  return { kind: "other", autoEligible: false, reason: `possible transfer ${out.name} → ${inn.name}` };
}

/** Every valid pairing of `txn` with a candidate (no ambiguity resolution). */
export function transferMatchesFor(txn: TransferTxn, candidates: readonly TransferTxn[], accounts: ReadonlyMap<string, AccountInfo>, opts: TransferOptions): TransferMatch[] {
  const window = opts.windowDays ?? TRANSFER_WINDOW_DAYS;
  const me = accounts.get(txn.accountId);
  if (!me || txn.amountMilli === 0n || txn.paired) return [];
  const out: TransferMatch[] = [];
  for (const c of candidates) {
    if (c.id === txn.id || c.paired || c.accountId === txn.accountId) continue;
    if (c.amountMilli !== -txn.amountMilli) continue;
    const days = Math.abs(daysBetween(txn.date, c.date));
    if (days > window) continue;
    const other = accounts.get(c.accountId);
    if (!other) continue;
    const mineLooks = looksLikeTransfer(`${txn.rawDescription} ${txn.payeeName ?? ""}`, other);
    const theirsLooks = looksLikeTransfer(`${c.rawDescription} ${c.payeeName ?? ""}`, me);
    if (!mineLooks && !theirsLooks) continue;
    const [o, i, oa, ia] = txn.amountMilli < 0n ? [txn, c, me, other] : [c, txn, other, me];
    const cls = classify(oa, ia, mineLooks && theirsLooks);
    out.push({
      kind: cls.kind,
      auto: cls.autoEligible,
      outflowId: o.id,
      inflowId: i.id,
      outflowAccountId: o.accountId,
      inflowAccountId: i.accountId,
      amountMilli: absMilli(txn.amountMilli),
      daysApart: days,
      confidence: cls.autoEligible ? (cls.kind === "internal" ? 0.97 : 0.99) : 0.7,
      householdCategoryId: cls.kind === "business_to_household" ? opts.rtaCategoryId : null,
      reason: cls.reason,
    });
  }
  return out.sort((a, b) => a.daysApart - b.daysApart || Number(b.auto) - Number(a.auto));
}

export interface TransferDecision {
  /** Pair to apply automatically (unique and auto-eligible). */
  match: TransferMatch | null;
  /** Pairs to show in the review queue (ambiguous or not auto-eligible). */
  suggestions: TransferMatch[];
}

/** Decide for one incoming transaction (pipeline step 1). */
export function decideTransfer(txn: TransferTxn, candidates: readonly TransferTxn[], accounts: ReadonlyMap<string, AccountInfo>, opts: TransferOptions): TransferDecision {
  const ms = transferMatchesFor(txn, candidates, accounts, opts);
  if (ms.length === 1 && ms[0]!.auto) return { match: ms[0]!, suggestions: [] };
  return { match: null, suggestions: ms.map((m) => ({ ...m, auto: false })) };
}

/**
 * Batch detection over a set of unpaired transactions (sync step). A pair is auto only when
 * neither side has another valid candidate; otherwise all of its pairings become suggestions.
 */
export function detectTransferPairs(txns: readonly TransferTxn[], accounts: ReadonlyMap<string, AccountInfo>, opts: TransferOptions): { auto: TransferMatch[]; suggestions: TransferMatch[] } {
  const matchesById = new Map<string, TransferMatch[]>();
  for (const t of txns) if (t.amountMilli < 0n) matchesById.set(t.id, transferMatchesFor(t, txns, accounts, opts));
  const inflowCounts = new Map<string, number>();
  for (const ms of matchesById.values()) for (const m of ms) inflowCounts.set(m.inflowId, (inflowCounts.get(m.inflowId) ?? 0) + 1);
  const auto: TransferMatch[] = [];
  const suggestions: TransferMatch[] = [];
  for (const ms of matchesById.values()) {
    if (ms.length === 1 && ms[0]!.auto && inflowCounts.get(ms[0]!.inflowId) === 1) auto.push(ms[0]!);
    else suggestions.push(...ms.map((m) => ({ ...m, auto: false })));
  }
  return { auto, suggestions };
}

export function accountMap(accounts: readonly AccountInfo[]): Map<string, AccountInfo> {
  return new Map(accounts.map((a) => [a.id, a]));
}
