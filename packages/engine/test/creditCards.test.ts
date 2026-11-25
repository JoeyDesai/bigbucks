import { describe, expect, it } from "vitest";
import { computeBudget } from "../src/budget";
import { $, c, m, pay, RTA_ID, snap, UNCAT_ID } from "./helpers";

const P = pay("visa");
const base = () => snap().account("chk").card("visa").cat("groc").cat("fun").income("chk", "2026-01-01", 5000);

describe("§6.4 rule 1: card purchases move the funded portion to P(K)", () => {
  it("fully funded purchase: A moves to P(K); category is not double-charged", () => {
    const r = base().assign("2026-01", "groc", 200).spend("visa", "2026-01-10", "groc", 120).run("2026-01");
    expect(c(r, "2026-01", "groc")).toMatchObject({ activity: $(-120), available: $(80), creditSpending: $(-120), cashSpending: 0n });
    expect(c(r, "2026-01", P)).toMatchObject({ activity: $(120), available: $(120) });
    expect(c(r, "2026-01", P).payment).toMatchObject({ fundedSpending: $(120), unfundedSpending: 0n, cardBalance: $(-120), debt: $(120) });
    expect(m(r, "2026-01").activity).toBe($(-120)); // moves are not month activity
  });

  it("partial funding: only Funds(c) moves; the rest is credit overspending", () => {
    const r = base().assign("2026-01", "groc", 30).spend("visa", "2026-01-10", "groc", 50).run("2026-02");
    expect(c(r, "2026-01", P).activity).toBe($(30));
    expect(c(r, "2026-01", "groc")).toMatchObject({ available: $(-20), creditOverspend: $(20) });
    // next month: debt 50, P(K) has 30 → underfunded 20 (YNAB "Underfunded" alert)
    expect(c(r, "2026-02", P)).toMatchObject({ available: $(30), needed: $(20), underfunded: $(20), status: "underfunded" });
    expect(m(r, "2026-02").rta).toBe($(5000 - 30));
  });

  it("assigning later in the month retroactively funds earlier card spending", () => {
    const before = base().spend("visa", "2026-01-03", "groc", 100);
    expect(c(before.run("2026-01"), "2026-01", P).activity).toBe(0n);
    const after = before.assign("2026-01", "groc", 100).run("2026-01");
    expect(c(after, "2026-01", P).activity).toBe($(100));
    expect(c(after, "2026-01", "groc").available).toBe(0n);
  });

  it("carry from last month funds this month's card spending", () => {
    const r = base().assign("2026-01", "groc", 75).spend("visa", "2026-02-03", "groc", 100).run("2026-02");
    expect(c(r, "2026-02", P).activity).toBe($(75));
    expect(c(r, "2026-02", "groc").creditOverspend).toBe($(25));
  });

  it("Funds(c) is consumed in (date, importOrder, id) order", () => {
    // two card purchases on the same day; funds only cover one; tie broken by importOrder
    const r = base()
      .card("amex")
      .assign("2026-01", "groc", 40)
      .tx({ acct: "amex", date: "2026-01-05", amt: -40, cat: "groc", order: 2, id: "b" })
      .tx({ acct: "visa", date: "2026-01-05", amt: -40, cat: "groc", order: 1, id: "a" })
      .run("2026-01");
    expect(c(r, "2026-01", P).activity).toBe($(40));
    expect(c(r, "2026-01", pay("amex")).activity).toBe(0n);
    // same importOrder → id decides
    const r2 = base()
      .card("amex")
      .assign("2026-01", "groc", 40)
      .tx({ acct: "amex", date: "2026-01-05", amt: -40, cat: "groc", order: 1, id: "a" })
      .tx({ acct: "visa", date: "2026-01-05", amt: -40, cat: "groc", order: 1, id: "b" })
      .run("2026-01");
    expect(c(r2, "2026-01", pay("amex")).activity).toBe($(40));
    expect(c(r2, "2026-01", P).activity).toBe(0n);
  });

  it("cash outflows consume Funds(c) in the same ordered pass", () => {
    const r = base().assign("2026-01", "groc", 100).spend("chk", "2026-01-02", "groc", 70).spend("visa", "2026-01-03", "groc", 50).run("2026-01");
    expect(c(r, "2026-01", P).activity).toBe($(30));
  });

  it("uncategorized card spending is unfunded: P(K) gets nothing and shows underfunded", () => {
    const r = base().spend("visa", "2026-01-03", null, 60).run("2026-02");
    expect(c(r, "2026-01", UNCAT_ID)).toMatchObject({ creditOverspend: $(60), cashOverspend: 0n });
    expect(c(r, "2026-01", P).activity).toBe(0n);
    expect(c(r, "2026-02", P).underfunded).toBe($(60));
  });

  it("pending card transactions are ignored, including for the card balance", () => {
    const r = base().assign("2026-01", "groc", 100).tx({ acct: "visa", date: "2026-01-03", amt: -60, cat: "groc", cleared: "pending" }).run("2026-01");
    expect(c(r, "2026-01", P).activity).toBe(0n);
    expect(c(r, "2026-01", P).payment!.cardBalance).toBe(0n);
  });

  it("lines of credit behave like cards", () => {
    const r = snap().account("chk").card("loc", "line_of_credit").cat("a").income("chk", "2026-01-01", 100).assign("2026-01", "a", 100).spend("loc", "2026-01-02", "a", 40).run("2026-01");
    expect(c(r, "2026-01", pay("loc")).activity).toBe($(40));
  });

  it("a card without a payment category gets a virtual one (with a warning)", () => {
    const r = snap().account("chk").account("disc", "credit_card").cat("a").income("chk", "2026-01-01", 100).assign("2026-01", "a", 100).spend("disc", "2026-01-02", "a", 40).run("2026-01");
    expect(c(r, "2026-01", "__cc_payment__:disc").activity).toBe($(40));
    expect(r.warnings.join()).toContain("no payment category");
  });

  it("a payment category without a linked account is reported", () => {
    const s = base().build();
    s.categories.push({ id: "orphan", groupId: "g-cc", kind: "cc_payment", linkedAccountId: null, hidden: false, sort: 99 });
    expect(computeBudget(s, { through: "2026-01-01" }).warnings.join()).toContain("orphan");
  });
});

describe("§6.4 rule 2: refunds and returns", () => {
  it("a card refund categorized to c subtracts the full amount from P(K) and adds it to c", () => {
    const r = base().assign("2026-01", "groc", 100).spend("visa", "2026-01-03", "groc", 100).tx({ acct: "visa", date: "2026-01-10", amt: 30, cat: "groc" }).run("2026-01");
    expect(c(r, "2026-01", P)).toMatchObject({ activity: $(70), available: $(70) });
    expect(c(r, "2026-01", P).payment!.refunds).toBe($(-30));
    expect(c(r, "2026-01", "groc").available).toBe($(30));
  });

  it("a refund in the same month funds the purchase it refunds (inflows count toward Funds(c))", () => {
    const r = base().spend("visa", "2026-01-03", "groc", 50).tx({ acct: "visa", date: "2026-01-10", amt: 50, cat: "groc" }).run("2026-01");
    expect(c(r, "2026-01", "groc").available).toBe(0n);
    expect(c(r, "2026-01", P)).toMatchObject({ activity: 0n, available: 0n });
    expect(c(r, "2026-01", P).payment).toMatchObject({ fundedSpending: $(50), refunds: $(-50) });
  });

  it("refund larger than the funded portion drives P(K) negative (cash overspending, ADR-E5)", () => {
    // January purchase was unfunded (credit overspending); refunded in February
    const r = base().spend("visa", "2026-01-03", "groc", 50).tx({ acct: "visa", date: "2026-02-10", amt: 50, cat: "groc" }).run("2026-03");
    expect(c(r, "2026-01", "groc").creditOverspend).toBe($(50));
    expect(c(r, "2026-02", "groc").available).toBe($(50));
    expect(c(r, "2026-02", P)).toMatchObject({ activity: $(-50), available: $(-50), cashOverspend: $(50), status: "overspent_cash" });
    expect(m(r, "2026-03").cashOverspendingLastMonth).toBe($(50));
    expect(c(r, "2026-03", P).carryIn).toBe(0n);
  });

  it("refund in a later month after the card was paid", () => {
    const r = base()
      .assign("2026-01", "groc", 100)
      .spend("visa", "2026-01-03", "groc", 100)
      .transfer("chk", "visa", "2026-01-20", 100)
      .tx({ acct: "visa", date: "2026-02-05", amt: 20, cat: "groc" })
      .run("2026-02");
    expect(c(r, "2026-01", P).available).toBe(0n);
    expect(c(r, "2026-02", P).available).toBe($(-20));
    expect(c(r, "2026-02", "groc").available).toBe($(20));
    // the card is now +20 (positive): the above-zero part is "Inflow from Debt Account"
    expect(m(r, "2026-02").inflowFromDebtAccounts).toBe($(20));
  });
});

describe("§6.4 rule 3: payments", () => {
  it("a payment reduces P(K) by the payment amount", () => {
    const r = base().assign("2026-01", "groc", 200).spend("visa", "2026-01-03", "groc", 150).transfer("chk", "visa", "2026-01-25", 150).run("2026-01");
    expect(c(r, "2026-01", P)).toMatchObject({ activity: 0n, available: 0n });
    expect(c(r, "2026-01", P).payment).toMatchObject({ payments: $(-150), fundedSpending: $(150), cardBalance: 0n });
    expect(m(r, "2026-01").rta).toBe($(4800));
  });

  it("payment larger than the payment category balance → red P(K), hits next month's RTA", () => {
    // 80 of debt, only 50 funded; pay 80
    const r = base().assign("2026-01", "groc", 50).spend("visa", "2026-01-03", "groc", 80).transfer("chk", "visa", "2026-01-25", 80).run("2026-02");
    expect(c(r, "2026-01", P)).toMatchObject({ available: $(-30), cashOverspend: $(30), status: "overspent_cash" });
    expect(m(r, "2026-02")).toMatchObject({ cashOverspendingLastMonth: $(30), rta: $(5000 - 50 - 30) });
  });

  it("paymentCategoryNegative: carry keeps a negative P(K) balance", () => {
    const r = base().assign("2026-01", "groc", 50).spend("visa", "2026-01-03", "groc", 80).transfer("chk", "visa", "2026-01-25", 80).run("2026-02", { paymentCategoryNegative: "carry" });
    expect(c(r, "2026-01", P).cashOverspend).toBe(0n);
    expect(c(r, "2026-02", P)).toMatchObject({ carryIn: $(-30), available: $(-30) });
    expect(m(r, "2026-02").rta).toBe($(4950));
  });

  it("paying last month's credit overspending: assign to P(K) then pay", () => {
    const r = base().spend("visa", "2026-01-03", "groc", 100).assign("2026-02", P, 100).transfer("chk", "visa", "2026-02-10", 100).run("2026-02");
    expect(c(r, "2026-02", P)).toMatchObject({ assigned: $(100), activity: $(-100), available: 0n, underfunded: 0n });
  });

  it("cash advance (card → checking) adds the new debt to P(K)", () => {
    const r = base().transfer("visa", "chk", "2026-01-05", 200).run("2026-01");
    expect(c(r, "2026-01", P).payment!.payments).toBe($(200));
    expect(c(r, "2026-01", P).available).toBe($(200));
    expect(m(r, "2026-01").rta).toBe($(5000));
  });

  it("card-to-card balance transfers don't move money between payment categories", () => {
    const r = base().card("amex").assign("2026-01", "groc", 100).spend("visa", "2026-01-02", "groc", 100).transfer("amex", "visa", "2026-01-05", 100).run("2026-01");
    expect(c(r, "2026-01", P).activity).toBe($(100));
    expect(c(r, "2026-01", pay("amex")).activity).toBe(0n);
    expect(c(r, "2026-01", pay("amex")).payment!.debt).toBe($(100));
    expect(c(r, "2026-01", P).payment!.cardBalance).toBe(0n);
  });

  it("a scheduled payment counts as upcoming for P(K)", () => {
    const r = base().assign("2026-01", "groc", 100).spend("visa", "2026-01-02", "groc", 100).scheduled({ accountId: "chk", transferAccountId: "visa", amount: $(-300), frequency: "monthly", nextDate: "2026-01-28" }).run("2026-01");
    expect(c(r, "2026-01", P).upcoming).toBe($(300));
    expect(c(r, "2026-01", P).underfunded).toBe($(200));
  });
});

describe("§6.4 rule 4: interest and fees", () => {
  it("interest categorized directly to P(K) reduces it without moving money", () => {
    const r = base().assign("2026-01", "groc", 100).spend("visa", "2026-01-02", "groc", 100).tx({ acct: "visa", date: "2026-01-28", amt: -12.34, cat: P }).run("2026-01");
    expect(c(r, "2026-01", P)).toMatchObject({ activity: $(100 - 12.34), available: $(87.66) });
    expect(c(r, "2026-01", P).payment!.direct).toBe($(-12.34));
    expect(m(r, "2026-01").activity).toBe($(-112.34));
  });

  it("YNAB's 'Credit Card Interest' category (unassignable) is credit overspending: no RTA hit, P(K) underfunded", () => {
    const r = base().cat("ccint", { hidden: true }).tx({ acct: "visa", date: "2026-01-28", amt: -10, cat: "ccint" }).run("2026-02");
    expect(c(r, "2026-01", "ccint")).toMatchObject({ creditOverspend: $(10), cashOverspend: 0n });
    expect(c(r, "2026-02", P).underfunded).toBe($(10));
    expect(m(r, "2026-02").rta).toBe($(5000));
  });
});

describe("§6.4 rule 5: pre-existing debt", () => {
  it("card starting balance (debt) has no budget effect and makes P(K) underfunded", () => {
    const r = base().tx({ acct: "visa", date: "2026-01-01", amt: -1500, cat: null, sb: true }).run("2026-01");
    expect(m(r, "2026-01").rta).toBe($(5000));
    expect(c(r, "2026-01", UNCAT_ID).activity).toBe(0n);
    expect(c(r, "2026-01", P)).toMatchObject({ activity: 0n, needed: $(1500), underfunded: $(1500), status: "underfunded" });
    expect(c(r, "2026-01", P).payment!.debt).toBe($(1500));
  });

  it("card starting debt categorized to RTA still has no effect by default", () => {
    const r = base().tx({ acct: "visa", date: "2026-01-01", amt: -1500, cat: RTA_ID, sb: true }).run("2026-01");
    expect(m(r, "2026-01").rta).toBe($(5000));
  });

  it("cardStartingDebt: as_categorized treats it like any transaction", () => {
    const r = base().tx({ acct: "visa", date: "2026-01-01", amt: -1500, cat: RTA_ID, sb: true }).run("2026-01", { cardStartingDebt: "as_categorized", cardRtaLines: "income" });
    expect(m(r, "2026-01").rta).toBe($(3500));
    const u = base().tx({ acct: "visa", date: "2026-01-01", amt: -1500, cat: null, sb: true }).run("2026-01", { cardStartingDebt: "as_categorized" });
    expect(c(u, "2026-01", UNCAT_ID).creditOverspend).toBe($(1500));
  });

  it("a card starting with a credit (positive) balance adds it to RTA", () => {
    const r = base().tx({ acct: "visa", date: "2026-01-01", amt: 40, cat: null, sb: true }).run("2026-01");
    expect(m(r, "2026-01")).toMatchObject({ income: $(5000), inflowFromDebtAccounts: $(40), rta: $(5040) });
    expect(c(r, "2026-01", P).activity).toBe(0n);
  });

  it("assigning to P(K) covers the starting debt", () => {
    const r = base().tx({ acct: "visa", date: "2026-01-01", amt: -1500, cat: null, sb: true }).assign("2026-01", P, 1500).run("2026-01");
    expect(c(r, "2026-01", P)).toMatchObject({ available: $(1500), underfunded: 0n, status: "funded" });
  });
});

describe("§6.4 rule 6: overpaid card (positive balance)", () => {
  it("overpayment: P(K) goes red by the full payment; the positive balance is added to RTA", () => {
    const r = base().assign("2026-01", "groc", 100).spend("visa", "2026-01-02", "groc", 100).transfer("chk", "visa", "2026-01-20", 150).run("2026-02");
    expect(c(r, "2026-01", P)).toMatchObject({ available: $(-50), cashOverspend: $(50) });
    expect(m(r, "2026-01")).toMatchObject({ inflowFromDebtAccounts: $(50), rta: $(5000 - 100 + 50) });
    expect(m(r, "2026-02").rta).toBe($(4900)); // 4950 − 50 cash overspending
    expect(c(r, "2026-01", P).payment!.cardBalance).toBe($(50));
  });

  it("purchases on a positive card don't move money; unfunded spending is cash overspending", () => {
    const r = base().transfer("chk", "visa", "2026-01-01", 100).assign("2026-01", "groc", 30).spend("visa", "2026-01-05", "groc", 60).run("2026-01");
    expect(c(r, "2026-01", P).payment!.fundedSpending).toBe(0n);
    expect(c(r, "2026-01", "groc")).toMatchObject({ available: $(-30), cashOverspend: $(30), creditOverspend: 0n, cashSpending: $(-60), creditSpending: 0n });
  });

  it("a purchase crossing zero: only the part that creates debt can move", () => {
    const r = base().transfer("chk", "visa", "2026-01-01", 20).assign("2026-01", "groc", 50).spend("visa", "2026-01-05", "groc", 50).run("2026-01");
    expect(c(r, "2026-01", P).payment!.fundedSpending).toBe($(30));
    expect(c(r, "2026-01", "groc")).toMatchObject({ cashSpending: $(-20), creditSpending: $(-30), available: 0n });
  });

  it("cardPositiveBalanceToRta: none suppresses the debt-account inflow", () => {
    const r = base().transfer("chk", "visa", "2026-01-20", 150).run("2026-01", { cardPositiveBalanceToRta: "none" });
    expect(m(r, "2026-01").inflowFromDebtAccounts).toBe(0n);
  });

  it("transfers out of a positive card are cash-like (no P(K) effect)", () => {
    const r = base().transfer("chk", "visa", "2026-01-02", 100).transfer("visa", "chk", "2026-01-10", 100).run("2026-01");
    expect(c(r, "2026-01", P).payment!.payments).toBe($(-100));
  });
});

describe("§6.4 rule 7: split transactions on a card", () => {
  it("each line is funded separately", () => {
    const r = base()
      .assign("2026-01", "groc", 100)
      .tx({ acct: "visa", date: "2026-01-05", amt: 0, splits: [{ amt: -60, cat: "groc" }, { amt: -40, cat: "fun" }] })
      .run("2026-01");
    expect(c(r, "2026-01", P).activity).toBe($(60));
    expect(c(r, "2026-01", "fun")).toMatchObject({ available: $(-40), creditOverspend: $(40) });
    expect(c(r, "2026-01", "groc").available).toBe($(40));
  });

  it("a split with a refund line and a purchase line", () => {
    const r = base()
      .assign("2026-01", "groc", 100)
      .tx({ acct: "visa", date: "2026-01-05", amt: 0, splits: [{ amt: -100, cat: "groc" }, { amt: 15, cat: "fun" }] })
      .run("2026-01");
    expect(c(r, "2026-01", P).activity).toBe($(85));
    expect(c(r, "2026-01", "fun").available).toBe($(15));
  });

  it("a split line that is a payment transfer", () => {
    const r = base()
      .assign("2026-01", "groc", 100)
      .spend("visa", "2026-01-02", "groc", 100)
      .tx({ acct: "chk", date: "2026-01-20", amt: 0, splits: [{ amt: -100, xfer: "visa" }, { amt: -5, cat: "fun" }] })
      .tx({ acct: "visa", date: "2026-01-20", amt: 100, xfer: "chk" })
      .run("2026-01");
    expect(c(r, "2026-01", P).available).toBe(0n);
    expect(c(r, "2026-01", "fun").activity).toBe($(-5));
  });
});

describe("multi-month card scenario", () => {
  it("statement cycle: spend, pay, overspend, catch up", () => {
    const r = base()
      .assign("2026-01", "groc", 400)
      .spend("visa", "2026-01-05", "groc", 150)
      .spend("visa", "2026-01-20", "groc", 300) // 50 credit overspend
      .transfer("chk", "visa", "2026-02-10", 400) // pay what P(K) holds
      .assign("2026-02", P, 50) // cover last month's overspending
      .transfer("chk", "visa", "2026-02-15", 50)
      .run("2026-02");
    expect(c(r, "2026-01", P).available).toBe($(400));
    expect(c(r, "2026-01", "groc").creditOverspend).toBe($(50));
    expect(c(r, "2026-02", P)).toMatchObject({ carryIn: $(400), assigned: $(50), activity: $(-450), available: 0n, underfunded: 0n });
    expect(c(r, "2026-02", P).payment!.cardBalance).toBe(0n);
    expect(m(r, "2026-02").rta).toBe($(5000 - 400 - 50));
  });
});
