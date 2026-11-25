import { describe, expect, it } from "vitest";
import { ageOfMoneyOutflows, computeAgeOfMoney, computeAgeOfMoneyByMonth } from "../src/ageOfMoney";
import { buildLedger } from "../src/ledger";
import { $, m, snap, RTA_ID } from "./helpers";

describe("§6.7 Age of Money", () => {
  it("is null until 10 qualifying outflows exist", () => {
    const b = snap().account("chk").cat("a").income("chk", "2026-01-01", 1000);
    for (let i = 0; i < 9; i++) b.spend("chk", `2026-01-${String(11 + i).padStart(2, "0")}`, "a", 10);
    expect(computeAgeOfMoney(b.build())).toBeNull();
    b.spend("chk", "2026-01-31", "a", 10);
    // ages 10..18 and 30 → mean 15.6 → 16 (rounded half up)
    expect(computeAgeOfMoney(b.build())).toBe(16);
  });

  it("FIFO: outflows consume the oldest buckets first; weighted by amount", () => {
    const s = snap().account("chk").cat("a").income("chk", "2026-01-01", 100).income("chk", "2026-01-21", 100).spend("chk", "2026-01-31", "a", 150).build();
    const out = ageOfMoneyOutflows(buildLedger(s, { cardStartingDebt: "no_budget_effect" }));
    // 100 × 30 days + 50 × 10 days = 3500 / 150 = 23.333 days
    expect(out).toHaveLength(1);
    expect(out[0]!.ageMilliDays).toBe(23333n);
  });

  it("overdraft money (no bucket) counts as 0 days", () => {
    const s = snap().account("chk").cat("a").income("chk", "2026-01-01", 50).spend("chk", "2026-01-11", "a", 100).build();
    expect(ageOfMoneyOutflows(buildLedger(s, { cardStartingDebt: "no_budget_effect" }))[0]!.ageMilliDays).toBe(5000n);
  });

  it("card payments are outflows; card spending is not; cash↔cash transfers are excluded", () => {
    const s = snap()
      .account("chk")
      .account("sav", "savings")
      .card("visa")
      .cat("a")
      .income("chk", "2026-01-01", 1000)
      .spend("visa", "2026-01-05", "a", 100)
      .transfer("chk", "sav", "2026-01-06", 200)
      .transfer("chk", "visa", "2026-01-21", 100)
      .build();
    const out = ageOfMoneyOutflows(buildLedger(s, { cardStartingDebt: "no_budget_effect" }));
    expect(out.map((o) => [o.date, o.amount])).toEqual([["2026-01-21", $(100)]]);
    expect(out[0]!.ageMilliDays).toBe(20000n);
  });

  it("starting balances are buckets (option) but never outflows", () => {
    const b = snap().account("chk").cat("a").tx({ acct: "chk", date: "2026-01-01", amt: 1000, cat: RTA_ID, sb: true }).tx({ acct: "chk", date: "2026-01-01", amt: -5, cat: RTA_ID, sb: true }).income("chk", "2026-01-11", 1000).spend("chk", "2026-01-21", "a", 10);
    const l = buildLedger(b.build(), { cardStartingDebt: "no_budget_effect" });
    expect(ageOfMoneyOutflows(l)).toHaveLength(1);
    expect(ageOfMoneyOutflows(l)[0]!.ageMilliDays).toBe(20000n);
    expect(ageOfMoneyOutflows(l, { includeStartingBalances: false })[0]!.ageMilliDays).toBe(10000n);
  });

  it("per-month series in the budget result, honoring asOf", () => {
    const b = snap().account("chk").cat("a").income("chk", "2026-01-01", 5000);
    for (let i = 0; i < 10; i++) b.spend("chk", `2026-02-${String(1 + i).padStart(2, "0")}`, "a", 10);
    b.spend("chk", "2026-03-31", "a", 10);
    const r = b.run("2026-03");
    expect(m(r, "2026-01").ageOfMoney).toBeNull();
    expect(m(r, "2026-02").ageOfMoney).toBe(36); // ages 31..40 → 35.5, rounded
    expect(m(r, "2026-03").ageOfMoney).toBe(41); // ages 32..40 and 89 → 41.3
    const l = buildLedger(b.build(), { cardStartingDebt: "no_budget_effect" });
    const series = computeAgeOfMoneyByMonth(l, ["2026-02-01", "2026-03-01", "2026-04-01"], { asOf: "2026-03-15" });
    expect(series.get("2026-03-01")).toBe(36);
    expect(series.get("2026-04-01")).toBeNull();
    expect(computeAgeOfMoney(b.build(), { asOf: "2026-02-28" })).toBe(36);
  });
});
