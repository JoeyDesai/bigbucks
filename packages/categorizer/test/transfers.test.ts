import { describe, expect, it } from "vitest";
import { accountMap, decideTransfer, detectTransferPairs, looksLikeTransfer, type TransferTxn } from "../src";
import { ACCOUNTS } from "./fixtures";

const accts = accountMap(ACCOUNTS);
const opts = { rtaCategoryId: "c-rta" };
const t = (id: string, accountId: string, date: string, amountMilli: bigint, rawDescription: string): TransferTxn => ({ id, accountId, date, amountMilli, rawDescription });

describe("transfer detection (§8.3)", () => {
  it("recognizes transfer-like descriptions and counterpart account names", () => {
    expect(looksLikeTransfer("FABRIKAM E-PAYMENT 1234")).toBe(true);
    expect(looksLikeTransfer("ONLINE TRANSFER TO SAVINGS")).toBe(true);
    expect(looksLikeTransfer("MERCURY ACH NORTHWIND")).toBe(true);
    expect(looksLikeTransfer("AUTOPAY 2342")).toBe(true);
    expect(looksLikeTransfer("CASH REWARDS THANKS", ACCOUNTS[2])).toBe(true);
    expect(looksLikeTransfer("LOWE'S #1234")).toBe(false);
  });

  it("auto-pairs card payments (checking → card)", () => {
    const out = t("o", "a-chk", "2026-10-10", -512_340n, "FABRIKAM E-PAYMENT 1234 WEB ID: 2510020270");
    const inn = t("i", "a-fab", "2026-10-12", 512_340n, "INTERNET PAYMENT - THANK YOU");
    const d = decideTransfer(out, [inn], accts, opts);
    expect(d.match).toMatchObject({ kind: "card_payment", auto: true, outflowId: "o", inflowId: "i", daysApart: 2, householdCategoryId: null });
    expect(decideTransfer(inn, [out], accts, opts).match?.kind).toBe("card_payment");
  });

  it("pairs Mercury → checking and puts the household side in Ready to Assign", () => {
    const merc = t("m", "a-merc", "2026-10-01", -3_000_000n, "Send Money transaction initiated on Mercury");
    const deposit = t("w", "a-chk", "2026-10-02", 3_000_000n, "MERCURY ACH NORTHWIND STUDIO");
    const d = decideTransfer(deposit, [merc], accts, opts);
    expect(d.match).toMatchObject({ kind: "business_to_household", auto: true, householdCategoryId: "c-rta", outflowId: "m", inflowId: "w" });
  });

  it("only suggests ambiguous pairs (two candidates)", () => {
    const out = t("o", "a-chk", "2026-10-10", -100_000n, "ONLINE TRANSFER TO CONTOSO SAVINGS");
    const c1 = t("c1", "a-sav", "2026-10-10", 100_000n, "ONLINE TRANSFER FROM CONTOSO CHECKING");
    const c2 = t("c2", "a-fab", "2026-10-11", 100_000n, "INTERNET PAYMENT - THANK YOU");
    const d = decideTransfer(out, [c1, c2], accts, opts);
    expect(d.match).toBeNull();
    expect(d.suggestions).toHaveLength(2);
    expect(d.suggestions.every((s) => !s.auto)).toBe(true);
  });

  it("auto-pairs an unambiguous household move when both sides look like transfers, suggests otherwise", () => {
    const out = t("o", "a-chk", "2026-10-10", -100_000n, "ONLINE TRANSFER TO CONTOSO SAVINGS");
    const inn = t("i", "a-sav", "2026-10-10", 100_000n, "ONLINE TRANSFER FROM CONTOSO CHECKING");
    expect(decideTransfer(out, [inn], accts, opts).match?.kind).toBe("internal");
    const weak = t("i2", "a-sav", "2026-10-10", 100_000n, "DEPOSIT");
    const d = decideTransfer(out, [weak], accts, opts);
    expect(d.match).toBeNull();
    expect(d.suggestions[0]?.kind).toBe("internal");
  });

  it("never auto-pairs to tracking accounts (e.g. 401k) or household → business", () => {
    const out = t("o", "a-chk", "2026-10-10", -50_000n, "TRANSFER TO FIDELITY");
    const inn = t("i", "a-401k", "2026-10-10", 50_000n, "CONTRIBUTION");
    expect(decideTransfer(out, [inn], accts, opts)).toMatchObject({ match: null, suggestions: [{ kind: "other" }] });
    const toBiz = t("b", "a-merc", "2026-10-11", 50_000n, "TRANSFER");
    expect(decideTransfer(out, [toBiz], accts, opts).match).toBeNull();
  });

  it("requires opposite equal amounts within 5 days and a transfer-like description", () => {
    const out = t("o", "a-chk", "2026-10-10", -100_000n, "FABRIKAM E-PAYMENT");
    expect(decideTransfer(out, [t("i", "a-fab", "2026-10-16", 100_000n, "PAYMENT")], accts, opts).match).toBeNull();
    expect(decideTransfer(out, [t("i", "a-fab", "2026-10-11", 100_010n, "PAYMENT")], accts, opts).match).toBeNull();
    const plainOut = t("o2", "a-chk", "2026-10-10", -100_000n, "LOWE'S");
    expect(decideTransfer(plainOut, [t("i", "a-fab", "2026-10-11", 100_000n, "REFUND")], accts, opts).match).toBeNull();
  });

  it("batch detection auto-pairs only unambiguous pairs", () => {
    const txns = [
      t("o1", "a-chk", "2026-10-10", -512_340n, "FABRIKAM E-PAYMENT"),
      t("i1", "a-fab", "2026-10-11", 512_340n, "INTERNET PAYMENT - THANK YOU"),
      t("o2", "a-chk", "2026-10-12", -20_000n, "CONTOSO CARD AUTOPAY"),
      t("o3", "a-chk", "2026-10-12", -20_000n, "CONTOSO CARD AUTOPAY"),
      t("i2", "a-card", "2026-10-12", 20_000n, "AUTOMATIC PAYMENT - THANK YOU"),
    ];
    const r = detectTransferPairs(txns, accts, opts);
    expect(r.auto.map((m) => [m.outflowId, m.inflowId])).toEqual([["o1", "i1"]]);
    expect(r.suggestions.map((m) => m.outflowId).sort()).toEqual(["o2", "o3"]);
  });
});
