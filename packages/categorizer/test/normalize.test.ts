import { describe, expect, it } from "vitest";
import { matchAlias, normalizePayee, normalizedKey, proposeAliasPattern, titleCase, type PayeeAlias } from "../src";

describe("normalizePayee (§9.2)", () => {
  it.each([
    ["PURCHASE AUTHORIZED ON 10/14 LOWE'S #1234 FAIRVIEW VA S586287012345678 CARD 9876", "Lowe's", "Fairview", "VA"],
    ["SQ *BLUE RIDGE COFFEE Fairview VA", "Blue Ridge Coffee", "Fairview", "VA"],
    ["TST* KESSLERS DINER 123", "Kesslers Diner", null, null],
    ["PAYPAL *SPOTIFY 4029357733", "Spotify", null, null],
    ["POS PURCHASE KROGER #0423 MILTON VA", "Kroger", "Milton", "VA"],
    ["AMZN Mktp US*2K4L83", "Amazon", null, null],
    ["NETFLIX.COM 866-579-7172 CA", "Netflix", null, "CA"],
    ["ACH DEBIT FAIRVIEW POWER BILLPAY 211234 WEB ID: 9000000001", "Fairview Power", null, null],
    ["COSTCO WHSE #0123 FAIRVIEW VA", "Costco", "Fairview", "VA"],
    ["MCDONALD'S F12345", "McDonald's", null, null],
    ["CHICK-FIL-A #01234", "Chick-fil-A", null, null],
    ["O'REILLY AUTO PARTS 1234 MILTON VA", "O'Reilly Auto Parts", "Milton", "VA"],
    ["TACO BELL 030123 SPRINGFIELD VA", "Taco Bell", "Springfield", "VA"],
    ["RECURRING PAYMENT AUTHORIZED ON 10/01 HULU 877-8244858 CA S123456789012345 CARD 1234", "Hulu", null, "CA"],
    ["FABRIKAM E-PAYMENT 1234", "Fabrikam", null, null],
    ["AT&T *PAYMENT", "AT&T", null, null],
    ["7-ELEVEN VA", "7-Eleven", null, "VA"],
    ["KESSLER S MINFAIRVIEW", "Kessler S Minfairview", null, null],
  ])("%s → %s", (raw, name, city, state) => {
    const n = normalizePayee(raw);
    expect(n.name).toBe(name);
    expect(n.city).toBe(city);
    expect(n.state).toBe(state);
    expect(n.key).toBe(normalizedKey(name));
  });

  it("never returns an empty name", () => {
    expect(normalizePayee("#1234").name).not.toBe("");
  });
});

describe("titleCase / normalizedKey", () => {
  it("title-cases with apostrophes, small words and acronyms", () => {
    expect(titleCase("LOWE'S")).toBe("Lowe's");
    expect(titleCase("O'REILLY")).toBe("O'Reilly");
    expect(titleCase("BANK OF AMERICA")).toBe("Bank of America");
    expect(titleCase("CVS PHARMACY")).toBe("CVS Pharmacy");
    expect(titleCase("H&M")).toBe("H&M");
  });
  it("builds stable keys", () => {
    expect(normalizedKey("Lowe's")).toBe("lowes");
    expect(normalizedKey("Chick-fil-A")).toBe("chickfila");
    expect(normalizedKey("Café Rio")).toBe("caferio");
  });
});

describe("alias matching", () => {
  const aliases: PayeeAlias[] = [
    { id: "1", pattern: "KESSLER S MIN", match: "prefix", payeeId: "p-kessler" },
    { id: "2", pattern: "KESSLER S MINFAIRVIEW", match: "prefix", payeeId: "p-kessler-long" },
    { id: "3", pattern: "SQ *BLUE RIDGE COFFEE FAIRVIEW VA", match: "exact", payeeId: "p-brc-exact" },
    { id: "4", pattern: "^SQ \\*BLUE", match: "regex", payeeId: "p-brc-regex" },
    { id: "5", pattern: "([", match: "regex", payeeId: "p-bad" },
  ];
  it("prefers exact, then the longest prefix, then regex", () => {
    expect(matchAlias("sq *blue ridge coffee  fairview va", aliases)?.payeeId).toBe("p-brc-exact");
    expect(matchAlias("KESSLER S MINFAIRVIEW VA", aliases)?.payeeId).toBe("p-kessler-long");
    expect(matchAlias("SQ *BLUE RIDGE COFFEE MILTON VA", aliases)?.payeeId).toBe("p-brc-regex");
    expect(matchAlias("UNRELATED", aliases)).toBeNull();
  });
  it("matches prefixes after bank boilerplate is removed", () => {
    expect(matchAlias("PURCHASE AUTHORIZED ON 10/14 KESSLER S MIN 0042", aliases)?.payeeId).toBe("p-kessler");
  });
  it("proposes a prefix alias from the descriptor head", () => {
    expect(proposeAliasPattern("PURCHASE AUTHORIZED ON 10/14 KESSLER S MINFAIRVIEW #0042 VA")).toEqual({ pattern: "KESSLER S MINFAIRVIEW", match: "prefix" });
    expect(proposeAliasPattern("ABC")).toEqual({ pattern: "ABC", match: "exact" });
  });
});
