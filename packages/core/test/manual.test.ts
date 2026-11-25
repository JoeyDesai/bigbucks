import { describe, expect, it } from "vitest";
import { addDays } from "@homebase/shared";
import { dailyPrices, parseQuoteExternalId, parseUnits, quoteExternalId, unitsForValue, unitsToDecimal, unitsValue, validateAsset } from "../src/wealth/manual";

describe("hand-entered investments", () => {
  it("parses amounts without floats", () => {
    expect(parseUnits("0.25")).toBe(25_000_000n);
    expect(parseUnits(" 1.5 BTC ")).toBe(150_000_000n);
    expect(parseUnits("12.5 shares")).toBe(1_250_000_000n);
    expect(parseUnits("25,000,000 sats")).toBe(25_000_000n);
    expect(parseUnits(".00000001")).toBe(1n);
    expect(parseUnits("10")).toBe(1_000_000_000n);
    expect(() => parseUnits("0.000000001")).toThrow(/8 decimal/);
    expect(() => parseUnits("0")).toThrow();
    expect(() => parseUnits("-1")).toThrow();
    expect(() => parseUnits("abc")).toThrow();
  });

  it("formats units back to a decimal", () => {
    expect(unitsToDecimal(25_000_000n)).toBe("0.25");
    expect(unitsToDecimal(1_000_000_000n)).toBe("10");
    expect(unitsToDecimal(1n)).toBe("0.00000001");
  });

  it("values units at a price and works backwards from a dollar value", () => {
    expect(unitsValue(25_000_000n, 77_142_300n)).toBe(19_285_575n);
    expect(unitsValue(1n, 50_000_000n)).toBe(1n);
    // $5,000 of VOO at $612.34 → 8.16539831 shares
    const u = unitsForValue(5_000_000n, 612_340n);
    expect(unitsToDecimal(u)).toBe("8.16539831");
    expect(unitsValue(u, 612_340n)).toBe(5_000_000n);
  });

  it("stores the price source on the account", () => {
    expect(quoteExternalId({ provider: "yahoo", symbol: "BRK-B" })).toBe("quote:yahoo:BRK-B");
    expect(parseQuoteExternalId("quote:coinbase:BTC")).toEqual({ provider: "coinbase", symbol: "BTC" });
    expect(parseQuoteExternalId("ACT-123")).toBeNull();
    expect(parseQuoteExternalId(null)).toBeNull();
    expect(validateAsset({ provider: "yahoo", symbol: " voo ", name: "" })).toEqual({ provider: "yahoo", symbol: "VOO", name: "VOO" });
    expect(() => validateAsset({ provider: "yahoo", symbol: "VOO; DROP", name: "x" })).toThrow();
  });

  it("fills missing days with the last known price", () => {
    const out = dailyPrices(
      [
        { date: "2026-01-03", price: 3n },
        { date: "2026-01-01", price: 1n },
      ],
      (d) => addDays(d, 1),
    );
    expect(out).toEqual([
      { date: "2026-01-01", price: 1n },
      { date: "2026-01-02", price: 1n },
      { date: "2026-01-03", price: 3n },
    ]);
  });
});
