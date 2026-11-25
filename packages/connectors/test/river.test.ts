import { describe, expect, it } from "vitest";
import { computeBtcPosition, parseRiverCsv, parseRiverDate, previewRiverCsv, riverRowsToTxns, valueSats } from "../src/river";
import { fixtureText } from "./helpers";

const csv = fixtureText("river-activity.csv");

describe("River activity CSV", () => {
  it("previews headers and suggests the §7.4 column mapping", () => {
    const p = previewRiverCsv(csv);
    expect(p.missing).toEqual([]);
    expect(p.mapping).toMatchObject({ date: "Date (UTC)", type: "Transaction Type", sentAmount: "Sent Amount", receivedCurrency: "Received Currency", feeAmount: "Fee Amount", btcPriceAmount: "Bitcoin Price Amount", transactionId: "Transaction ID", tag: "Tag" });
    expect(p.sample).toHaveLength(5);
    expect(p.sample[0]!["Reference Code"]).toBe("RVR-0001");
  });

  it("parses rows (UTC → local date) and computes the BTC position in sats", () => {
    const { rows, warnings } = parseRiverCsv(csv);
    expect(warnings).toEqual([]);
    expect(rows.map((r) => r.btcDeltaSats)).toEqual([523_560n, 1_020_408n, 1_200n, -1_002_000n, -100_000n]);
    expect(rows[3]!.date).toBe("2026-06-29"); // 03:30 UTC on the 30th is the 29th in New York
    expect(rows[1]!.costBasis).toBe(1_000_000n); // "1,000.00" USD
    const pos = computeBtcPosition(rows);
    expect(pos).toMatchObject({ sats: 443_168n, btc: "0.00443168", netUsdInvested: 1_391_750n, reportedCostBasis: 1_501_100n, asOf: "2026-09-15T16:45:00.000Z" });
    // The 2026-03-01 00:10 UTC interest is still Feb 28 in New York, so it counts.
    expect(computeBtcPosition(rows, "2026-02-28").sats).toBe(1_545_168n);
    expect(computeBtcPosition(rows, "2026-02-27").sats).toBe(1_543_968n);
  });

  it("values a position at a spot price with exact rounding", () => {
    expect(valueSats(443_168n, 67_123_450n)).toBe(297_470n); // 0.00443168 × $67,123.45 = $297.46965…
    expect(valueSats(100_000_000n, 67_123_450n)).toBe(67_123_450n);
    expect(valueSats(-1n, 67_123_450n)).toBe(-1n);
  });

  it("maps rows to USD-valued transactions with BTC quantities", () => {
    const txns = riverRowsToTxns(parseRiverCsv(csv).rows);
    expect(txns.map((t) => [t.externalId, t.amount, t.asset?.quantity])).toEqual([
      ["RVR-0001", 500_000n, "0.0052356"],
      ["RVR-0002", 1_000_000n, "0.01020408"],
      ["RVR-0003", 1_100n, "0.000012"], // 0.000012 BTC × $91,666.67
      ["RVR-0004", -1_052_100n, "-0.01002"], // withdrawal incl. fee × $105,000
      ["RVR-0005", -108_250n, "-0.001"],
    ]);
    expect(txns[3]).toMatchObject({ memo: "cold storage", description: "River Withdrawal", accountExternalId: "river" });
  });

  it("accepts edited mappings and reports bad lines without failing", () => {
    const custom = "When,Kind,Got,GotCcy\n2026-01-01 00:00:00,Buy,0.1,BTC\nnot-a-date,Buy,0.1,BTC\n";
    expect(() => parseRiverCsv(custom)).toThrow(/missing columns: date, type/);
    const { rows, warnings } = parseRiverCsv(custom, { date: "When", type: "Kind", receivedAmount: "Got", receivedCurrency: "GotCcy" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.btcDeltaSats).toBe(10_000_000n);
    expect(warnings[0]).toMatch(/line 3/);
  });

  it("date formats", () => {
    expect(parseRiverDate("2026-01-05 15:00:00")).toBe("2026-01-05T15:00:00.000Z");
    expect(parseRiverDate("2026-01-05T15:00:00Z")).toBe("2026-01-05T15:00:00.000Z");
    expect(parseRiverDate("01/05/2026 15:00")).toBe("2026-01-05T15:00:00.000Z");
    expect(parseRiverDate("2026-01-05 10:00:00 -05:00")).toBe("2026-01-05T15:00:00.000Z");
  });
});
