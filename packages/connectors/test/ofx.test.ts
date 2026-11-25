import { describe, expect, it } from "vitest";
import { parseOfx, parseOfxDate, statementWindow } from "../src/ofx";
import { fixtureText } from "./helpers";

describe("OFX/QFX", () => {
  it("SGML (OFX 1.x) bank statement", () => {
    const { statements, warnings } = parseOfx(fixtureText("sample-sgml.qfx"));
    expect(warnings).toEqual([]);
    expect(statements).toHaveLength(1);
    const s = statements[0]!;
    expect(s).toMatchObject({ accountLast4: "5678", accountType: "CHECKING", isCreditCard: false, currency: "USD", ledgerBalance: 4_210_550n, availableBalance: 4_185_550n, startDate: "2026-10-01", endDate: "2026-10-21" });
    expect(s.accountExternalId).toMatch(/^ofx:[0-9a-f]{16}$/);
    expect(JSON.stringify(statements, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain("000012345678");
    expect(s.transactions.map((t) => [t.externalId, t.date, t.amount, t.description])).toEqual([
      ["2026101400001", "2026-10-13", -612_400n, "CONTOSO CARD AUTO PAY"], // DTUSER wins (§6.1)
      ["2026101500002", "2026-10-15", 3_250_000n, "NORTHWIND STUDIO PAYROLL & CO"],
      ["2026101600003", "2026-10-15", -12_340n, "LATE NIGHT TACOS"], // 02:30 GMT = 22:30 EDT the day before
    ]);
    expect(s.transactions[0]).toMatchObject({ memo: "REF 000000", postedAt: "2026-10-14T12:00:00.000Z" });
    expect(s.transactions[2]!.mcc).toBe("5812");
    expect(statementWindow(s)).toEqual({ since: "2026-09-30", until: "2026-10-22" });
  });

  it("XML (OFX 2.x) credit card statement", () => {
    const { statements } = parseOfx(fixtureText("sample-xml.ofx"));
    const s = statements[0]!;
    expect(s).toMatchObject({ isCreditCard: true, accountType: "CREDITCARD", accountLast4: "0004", ledgerBalance: -733_410n, startDate: "2026-10-01" });
    expect(s.transactions.map((t) => [t.externalId, t.date, t.amount, t.memo])).toEqual([
      ["FIT-A", "2026-10-05", -118_360n, "Amzn.com/bill WA"],
      ["FIT-B", "2026-10-17", 421_180n, undefined],
    ]);
  });

  it("dates", () => {
    expect(parseOfxDate("20261005")).toEqual({ date: "2026-10-05" });
    expect(parseOfxDate("20261005000000.000[-5:EST]")).toEqual({ date: "2026-10-05", iso: "2026-10-05T05:00:00.000Z" });
    expect(parseOfxDate("20261016023000[0:GMT]").date).toBe("2026-10-15");
    expect(parseOfxDate("20261016023000").date).toBe("2026-10-15");
    expect(() => parseOfxDate("nope")).toThrow();
  });

  it("rejects non-OFX and tolerates missing FITIDs", () => {
    expect(() => parseOfx("hello")).toThrow(/OFX/);
    const r = parseOfx("<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>99</BANKACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>20260101<TRNAMT>-1.00<NAME>A</STMTTRN><STMTTRN><DTPOSTED>20260101<TRNAMT>-1.00<NAME>A</STMTTRN><STMTTRN><NAME>broken</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>");
    const ids = r.statements[0]!.transactions.map((t) => t.externalId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(`${ids[0]}#2`);
    expect(r.warnings).toHaveLength(1);
  });
});
