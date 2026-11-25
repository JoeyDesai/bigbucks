import { describe, expect, it } from "vitest";
import { decimalToScaled, importHash, instantToLocalDate, localMidnightEpoch, mulMilliByDecimal, normalizeDecimal, normalizeDescription, scaledToDecimal, sha256Hex, toMilli, toMilliOpt } from "../src/normalize";

describe("normalize", () => {
  it("importHash = sha256(account|date|amount|normalized description)", () => {
    const h = importHash("acct-1", "2026-10-16", -142_670n, "  Costco  WHSE #0000, Fairview VA ");
    expect(h).toBe(sha256Hex("acct-1|2026-10-16|-142670|COSTCO WHSE 0000 FAIRVIEW VA"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(importHash("acct-1", "2026-10-16", -142_670n, "COSTCO WHSE #0000 FAIRVIEW VA")).toBe(h);
    expect(importHash("acct-2", "2026-10-16", -142_670n, "COSTCO WHSE #0000 FAIRVIEW VA")).not.toBe(h);
    expect(normalizeDescription("Café  “Ünïcode”—Ⅻ")).toBe("CAFÉ ÜNÏCODE XII");
  });

  it("money parsing never uses floats for strings", () => {
    expect(toMilli("-1,234.565")).toBe(-1_234_565n);
    expect(toMilli("(27.80)")).toBe(-27_800n);
    expect(toMilli("+$12.34")).toBe(12_340n);
    expect(toMilli("0.1")).toBe(100n);
    expect(toMilli(18310.75)).toBe(18_310_750n);
    expect(toMilli(0.1 + 0.2)).toBe(300n);
    expect(toMilli("1.5e3")).toBe(1_500_000n);
    expect(toMilliOpt("--")).toBeUndefined();
    expect(toMilliOpt("")).toBeUndefined();
    expect(() => toMilli("ten")).toThrow();
  });

  it("decimals", () => {
    expect(normalizeDecimal("0012.3400")).toBe("12.34");
    expect(normalizeDecimal("-0.000")).toBe("0");
    expect(normalizeDecimal(1e-7)).toBe("0.0000001");
    expect(normalizeDecimal("1,234.5")).toBe("1234.5");
    expect(decimalToScaled("0.12345678", 8)).toBe(12_345_678n);
    expect(decimalToScaled("-0.000000015", 8)).toBe(-2n);
    expect(scaledToDecimal(-12_345_678n, 8)).toBe("-0.12345678");
    expect(scaledToDecimal(100_000_000n, 8)).toBe("1");
    expect(mulMilliByDecimal(250_505n, "2")).toBe(501_010n);
    expect(mulMilliByDecimal(1_000n, "0.3333")).toBe(333n);
  });

  it("timezones", () => {
    expect(localMidnightEpoch("2026-01-15")).toBe(Date.parse("2026-01-15T05:00:00Z") / 1000);
    expect(localMidnightEpoch("2026-07-15")).toBe(Date.parse("2026-07-15T04:00:00Z") / 1000);
    expect(localMidnightEpoch("2026-03-08")).toBe(Date.parse("2026-03-08T05:00:00Z") / 1000); // DST starts at 02:00
    expect(instantToLocalDate("2026-10-15T03:30:00Z")).toBe("2026-10-14");
    expect(instantToLocalDate("2026-10-15")).toBe("2026-10-15");
    expect(instantToLocalDate(1792195200)).toBe("2026-10-16");
  });
});
