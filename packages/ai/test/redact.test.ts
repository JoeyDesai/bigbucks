import { describe, expect, it } from "vitest";
import { checkWebSearchQuery, redactDeep, redactDigits, toModelJson, MASK } from "../src";

describe("redactDigits", () => {
  it("masks runs of 4+ digits", () => {
    expect(redactDigits("PURCHASE AUTHORIZED ON 10/14 LOWE'S #1234 FAIRVIEW VA S586287012345678 CARD 9876")).toBe(
      `PURCHASE AUTHORIZED ON 10/14 LOWE'S #${MASK} FAIRVIEW VA S${MASK} CARD ${MASK}`,
    );
  });
  it("keeps short digit runs", () => {
    expect(redactDigits("7-ELEVEN 123")).toBe("7-ELEVEN 123");
    expect(redactDigits("Route 66 Diner")).toBe("Route 66 Diner");
  });
});

describe("redactDeep", () => {
  it("masks free-text keys but leaves ids, dates and amounts alone", () => {
    const out = redactDeep({
      id: "0192f3a0-1234-7abc-8def-123456789012",
      date: "2026-10-14",
      raw_description: "ACH DEBIT CONTOSO 12345678",
      memo: "ref 4455",
      amount: -612400n,
      category: "2026 Vacation",
      nested: [{ payee: "STORE 9876" }],
    });
    expect(out.id).toBe("0192f3a0-1234-7abc-8def-123456789012");
    expect(out.date).toBe("2026-10-14");
    expect(out.raw_description).toBe(`ACH DEBIT CONTOSO ${MASK}`);
    expect(out.memo).toBe(`ref ${MASK}`);
    expect(out.amount).toBe(-612400n);
    expect(out.category).toBe("2026 Vacation");
    expect(out.nested[0]!.payee).toBe(`STORE ${MASK}`);
  });
  it("masks 8+ digit runs anywhere (account-number safety net)", () => {
    expect(redactDeep({ whatever: "acct 123456789" }).whatever).toBe(`acct ${MASK}`);
  });
  it("toModelJson formats bigint as dollars and redacts", () => {
    expect(toModelJson({ amount: -612400n, memo: "card 1234" })).toBe(`{"amount":"-$612.40","memo":"card ${MASK}"}`);
  });
});

describe("web search query guard", () => {
  const policy = { householdNames: ["Alex", "Sam", "Rivera"] };
  it("allows a merchant string and city", () => {
    expect(checkWebSearchQuery("Kessler's Mini Mart Fairview VA", policy)).toEqual({ ok: true });
    expect(checkWebSearchQuery("KESSLER S MIN Fairview", policy)).toEqual({ ok: true });
  });
  it.each([
    ["Kessler's Mini Mart $43.17", "currency symbol"],
    ["Kessler's Mini Mart 43.17", "looks like an amount"],
    ["Lowe's 1234 Fairview", "digit run of 4+"],
    ["alex@example.com Lowe's", "email address"],
    ["Lowe's 212-555-0142", "phone number"],
    ["Lowe's card ending", "financial or personal vocabulary"],
    ["Sam Rivera Lowe's", "household member name"],
    ["", "empty query"],
  ])("rejects %s", (q, reason) => {
    expect(checkWebSearchQuery(q, policy)).toEqual({ ok: false, reason });
  });
});
