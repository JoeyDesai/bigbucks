import { describe, expect, it } from "vitest";
import { parseMilli } from "@homebase/shared";
import type { BucketRow, BucketSavings } from "@homebase/core";
import { incomeLine, overReadyWarning, readyLine, QUICK_AMOUNTS, savingsChange, savingsDisplay, wholeDollars, withSavingsDelta } from "./savings-display";

const $ = parseMilli;

describe("savingsDisplay", () => {
  it("with a target: balance of target and percent", () => {
    const d = savingsDisplay("Emergency Fund", { balance: $("2400"), target: $("15000"), progress: 0.16 });
    expect(d).toMatchObject({ balance: $("2400"), detail: "$2,400 of $15,000 · 16%", percent: 16, reached: false, negative: false });
    expect(d.bar).toEqual({ state: "under", fill: 0.16, over: 0 });
  });
  it("percent rounds down until the target is reached", () => {
    expect(savingsDisplay("X", { balance: $("14999"), target: $("15000"), progress: 0.9999 }).detail).toBe("$14,999 of $15,000 · 99%");
    expect(savingsDisplay("X", { balance: $("16000"), target: $("15000"), progress: 1 })).toMatchObject({ detail: "$16,000 of $15,000 · 100%", reached: true, percent: 100 });
  });
  it("without a target: just the balance", () => {
    expect(savingsDisplay("Taxes", { balance: $("3250.40"), target: null, progress: null })).toMatchObject({ detail: "Saved", bar: null, percent: null, label: "Taxes: $3,250.40 saved" });
  });
  it("overspent and not started yet", () => {
    expect(savingsDisplay("Taxes", { balance: $("-80"), target: null, progress: null })).toMatchObject({ negative: true, detail: "Spent more than it had" });
    expect(savingsDisplay("Taxes", { balance: 0n, target: null, progress: null, started: false, from: "2026-11-01" }, { monthLabel: () => "November 2026" })).toMatchObject({ detail: "Starts in November 2026", bar: null });
  });
});

describe("income line and amounts", () => {
  it("income and what went to savings", () => {
    expect(incomeLine($("8240.12"), $("1250"))).toBe("Income this month $8,240 · $1,250 added to savings");
    expect(incomeLine($("8240"), 0n)).toBe("Income this month $8,240 · nothing added to savings yet");
    expect(incomeLine($("8240"), $("-300"), false)).toBe("Income that month $8,240 · $300 taken out of savings");
    expect(incomeLine($("-20"), $("10"))).toBe("Income this month $0 · $10 added to savings");
  });
  it("whole dollars and quick amounts", () => {
    expect(wholeDollars($("79.99"))).toBe("$80");
    expect(wholeDollars($("-12.40"))).toBe("−$12");
    expect(QUICK_AMOUNTS.map(wholeDollars)).toEqual(["$100", "$250", "$500", "$1,000"]);
  });
  it("add or take out, never more than the balance", () => {
    expect(savingsChange($("250"), false, 0n)).toEqual({ amount: $("250") });
    expect(savingsChange($("250"), true, $("300"))).toEqual({ amount: $("-250") });
    expect(savingsChange($("300.01"), true, $("300"))).toEqual({ error: "Only $300.00 to take out" });
    expect(savingsChange(null, false, 0n)).toEqual({ error: "Enter an amount" });
    expect(savingsChange(0n, false, 0n)).toEqual({ error: "Enter an amount" });
  });
});

describe("withSavingsDelta (optimistic add)", () => {
  const row = (id: string, balance: bigint, target: bigint | null): BucketRow =>
    ({
      id,
      bucketKind: "savings",
      remaining: balance,
      bar: { state: target ? "under" : "none", fill: 0, over: 0, spentRatio: 0, remaining: balance },
      savings: { balance, contributed: 0n, spent: 0n, carryIn: balance, target, progress: target ? Number(balance) / Number(target) : null, from: "2026-10-01", opening: 0n, started: true },
    }) as unknown as BucketRow;
  const s: BucketSavings = { rows: [row("a", $("2400"), $("15000")), row("b", $("100"), null)], totalSaved: $("2500"), addedToSavings: 0n, ready: { cash: $("9000"), inBuckets: $("2500"), inSavings: $("2500"), amount: $("4000") } };

  it("adds to one bucket, its progress, and the totals", () => {
    const n = withSavingsDelta(s, "a", $("600"));
    expect(n.rows[0]!.savings).toMatchObject({ balance: $("3000"), contributed: $("600"), progress: 0.2 });
    expect(n.rows[0]!.bar.fill).toBe(0.2);
    expect(n.rows[1]).toBe(s.rows[1]);
    expect(n).toMatchObject({ totalSaved: $("3100"), addedToSavings: $("600"), ready: { cash: $("9000"), inBuckets: $("2500"), inSavings: $("3100"), amount: $("3400") } });
  });
  it("take-outs subtract; unknown ids and zero change nothing", () => {
    expect(withSavingsDelta(s, "b", $("-40")).rows[1]!.savings!.balance).toBe($("60"));
    expect(withSavingsDelta(s, "zzz", $("10"))).toBe(s);
    expect(withSavingsDelta(s, "a", 0n)).toBe(s);
  });
});

describe("ready to save", () => {
  it("shows what's in no bucket, or how far the buckets are over", () => {
    expect(readyLine($("8947.40"))).toEqual({ label: "Ready to save", amount: "$8,947", over: false });
    expect(readyLine($("-300"))).toEqual({ label: "Buckets hold more than you have by", amount: "$300", over: true });
  });
  it("warns only when the add is more than what's ready", () => {
    expect(overReadyWarning($("500"), $("4000"))).toBeNull();
    expect(overReadyWarning($("4000"), $("4000"))).toBeNull();
    expect(overReadyWarning($("4500"), $("4000"))).toBe("That's $500.00 more than you have ready to save ($4,000.00 isn't in a bucket yet).");
    expect(overReadyWarning($("100"), $("-50"))).toBe("That's $100.00 more than you have ready to save ($0.00 isn't in a bucket yet).");
  });
});
