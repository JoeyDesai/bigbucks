import { describe, expect, it } from "vitest";
import { monotonePath, thin } from "./path";
import { sliceRange } from "./BalanceChart";

describe("chart helpers", () => {
  it("thin keeps the ends and caps the count", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const t = thin(xs, 100);
    expect(t).toHaveLength(100);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBe(999);
    expect(thin([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
  it("monotone path starts at the first point and ends at the last", () => {
    const d = monotonePath([
      { x: 0, y: 10 },
      { x: 50, y: 5 },
      { x: 100, y: 5 },
    ]);
    expect(d.startsWith("M0.00,10.00")).toBe(true);
    expect(d.endsWith("100.00,5.00")).toBe(true);
    // flat segment stays flat (no overshoot): both control points at y = 5
    expect(d.split("C")[2]).toBe("66.67,5.00 83.33,5.00 100.00,5.00");
  });
  it("range slices end at the last day", () => {
    const pts = Array.from({ length: 400 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), balance: BigInt(i) }));
    expect(sliceRange(pts, "1M")).toHaveLength(30);
    expect(sliceRange(pts, "1Y")).toHaveLength(365);
    expect(sliceRange(pts, "All")).toHaveLength(400);
    expect(sliceRange(pts, "1M")[29]!.date).toBe(pts[399]!.date);
  });
});
