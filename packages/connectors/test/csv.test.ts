import { describe, expect, it } from "vitest";
import { dedupeAgainst, detectDateFormat, parseAmountLoose, parseDateWithFormat, parseGenericCsv, previewCsv } from "../src/csv";
import { importHash } from "../src/normalize";
import { fixtureText } from "./helpers";

describe("generic CSV", () => {
  it("date format detection", () => {
    expect(detectDateFormat(["10/01/2026", "10/02/2026"])).toBe("MM/DD/YYYY");
    expect(detectDateFormat(["10/01/2026", "13/10/2026"])).toBe("DD/MM/YYYY");
    expect(detectDateFormat(["2026-10-05", "2026-10-07"])).toBe("YYYY-MM-DD");
    expect(detectDateFormat(["20261005"])).toBe("YYYYMMDD");
    expect(detectDateFormat(["Oct 5, 2026"])).toBe("MMM D, YYYY");
    expect(detectDateFormat(["5 Oct 2026"])).toBe("D MMM YYYY");
    expect(detectDateFormat(["garbage"])).toBeNull();
    expect(parseDateWithFormat("02/30/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseDateWithFormat("1/5/26", "MM/DD/YYYY")).toBe("2026-01-05");
    expect(parseDateWithFormat("10/05/2026 11:32 PM", "MM/DD/YYYY")).toBe("2026-10-05");
  });

  it("amount parsing", () => {
    expect(parseAmountLoose("$1,234.56")).toBe(1_234_560n);
    expect(parseAmountLoose("(27.80)")).toBe(-27_800n);
    expect(parseAmountLoose("12.00 DR")).toBe(-12_000n);
    expect(parseAmountLoose("12.00 CR")).toBe(12_000n);
    expect(parseAmountLoose("1.234,56")).toBe(1_234_560n);
    expect(parseAmountLoose("")).toBeUndefined();
  });

  it("outflow/inflow mapping; duplicates get distinct ids; bad rows warn", () => {
    const text = fixtureText("generic-bank.csv");
    const p = previewCsv(text);
    expect(p.suggested).toMatchObject({ date: "Posted Date", outflow: "Debit", inflow: "Credit", description: "Description", memo: "Memo" });
    const r = parseGenericCsv(text, "acct-co", { date: "Posted Date", outflow: "Debit", inflow: "Credit", description: "Description", memo: "Memo", dateFormat: "MM/DD/YYYY" });
    expect(r.transactions.map((t) => [t.date, t.amount, t.description])).toEqual([
      ["2026-10-01", -96_440n, "KROGER #123 FAIRVIEW VA"],
      ["2026-10-02", 3_250_000n, "PAYROLL DEPOSIT"],
      ["2026-10-03", -4_500n, "COFFEE SHOP"],
      ["2026-10-03", -4_500n, "COFFEE SHOP"],
    ]);
    expect(r.transactions[0]!.memo).toBe("groceries");
    expect(r.transactions[2]!.externalId).not.toBe(r.transactions[3]!.externalId);
    expect(r.transactions[3]!.externalId).toMatch(/#2$/);
    expect(r.warnings).toEqual([expect.stringMatching(/line 6: unparseable date/)]);
  });

  it("auto-detection treats an impossible MM/DD value as evidence of DD/MM", () => {
    // The fixture's "13/10/2026" row only parses as DD/MM, so auto mode flips the whole file; the UI preview shows this.
    expect(parseGenericCsv(fixtureText("generic-bank.csv"), "a", { date: "Posted Date", outflow: "Debit", inflow: "Credit" }).dateFormat).toBe("DD/MM/YYYY");
  });

  it("signed amount with invert + auto date + parentheses", () => {
    const r = parseGenericCsv(fixtureText("generic-card.csv"), "acct-fab", { date: "Trans. Date", amount: "Amount", description: "Description", invertAmount: true });
    expect(r.dateFormat).toBe("YYYY-MM-DD");
    expect(r.transactions.map((t) => t.amount)).toEqual([-118_360n, 421_180n, 27_800n]);
    expect(r.transactions[2]!.description).toBe("TST* BLUE PLATE DINER, MILTON VA");
  });

  it("index-based mapping without header; validation errors", () => {
    const r = parseGenericCsv("2026-01-02,-5.00,Thing\n", "a", { hasHeader: false, date: 0, amount: 1, description: 2 });
    expect(r.transactions[0]).toMatchObject({ date: "2026-01-02", amount: -5_000n, description: "Thing" });
    expect(() => parseGenericCsv("d,x\n2026-01-01,1\n", "a", { date: "d" })).toThrow(/amount/);
    expect(() => parseGenericCsv("d,x\n2026-01-01,1\n", "a", { date: "d", amount: "nope" })).toThrow(/not found/);
  });

  it("§8.4 dedupe: exact import_hash hits skipped, near duplicates flagged", () => {
    const r = parseGenericCsv(fixtureText("generic-bank.csv"), "acct-co", { date: "Posted Date", outflow: "Debit", inflow: "Credit", description: "Description", dateFormat: "MM/DD/YYYY" });
    const existing = [
      { date: "2026-10-01", amount: -96_440n, description: "Kroger #123 Fairview VA", importHash: importHash("acct-co", "2026-10-01", -96_440n, "KROGER #123 FAIRVIEW VA") },
      { date: "2026-10-04", amount: 3_250_000n, description: "PAYROLL DEP NORTHWIND" },
    ];
    const d = dedupeAgainst(r.transactions, existing, "acct-co");
    expect(d.exact.map((t) => t.description)).toEqual(["KROGER #123 FAIRVIEW VA"]);
    expect(d.near.map((t) => t.description)).toEqual(["PAYROLL DEPOSIT"]);
    expect(d.fresh).toHaveLength(2);
  });
});
