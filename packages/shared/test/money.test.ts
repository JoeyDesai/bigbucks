import { describe, expect, it } from "vitest";
import { evalAmountExpr, formatMilli, parseMilli, divRound } from "../src/money";
import { addMonths, monthsBetween, toLocalDate, weekdayCount } from "../src/dates";

describe("money", () => {
  it("parses", () => {
    expect(parseMilli("12.34")).toBe(12340n);
    expect(parseMilli("-1,234.5")).toBe(-1234500n);
    expect(parseMilli("$0.0005")).toBe(1n);
    expect(() => parseMilli("abc")).toThrow();
  });
  it("formats", () => {
    expect(formatMilli(-1234560n)).toBe("-$1,234.56");
    expect(formatMilli(5n)).toBe("$0.01");
    expect(formatMilli(100000n, { sign: "always" })).toBe("+$100.00");
  });
  it("evaluates expressions", () => {
    expect(evalAmountExpr("+50", 100000n)).toBe(150000n);
    expect(evalAmountExpr("-25", 100000n)).toBe(75000n);
    expect(evalAmountExpr("=200", 100000n)).toBe(200000n);
    expect(evalAmountExpr("300", 100000n)).toBe(300000n);
    expect(evalAmountExpr("50*2", 0n)).toBe(100000n);
    expect(evalAmountExpr("100/3", 0n)).toBe(33333n);
  });
  it("divRound", () => {
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(5n, 2n)).toBe(3n);
  });
});

describe("dates", () => {
  it("months", () => {
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(addMonths("2026-11-01", 14)).toBe("2028-01-01");
    expect(monthsBetween("2026-10-01", "2027-03-01")).toBe(6);
  });
  it("local date conversion", () => {
    expect(toLocalDate(Date.parse("2026-10-22T03:00:00Z") / 1000)).toBe("2026-10-21");
  });
  it("weekday count", () => {
    expect(weekdayCount("2026-10-01", 4)).toBe(5); // Thursdays in Oct 2026
  });
});
