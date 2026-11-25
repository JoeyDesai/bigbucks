import { describe, expect, it } from "vitest";
import { addDays, addMonths } from "@homebase/shared";
import { detectAnomalies, detectRecurring, newSubscriptionsSince, priceIncreasesSince, type AnomalyTxn, type RecurringTxn } from "../src";

let n = 0;
const r = (payee: string, date: string, amountMilli: bigint, categoryId = "c-subs"): RecurringTxn => ({ id: `r${++n}`, date, amountMilli, payeeKey: payee.toLowerCase(), payeeName: payee, categoryId });
const monthly = (payee: string, start: string, amounts: bigint[], jitter: number[] = []) =>
  amounts.map((a, i) => r(payee, addDays(`${addMonths(`${start.slice(0, 7)}-01`, i).slice(0, 8)}${start.slice(8)}`, jitter[i] ?? 0), a));

describe("recurring detection (§11.6)", () => {
  it("finds a monthly subscription with a price increase", () => {
    const netflix = monthly("Netflix", "2026-01-15", [-15_490n, -15_490n, -15_490n, -15_490n, -17_990n, -17_990n], [0, 2, -1, 3, 0, -2]);
    const [s] = detectRecurring(netflix);
    expect(s).toMatchObject({ cadence: "monthly", direction: "outflow", occurrences: 6, isSubscription: true, stableAmount: true, latestAmountMilli: -17_990n, categoryId: "c-subs" });
    expect(s!.priceChange).toEqual({ fromMilli: -15_490n, toMilli: -17_990n, changedOn: "2026-05-15", changeMilli: 2_500n, changeBps: 1613 });
    expect(s!.nextExpectedDate).toBe("2026-07-13");
    expect(priceIncreasesSince([s!], "2026-05-01")).toHaveLength(1);
    expect(priceIncreasesSince([s!], "2026-06-01")).toHaveLength(0);
  });

  it("finds weekly and yearly series", () => {
    const weekly = [0, 7, 14, 22, 28].map((d) => r("Lawn Guy", addDays("2026-06-01", d), -40_000n));
    const yearly = [r("Costco Membership", "2024-03-02", -65_000n), r("Costco Membership", "2025-03-04", -65_000n), r("Costco Membership", "2026-03-03", -65_000n)];
    const out = detectRecurring([...weekly, ...yearly]);
    expect(out.map((s) => [s.payeeName, s.cadence])).toEqual([
      ["Costco Membership", "yearly"],
      ["Lawn Guy", "weekly"],
    ]);
  });

  it("separates two subscriptions from the same payee by amount", () => {
    const apple = [...monthly("Apple", "2026-01-03", [-2_990n, -2_990n, -2_990n, -2_990n]), ...monthly("Apple", "2026-01-19", [-10_990n, -10_990n, -10_990n])];
    const out = detectRecurring(apple);
    expect(out.map((s) => s.latestAmountMilli).sort()).toEqual([-10_990n, -2_990n]);
  });

  it("ignores irregular spending and marks variable bills as non-subscriptions", () => {
    const irregular = ["2026-01-02", "2026-01-09", "2026-02-20", "2026-04-01"].map((d) => r("Lowe's", d, -50_000n));
    expect(detectRecurring(irregular)).toHaveLength(0);
    const power = monthly("Fairview Power", "2026-01-10", [-142_000n, -131_220n, -118_400n, -97_310n, -150_020n]);
    const [s] = detectRecurring(power);
    expect(s).toMatchObject({ cadence: "monthly", stableAmount: false, isSubscription: false, priceChange: null });
  });

  it("reports new subscriptions by detection date", () => {
    const max = monthly("Max", "2026-07-05", [-16_990n, -16_990n, -16_990n]);
    const [s] = detectRecurring(max);
    expect(s!.detectedOn).toBe("2026-09-05");
    expect(newSubscriptionsSince([s!], "2026-09-01")).toHaveLength(1);
    expect(newSubscriptionsSince([s!], "2026-09-06")).toHaveLength(0);
  });
});

describe("anomalies (>3σ)", () => {
  const a = (id: string, amountMilli: bigint, payeeKey: string | null = "kroger", categoryId: string | null = "c-groc"): AnomalyTxn => ({ id, date: "2026-10-01", amountMilli, payeeKey, categoryId });
  const history = [80, 95, 102, 88, 91, 110, 97, 85].map((d, i) => a(`h${i}`, -BigInt(d) * 1000n));

  it("flags a transaction more than 3σ above the payee norm", () => {
    const out = detectAnomalies([a("w1", -420_000n), a("w2", -105_000n)], history);
    expect(out.map((x) => x.transactionId)).toEqual(["w1"]);
    expect(out[0]).toMatchObject({ basis: "payee", meanMilli: -93_500n });
    expect(out[0]!.zScore).toBeGreaterThan(3);
  });

  it("falls back to the category norm when the payee has too little history", () => {
    const out = detectAnomalies([a("w", -400_000n, "new-store", "c-groc")], history);
    expect(out[0]).toMatchObject({ transactionId: "w", basis: "category" });
  });

  it("ignores small amounts, inflows vs outflows, and thin history", () => {
    expect(detectAnomalies([a("w", -20_000n)], history.map((h) => ({ ...h, amountMilli: h.amountMilli / 10n })))).toHaveLength(0);
    expect(detectAnomalies([a("w", 400_000n)], history)).toHaveLength(0);
    expect(detectAnomalies([a("w", -400_000n)], history.slice(0, 3))).toHaveLength(0);
  });

  it("handles identical history (σ = 0)", () => {
    const flat = Array.from({ length: 6 }, (_, i) => a(`f${i}`, -15_490n, "netflix", "c-subs"));
    expect(detectAnomalies([a("w", -45_000n, "netflix", "c-subs")], flat, { minAbsMilli: 0n })).toHaveLength(1);
    expect(detectAnomalies([a("w", -17_990n, "netflix", "c-subs")], flat, { minAbsMilli: 0n })).toHaveLength(0);
  });
});
