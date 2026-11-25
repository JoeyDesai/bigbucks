import { describe, expect, it } from "vitest";
import { fidelityMoney, guessFidelityKind, parseFidelityPositionsCsv } from "../src/fidelity";
import { fixtureText } from "./helpers";

describe("Fidelity positions CSV", () => {
  const r = parseFidelityPositionsCsv(fixtureText("Portfolio_Positions_Oct-22-2026.csv"));

  it("parses positions and ignores the footer disclaimer", () => {
    expect(r.warnings).toEqual([]);
    expect(r.positions.map((p) => p.symbol)).toEqual(["SPAXX", "FXAIX", "VTI", "Pending Activity", "BLKRK2050"]);
    expect(r.downloadedAt).toBe("2026-10-22");
  });

  it("strips $ , % and keeps totals as milli", () => {
    const fx = r.positions.find((p) => p.symbol === "FXAIX")!;
    expect(fx).toMatchObject({ quantity: "52.318", lastPrice: 214_330n, currentValue: 11_213_310n, costBasisTotal: 9_200_000n, averageCostBasis: 175_850n, accountName: "Individual" });
    expect(fidelityMoney("+$2,013.31")).toBe(2_013_310n);
    expect(fidelityMoney("-0.13%")).toBe(-130n);
    expect(fidelityMoney("--")).toBeUndefined();
  });

  it("rolls up accounts (incl. pending activity) with last-4 only", () => {
    expect(r.accounts).toHaveLength(2);
    const [brk, k401] = r.accounts;
    expect(brk).toMatchObject({ name: "Individual (0001)", kindGuess: "brokerage", balance: 18_369_870n, institution: "Fidelity", asOf: "2026-10-22T12:00:00.000Z" });
    expect(k401).toMatchObject({ name: "ACME 401(K) PLAN (0002)", kindGuess: "retirement", balance: 12_809_220n });
    const ser = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(ser(r.accounts)).not.toContain("Z00000001");
    expect(ser(r.holdings)).not.toContain("Z00000001");
  });

  it("holdings: one per position, money market valued as cash, pending skipped", () => {
    expect(r.holdings.map((h) => [h.symbol, h.shares, h.marketValue, h.costBasis])).toEqual([
      ["SPAXX", "1234.56", 1_234_560n, undefined],
      ["FXAIX", "52.318", 11_213_310n, 9_200_000n],
      ["VTI", "20", 6_022_000n, 5_500_000n],
      ["BLKRK2050", "410.552", 12_809_220n, 11_000_000n],
    ]);
    expect(r.holdings[3]!.accountExternalId).toBe(r.accounts[1]!.externalId);
  });

  it("kind guesses and rejects non-Fidelity files", () => {
    expect(guessFidelityKind("ROTH IRA")).toBe("retirement");
    expect(guessFidelityKind("Health Savings Account")).toBe("hsa");
    expect(guessFidelityKind("Joint WROS")).toBe("brokerage");
    expect(() => parseFidelityPositionsCsv("a,b,c\n1,2,3\n")).toThrow(/Fidelity/);
  });
});
