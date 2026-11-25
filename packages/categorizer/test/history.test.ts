import { describe, expect, it } from "vitest";
import { historyCategory, historyConfidence, historySuggestions, learnAmountBands, type HistoryTxn } from "../src";

let n = 0;
const h = (categoryId: string | null, dollars: number, extra: Partial<HistoryTxn> = {}): HistoryTxn => ({
  id: `h${++n}`,
  date: "2026-09-01",
  amountMilli: -BigInt(Math.round(dollars * 100)) * 10n,
  categoryId,
  ...extra,
});

describe("history (§9.1 step 3)", () => {
  it("needs at least 3 past transactions", () => {
    expect(historyCategory([h("c-house", 10), h("c-house", 20)], -5_000n)).toBeNull();
  });

  it("uses a category with ≥90% share; confidence 0.90–0.98 scaled by count", () => {
    const three = historyCategory([h("c-house", 10), h("c-house", 20), h("c-house", 30)], -5_000n);
    expect(three).toMatchObject({ categoryId: "c-house", confidence: 0.9, count: 3, share: 1, band: null });
    const many = Array.from({ length: 20 }, () => h("c-house", 25));
    expect(historyCategory(many, -5_000n)?.confidence).toBe(0.98);
    expect(historyConfidence(8, 1)).toBe(0.95);
    const mixed = [...Array.from({ length: 9 }, () => h("c-house", 25)), h("c-misc", 25)];
    expect(historyCategory(mixed, -5_000n)).toMatchObject({ categoryId: "c-house", share: 0.9 });
    expect(historyCategory(mixed, -5_000n)!.confidence).toBeLessThan(historyConfidence(10, 1));
    expect(historyCategory(mixed, -5_000n)!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("ignores splits, transfers and uncategorized history", () => {
    const hs = [h("c-house", 10), h("c-house", 10), h(null, 10), h("c-misc", 10, { isSplit: true }), h("c-misc", 10, { isTransfer: true })];
    expect(historyCategory(hs, -1n)).toBeNull();
  });

  it("returns null when no category dominates and no amount bands exist", () => {
    expect(historyCategory([h("a", 10), h("b", 10), h("a", 12), h("b", 12)], -10_000n)).toBeNull();
  });

  it("learns amount bands: Costco < $60 = Gas, ≥ $60 = Groceries", () => {
    const costco = [h("c-gas", 42.1), h("c-gas", 55.3), h("c-gas", 38), h("c-gas", 51.75), h("c-groc", 182.4), h("c-groc", 96.12), h("c-groc", 240), h("c-groc", 65.01), h("c-groc", 133)];
    const band = learnAmountBands(costco);
    expect(band?.thresholdMilli).toBe(60_000n);
    expect(band?.below.categoryId).toBe("c-gas");
    expect(band?.atOrAbove.categoryId).toBe("c-groc");
    expect(historyCategory(costco, -47_000n)).toMatchObject({ categoryId: "c-gas", band: { side: "below", thresholdMilli: 60_000n } });
    expect(historyCategory(costco, -60_000n)).toMatchObject({ categoryId: "c-groc", band: { side: "at_or_above" } });
    expect(historyCategory(costco, -47_000n)!.explanation).toContain("under $60");
  });

  it("does not band when one side is too small or impure", () => {
    expect(learnAmountBands([h("c-gas", 40), h("c-gas", 45), h("c-groc", 100), h("c-groc", 120), h("c-groc", 130), h("c-groc", 140)])).toBeNull();
  });

  it("suggests the most frequent categories", () => {
    const s = historySuggestions([h("a", 1), h("a", 1), h("b", 1), h("c", 1), h("d", 1)], 3);
    expect(s.map((x) => x.categoryId)).toEqual(["a", "b", "c"]);
    expect(s[0]!.confidence).toBeLessThan(0.75);
  });
});
