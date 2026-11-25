import { describe, expect, it } from "vitest";
import { enterAction, fuzzyScore, needsReview, rankChoices, samePayeeIds, type CategoryChoice, type TxItem } from "./tx";

const tx = (o: Partial<TxItem> = {}): TxItem => ({
  id: "t1",
  date: "2026-10-20",
  payee: "Kroger",
  payeeName: "Kroger",
  payeeId: "p1",
  rawDescription: null,
  memo: null,
  amount: -45_000n,
  accountId: "a",
  accountName: "Checking",
  accountOnBudget: true,
  categoryId: null,
  approved: false,
  cleared: "cleared",
  isSplit: false,
  splitCount: 0,
  splits: [],
  transferAccountName: null,
  needsCategory: true,
  suggestions: [{ categoryId: "groceries", confidence: 0.92, source: "ai" }],
  method: "ai",
  ...o,
});

const C: CategoryChoice[] = [
  { id: "groceries", name: "Groceries", groupName: "Needs", icon: null },
  { id: "gas", name: "Gas", groupName: "Needs", icon: null },
  { id: "gifts", name: "Gifts", groupName: "Wants", icon: null },
  { id: "eo", name: "Eating Out", groupName: "Wants", icon: null },
  { id: "hp", name: "House Projects", groupName: "Savings", icon: null },
  { id: "alex", name: "Alex's Spending Money", groupName: "Wants", icon: null },
];

describe("needs review", () => {
  it("is unapproved or uncategorized", () => {
    expect(needsReview(tx())).toBe(true);
    expect(needsReview(tx({ approved: true, needsCategory: false }))).toBe(false);
    expect(needsReview(tx({ approved: true, needsCategory: true }))).toBe(true);
    expect(needsReview(tx({ approved: false, needsCategory: false }))).toBe(true);
  });
});

describe("enterAction", () => {
  it("accepts the top suggestion when a category is needed", () => {
    expect(enterAction(tx())).toEqual({ kind: "categorize", categoryId: "groceries" });
  });
  it("opens the picker when there is nothing to accept", () => {
    expect(enterAction(tx({ suggestions: [] }))).toEqual({ kind: "pick" });
    expect(enterAction(tx({ approved: true, needsCategory: false, categoryId: "gas" }))).toEqual({ kind: "pick" });
  });
  it("approves rows that already have a category, a transfer or a split", () => {
    expect(enterAction(tx({ needsCategory: false, categoryId: "gas" }))).toEqual({ kind: "approve" });
    expect(enterAction(tx({ needsCategory: false, transferAccountName: "Savings" }))).toEqual({ kind: "approve" });
    expect(enterAction(tx({ needsCategory: false, isSplit: true }))).toEqual({ kind: "approve" });
  });
});

describe("fuzzy picker", () => {
  it("prefix beats word prefix beats initials beats substring beats subsequence", () => {
    const names = (q: string) => rankChoices(C, q).map((c) => c.name);
    expect(names("gro")[0]).toBe("Groceries");
    expect(names("g").slice(0, 3)).toEqual(["Gas", "Gifts", "Groceries"]);
    expect(names("out")[0]).toBe("Eating Out");
    expect(names("eo")[0]).toBe("Eating Out");
    expect(names("proj")[0]).toBe("House Projects");
    expect(names("alexs")[0]).toBe("Alex's Spending Money");
    expect(names("zzz")).toEqual([]);
    expect(fuzzyScore("", "Gas")).toBe(0);
    expect(fuzzyScore("grcr", "Groceries")).not.toBeNull();
  });
  it("with no query: suggestions, then recent, then plan order", () => {
    expect(rankChoices(C, "", { suggestionIds: ["hp"], recentIds: ["gas", "hp"] }).map((c) => c.id)).toEqual(["hp", "gas", "groceries", "gifts", "eo", "alex"]);
  });
});

describe("apply to all from this payee", () => {
  it("finds the other rows from the same payee that still need review", () => {
    const rows = [tx({ id: "a" }), tx({ id: "b" }), tx({ id: "c", approved: true, needsCategory: false }), tx({ id: "d", payeeId: "p2" }), tx({ id: "e", isSplit: true })];
    expect(samePayeeIds(rows, rows[0]!)).toEqual(["b"]);
  });
});
