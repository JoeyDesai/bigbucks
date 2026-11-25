/**
 * The fast transaction list (Transactions tab, account pages): row shape, category choices and the
 * pure helpers behind the keyboard flow (fuzzy match, what Enter does, filtering "Needs review").
 * All money is bigint milliunits.
 */
import type { Cleared, CatzMethod } from "@homebase/shared";

export interface TxSuggestion {
  categoryId: string;
  /** 0..1 */
  confidence: number;
  /** Where it came from (rule, history, ai, payee default …). */
  source: CatzMethod | "payee";
}

export interface TxItem {
  id: string;
  date: string;
  /** Clean payee name (falls back to the bank description). */
  payee: string;
  /** The stored payee name (learned rules match on it). */
  payeeName: string | null;
  payeeId: string | null;
  rawDescription: string | null;
  memo: string | null;
  amount: bigint;
  accountId: string;
  accountName: string;
  accountOnBudget: boolean;
  categoryId: string | null;
  approved: boolean;
  cleared: Cleared;
  isSplit: boolean;
  splitCount: number;
  splits: { id: string; categoryId: string | null; amount: bigint; memo: string | null }[];
  transferAccountName: string | null;
  /** On budget, not a transfer or split, and no category: it needs one. */
  needsCategory: boolean;
  /** Best first, at most 3. */
  suggestions: TxSuggestion[];
  method: CatzMethod | null;
}

export interface CategoryChoice {
  id: string;
  name: string;
  groupName: string;
  icon: string | null;
  /** The internal Ready-to-Assign category, shown as "Income". */
  income?: boolean;
}

/** Uncategorized or unapproved. */
export function needsReview(t: Pick<TxItem, "approved" | "needsCategory">): boolean {
  return !t.approved || t.needsCategory;
}

export type EnterAction = { kind: "categorize"; categoryId: string } | { kind: "approve" } | { kind: "pick" };

/**
 * What Enter does on a row: accept the top suggestion (and approve) when it needs a category; approve a
 * row that already has one (auto-categorized, a transfer or a split); otherwise open the picker.
 */
export function enterAction(t: TxItem): EnterAction {
  if (t.needsCategory) return t.suggestions[0] ? { kind: "categorize", categoryId: t.suggestions[0].categoryId } : { kind: "pick" };
  if (!t.approved) return { kind: "approve" };
  return { kind: "pick" };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "")
    .trim();

/**
 * Fuzzy score of `query` against a category name (higher is better, null = no match). Prefix of the
 * name or of a word wins, then a contiguous substring, then an in-order subsequence (initials: "eo" →
 * Eating Out).
 */
export function fuzzyScore(query: string, name: string, group = ""): number | null {
  const q = norm(query);
  if (!q) return 0;
  const n = norm(name);
  if (n.startsWith(q)) return 1000 - n.length;
  const words = n.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 800 - n.length;
  const initials = words.map((w) => w[0]).join("");
  if (initials.startsWith(q)) return 700 - n.length;
  const at = n.indexOf(q);
  if (at >= 0) return 600 - at - n.length;
  let i = 0;
  let gaps = 0;
  for (const ch of n) {
    if (i < q.length && ch === q[i]) i++;
    else if (i > 0) gaps++;
  }
  if (i === q.length) return 300 - gaps - n.length;
  if (group && norm(group).startsWith(q)) return 100 - n.length;
  return null;
}

/** Categories ranked for the picker: matches by score; with no query, recent first then the plan order. */
export function rankChoices(choices: readonly CategoryChoice[], query: string, opts: { recentIds?: readonly string[]; suggestionIds?: readonly string[] } = {}): CategoryChoice[] {
  const q = query.trim();
  if (!q) {
    const head = [...(opts.suggestionIds ?? []), ...(opts.recentIds ?? [])];
    const seen = new Set<string>();
    const byId = new Map(choices.map((c) => [c.id, c]));
    const out: CategoryChoice[] = [];
    for (const id of head) {
      const c = byId.get(id);
      if (c && !seen.has(id)) {
        seen.add(id);
        out.push(c);
      }
    }
    for (const c of choices) if (!seen.has(c.id)) out.push(c);
    return out;
  }
  return choices
    .map((c, i) => ({ c, i, s: fuzzyScore(q, c.name, c.groupName) }))
    .filter((x): x is { c: CategoryChoice; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

/** Ids of other rows from the same payee that still need review (for "apply to all from this payee"). */
export function samePayeeIds(rows: readonly TxItem[], t: TxItem): string[] {
  const key = t.payeeId ?? t.payee.toLowerCase();
  return rows.filter((r) => r.id !== t.id && needsReview(r) && !r.isSplit && !r.transferAccountName && (r.payeeId ?? r.payee.toLowerCase()) === key).map((r) => r.id);
}
