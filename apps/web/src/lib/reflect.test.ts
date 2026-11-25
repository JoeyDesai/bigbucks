import { describe, expect, it } from "vitest";
import { parseMilli } from "@homebase/shared";
import type { ReflectBucket } from "@homebase/core";
import { average, barAxis, bucketStats, colorSlots, donutSlices, monthBuckets, monthSummary, niceMax } from "./reflect";

const $ = parseMilli;
const b = (id: string, spent: string[]): ReflectBucket => {
  const s = spent.map((v) => $(v));
  return { id, name: id, icon: null, groupId: "g", groupName: "G", bucketKind: "spending", spent: s, total: s.reduce((a, v) => a + v, 0n) };
};

describe("reflect math", () => {
  const buckets = [b("rent", ["1000", "1000", "1000"]), b("food", ["300", "500", "400"]), b("gas", ["50", "0", "80"]), b("fun", ["0", "0", "-20"])];

  it("colors follow the bucket's window total, capped at the slot count", () => {
    const slots = colorSlots(buckets, 2);
    expect([...slots]).toEqual([["rent", 1], ["food", 2]]);
    expect(colorSlots(buckets).has("fun")).toBe(false);
  });

  it("month rows skip refunds-only buckets; the donut folds unslotted ones into Other", () => {
    const rows = monthBuckets({ buckets }, 2, colorSlots(buckets, 2));
    expect(rows.map((r) => r.id)).toEqual(["rent", "food", "gas"]);
    expect(rows[0]!.share).toBeCloseTo(1000 / 1480, 3);
    const d = donutSlices(rows);
    expect(d.total).toBe($("1480"));
    expect(d.slices.map((s) => [s.id, s.value])).toEqual([["rent", $("1000")], ["food", $("400")], ["other", $("80")]]);
  });

  it("month summary compares with the earlier months' average", () => {
    const data = { spent: [0n, $("1000"), $("1200"), $("800")], income: [0n, $("2000"), $("2000"), $("500")] };
    expect(monthSummary(data, 3)).toEqual({ spent: $("800"), income: $("500"), kept: $("-300"), usual: $("1100") });
    expect(monthSummary(data, 1).usual).toBeNull();
    expect(average([1n, 2n], 0, 0)).toBeNull();
  });

  it("bucket stats start at the bucket's first month", () => {
    const s = bucketStats(b("gas", ["0", "60", "0", "90"]), ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"], 3);
    expect(s).toEqual({ average: $("50"), highest: { month: "2026-10-01", spent: $("90") }, total: $("150") });
  });

  it("nice axis maximums", () => {
    expect(niceMax($("840"))).toBe($("1000"));
    expect(niceMax($("1900"))).toBe($("2000"));
    expect(niceMax($("2100"))).toBe($("2500"));
    expect(niceMax($("7400"))).toBe($("10000"));
    expect(niceMax(0n)).toBe($("100"));
  });
});

describe("bar axis", () => {
  it("fits everything normally", () => {
    expect(barAxis([$("900"), $("1200"), $("800")], [$("1500")])).toEqual({ max: $("2000"), clipped: [] });
  });
  it("clips one towering month so the rest stay readable", () => {
    const v = [$("6000"), $("7000"), $("69000"), $("6500")];
    expect(barAxis(v)).toEqual({ max: $("10000"), clipped: [2] });
    // a marker line above the rest still fits
    expect(barAxis(v, [$("18000")])).toEqual({ max: $("20000"), clipped: [2] });
  });
});
