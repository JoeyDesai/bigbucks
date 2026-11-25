import { describe, expect, it } from "vitest";
import {
  addMonthsToDate,
  balanceAfterPayments,
  balanceDrift,
  buildSchedule,
  fractionToPercent,
  interestPaidToDate,
  monthlyPayment,
  parseAnnualRate,
  payoffDate,
  periodInterest,
  scheduledBalanceAsOf,
  whatIf,
  whatIfExtraMonthly,
  type LoanTerms,
} from "../src/amortization";

const loan: LoanTerms = { principal: 300_000_000n, annualRate: "6.5", termMonths: 360, firstPaymentDate: "2024-02-01" };

describe("payment formula (known values)", () => {
  it.each([
    [300_000_000n, "6.5", 360, 1_896_200n], // $300,000 @ 6.5% 30yr → $1,896.20
    [200_000_000n, "5", 360, 1_073_640n], // $200,000 @ 5% 30yr → $1,073.64
    [100_000_000n, "4", 180, 739_690n], // $100,000 @ 4% 15yr → $739.69
    [400_000_000n, "7", 360, 2_661_210n], // $400,000 @ 7% 30yr → $2,661.21
    [250_000_000n, "6.125%", 360, 1_519_030n], // fractional rate
    [12_000_000n, "0", 12, 1_000_000n], // zero rate
  ])("P=%s r=%s n=%s → %s", (p, r, n, pmt) => {
    expect(monthlyPayment(p, r, n)).toBe(pmt);
  });

  it("parses rates exactly (no floats)", () => {
    expect(parseAnnualRate("6.5")).toEqual({ annualPct: "6.5", num: 65n, den: 12_000n });
    expect(parseAnnualRate("6.125%")).toEqual({ annualPct: "6.125", num: 6125n, den: 1_200_000n });
    expect(() => parseAnnualRate("abc")).toThrow();
    expect(periodInterest(300_000_000n, parseAnnualRate("6.5"))).toBe(1_625_000n);
    expect(fractionToPercent("0.065")).toBe("6.5");
    expect(fractionToPercent("0.06125")).toBe("6.125");
    expect(fractionToPercent("0.07")).toBe("7");
    expect(fractionToPercent("0")).toBe("0");
  });
});

describe("schedule", () => {
  const s = buildSchedule(loan);

  it("amortizes to zero in exactly 360 payments; final payment absorbs rounding", () => {
    expect(s.rows).toHaveLength(360);
    expect(s.rows[0]).toMatchObject({ period: 1, date: "2024-02-01", payment: 1_896_200n, interest: 1_625_000n, principal: 271_200n, balance: 299_728_800n });
    expect(s.rows.at(-1)).toMatchObject({ period: 360, date: "2054-01-01", balance: 0n, payment: 1_900_910n });
    expect(payoffDate(s)).toBe("2054-01-01");
    const principalPaid = s.rows.reduce((t, r) => t + r.principal + r.extraPrincipal, 0n);
    expect(principalPaid).toBe(loan.principal);
    expect(s.totalPaid).toBe(loan.principal + s.totalInterest);
    // Within $5 of the textbook total interest ($382,633.47 with an unrounded payment)
    expect(s.totalInterest - 382_633_470n).toBeLessThan(5_000n);
    expect(s.rows.every((r) => r.interest % 10n === 0n && r.principal % 10n === 0n)).toBe(true); // whole cents
  });

  it("closed-form balance matches the cent-rounded iterative schedule to within 50¢", () => {
    // Per-period cent rounding of interest accumulates a few cents vs. the exact closed form.
    for (const k of [1, 12, 60, 180, 359]) {
      const closed = balanceAfterPayments(loan.principal, loan.annualRate, loan.termMonths, k);
      const iter = s.rows[k - 1]!.balance;
      expect(closed - iter < 0n ? iter - closed : closed - iter).toBeLessThanOrEqual(500n);
    }
    expect(balanceAfterPayments(loan.principal, "6.5", 360, 12)).toBe(296_646_870n);
    expect(balanceAfterPayments(loan.principal, "6.5", 360, 0)).toBe(loan.principal);
    expect(balanceAfterPayments(12_000_000n, "0", 12, 5)).toBe(7_000_000n);
  });

  it("interest paid to date and balance as of a date", () => {
    expect(interestPaidToDate(s, "2024-01-31")).toBe(0n);
    expect(interestPaidToDate(s, "2024-02-01")).toBe(1_625_000n);
    expect(interestPaidToDate(s, "2026-10-22")).toBe(s.rows.slice(0, 33).reduce((t, r) => t + r.interest, 0n));
    expect(scheduledBalanceAsOf(loan, s, "2024-01-15")).toBe(loan.principal);
    expect(scheduledBalanceAsOf(loan, s, "2024-02-15")).toBe(299_728_800n);
  });

  it("payment dates keep the day of month, clamped", () => {
    expect(addMonthsToDate("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonthsToDate("2024-01-31", 2)).toBe("2024-03-31");
    expect(addMonthsToDate("2024-11-15", 3)).toBe("2025-02-15");
  });
});

describe("loan_events", () => {
  it("extra principal lowers the next period's interest and shortens the loan", () => {
    const s = buildSchedule(loan, [{ type: "extra_principal", date: "2026-10-05", amount: 10_000_000n }]);
    const base = buildSchedule(loan);
    const i = s.rows.findIndex((r) => r.date === "2026-11-01");
    expect(s.rows[i]!.extraPrincipal).toBe(10_000_000n);
    expect(s.rows[i]!.interest).toBe(periodInterest(base.rows[i - 1]!.balance - 10_000_000n, parseAnnualRate("6.5")));
    expect(s.rows.length).toBeLessThan(360);
    expect(s.totalInterest).toBeLessThan(base.totalInterest);
  });

  it("recast after a lump sum keeps maturity and lowers the payment", () => {
    const s = buildSchedule(loan, [
      { type: "extra_principal", date: "2026-10-05", amount: 50_000_000n },
      { type: "recast", date: "2026-10-20" },
    ]);
    const i = s.rows.findIndex((r) => r.date === "2026-11-01");
    const balBefore = s.rows[i - 1]!.balance - 50_000_000n;
    expect(s.rows[i]!.payment).toBe(monthlyPayment(balBefore, "6.5", 360 - i));
    expect(s.rows[i]!.payment).toBe(1_569_530n);
    expect(s.rows).toHaveLength(360);
    expect(s.payoffDate).toBe("2054-01-01");
  });

  it("servicer-specified recast payment wins", () => {
    const s = buildSchedule(loan, [{ type: "recast", date: "2025-01-10", newPayment: 1_800_000n }]);
    expect(s.rows.find((r) => r.date === "2025-02-01")!.payment).toBe(1_800_000n);
  });

  it("rate change re-amortizes over the remaining term", () => {
    const s = buildSchedule(loan, [{ type: "rate_change", date: "2029-01-15", annualRate: "7.25" }]);
    const i = s.rows.findIndex((r) => r.date === "2029-02-01");
    expect(s.rows[i]!.annualRate).toBe("7.25");
    expect(s.rows[i]!.payment).toBe(monthlyPayment(s.rows[i - 1]!.balance, "7.25", 360 - i));
    expect(s.rows.at(-1)!.balance).toBe(0n);
    expect(s.rows).toHaveLength(360);
  });

  it("statement balance correction snaps the balance", () => {
    const s = buildSchedule(loan, [{ type: "balance_correction", date: "2025-06-02", balance: 290_000_000n }]);
    const i = s.rows.findIndex((r) => r.date === "2025-07-01");
    expect(s.rows[i]!.interest).toBe(periodInterest(290_000_000n, parseAnnualRate("6.5")));
  });

  it("a lump sum that pays off the loan ends the schedule", () => {
    const s = buildSchedule({ ...loan, principal: 10_000_000n, termMonths: 12 }, [{ type: "extra_principal", date: "2024-03-15", amount: 999_000_000n }]);
    expect(s.rows).toHaveLength(2);
    expect(s.rows.at(-1)!.balance).toBe(0n);
    expect(s.totalPaid).toBe(10_000_000n + s.totalInterest);
  });
});

describe("what-if + drift", () => {
  it("extra $200/mo saves interest and months", () => {
    const w = whatIfExtraMonthly(loan, 200_000n);
    expect(w.baseline).toMatchObject({ months: 360, payoffDate: "2054-01-01" });
    expect(w.scenario.months).toBeLessThan(300);
    expect(w.monthsSaved).toBe(360 - w.scenario.months);
    expect(w.interestSaved).toBe(w.baseline.totalInterest - w.scenario.totalInterest);
    expect(w.interestSaved).toBeGreaterThan(100_000_000n);
  });

  it("generic what-if: lump sum + recast", () => {
    const w = whatIf(loan, [], { extraEvents: [{ type: "extra_principal", date: "2026-10-05", amount: 50_000_000n }, { type: "recast", date: "2026-10-06" }] });
    expect(w.scenario.months).toBe(360);
    expect(w.scenario.payment).toBeLessThan(w.baseline.payment);
  });

  it("flags drift > $50 between synced and scheduled balances", () => {
    expect(balanceDrift(-290_229_550n, 290_229_550n)).toEqual({ drift: 0n, flagged: false });
    expect(balanceDrift(-290_279_560n, 290_229_550n)).toEqual({ drift: 50_010n, flagged: true });
    expect(balanceDrift(-290_179_550n, 290_229_550n).flagged).toBe(false);
  });
});
