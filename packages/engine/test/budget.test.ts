import { describe, expect, it } from "vitest";
import { computeBudget, resolveOptions, suggestedCardPayment, orderedBudgetCategories } from "../src/budget";
import { $, c, m, pay, RTA_ID, snap, UNCAT_ID } from "./helpers";

describe("§6.1 definitions: Available, carry, activity", () => {
  it("Available = carry + assigned + activity, and positive balances carry", () => {
    const r = snap().account("chk").cat("groc").income("chk", "2026-01-02", 1000).assign("2026-01", "groc", 300).spend("chk", "2026-01-10", "groc", 120).assign("2026-02", "groc", 50).spend("chk", "2026-02-03", "groc", 40).run("2026-02");
    expect(c(r, "2026-01", "groc")).toMatchObject({ carryIn: 0n, assigned: $(300), activity: $(-120), available: $(180) });
    expect(c(r, "2026-02", "groc")).toMatchObject({ carryIn: $(180), assigned: $(50), activity: $(-40), available: $(190) });
  });

  it("negative carry does not roll over", () => {
    const r = snap().account("chk").cat("groc").income("chk", "2026-01-01", 500).spend("chk", "2026-01-10", "groc", 80).run("2026-02");
    expect(c(r, "2026-01", "groc").available).toBe($(-80));
    expect(c(r, "2026-02", "groc")).toMatchObject({ carryIn: 0n, available: 0n });
  });

  it("splits contribute per line to each category", () => {
    const r = snap().account("chk").cat("a").cat("b").income("chk", "2026-01-01", 500).tx({ acct: "chk", date: "2026-01-05", amt: 0, splits: [{ amt: -30, cat: "a" }, { amt: -20, cat: "b" }] }).run("2026-01");
    expect(c(r, "2026-01", "a").activity).toBe($(-30));
    expect(c(r, "2026-01", "b").activity).toBe($(-20));
    expect(m(r, "2026-01").activity).toBe($(-50));
  });

  it("transfers between on-budget accounts are excluded from activity", () => {
    const r = snap().account("chk").account("sav", "savings").cat("a").income("chk", "2026-01-01", 500).transfer("chk", "sav", "2026-01-03", 200).run("2026-01");
    expect(m(r, "2026-01").activity).toBe(0n);
    expect(c(r, "2026-01", "a").activity).toBe(0n);
    expect(m(r, "2026-01").rta).toBe($(500));
  });

  it("categorized transfers to tracking accounts count as activity", () => {
    const r = snap().account("chk").account("brok", "brokerage", false).cat("invest").income("chk", "2026-01-01", 1000).assign("2026-01", "invest", 400).transfer("chk", "brok", "2026-01-15", 400, "invest").run("2026-01");
    expect(c(r, "2026-01", "invest")).toMatchObject({ activity: $(-400), available: 0n });
  });

  it("uncategorized transfer to a tracking account lands in Uncategorized", () => {
    const r = snap().account("chk").account("brok", "brokerage", false).income("chk", "2026-01-01", 1000).transfer("chk", "brok", "2026-01-15", 100).run("2026-01");
    expect(c(r, "2026-01", UNCAT_ID).activity).toBe($(-100));
  });

  it("transactions on tracking accounts are ignored", () => {
    const r = snap().account("chk").account("brok", "brokerage", false).cat("a").tx({ acct: "brok", date: "2026-01-02", amt: -500, cat: "a" }).income("chk", "2026-01-01", 10).run("2026-01");
    expect(c(r, "2026-01", "a").activity).toBe(0n);
  });

  it("pending transactions are excluded; deleted transactions are excluded", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-01-01", 100).tx({ acct: "chk", date: "2026-01-02", amt: -40, cat: "a", cleared: "pending" }).tx({ acct: "chk", date: "2026-01-02", amt: -10, cat: "a", deleted: true }).tx({ acct: "chk", date: "2026-01-02", amt: -5, cat: "a", cleared: "uncleared" }).run("2026-01");
    expect(c(r, "2026-01", "a").activity).toBe($(-5));
  });

  it("uncategorized non-transfer transactions overspend like a normal category (cash → RTA)", () => {
    const r = snap().account("chk").income("chk", "2026-01-01", 1000).spend("chk", "2026-01-05", null, 426.5).run("2026-02");
    expect(c(r, "2026-01", UNCAT_ID)).toMatchObject({ available: $(-426.5), cashOverspend: $(426.5), status: "overspent_cash" });
    expect(m(r, "2026-02").cashOverspendingLastMonth).toBe($(426.5));
    expect(m(r, "2026-02").rta).toBe($(1000 - 426.5));
  });

  it("a transaction to an unknown category is uncategorized, with a warning", () => {
    const r = snap().account("chk").income("chk", "2026-01-01", 10).spend("chk", "2026-01-02", "nope", 3).run("2026-01");
    expect(c(r, "2026-01", UNCAT_ID).activity).toBe($(-3));
    expect(r.warnings.join()).toContain("unknown category nope");
  });

  it("creates a virtual uncategorized category if the snapshot has none", () => {
    const s = snap().account("chk").income("chk", "2026-01-01", 10).spend("chk", "2026-01-02", null, 3).build();
    s.categories = s.categories.filter((x) => x.kind !== "uncategorized");
    const r = computeBudget(s, { through: "2026-01-01" });
    expect(r.months["2026-01-01"]!.categories["__uncategorized__"]!.activity).toBe($(-3));
  });

  it("starting balance on a cash account goes to RTA (even when uncategorized)", () => {
    const r = snap().account("chk").account("sav", "savings").tx({ acct: "chk", date: "2026-01-01", amt: 2000, cat: RTA_ID, sb: true }).tx({ acct: "sav", date: "2026-01-01", amt: 500, cat: null, sb: true }).run("2026-01");
    expect(m(r, "2026-01")).toMatchObject({ income: $(2500), rta: $(2500) });
  });

  it("warns about unknown accounts and assignments to unknown categories", () => {
    const s = snap().account("chk").income("chk", "2026-01-01", 10).assign("2026-01", "ghost", 5).build();
    s.transactions.push({ id: "x", accountId: "nope", date: "2026-01-01", amount: 1n, categoryId: null, transferAccountId: null, cleared: "cleared" });
    const r = computeBudget(s, { through: "2026-01-01" });
    expect(r.warnings.some((w) => w.includes("unknown account nope"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("unknown category ghost"))).toBe(true);
  });

  it("warns when split lines don't add up to the parent amount", () => {
    const s = snap().account("chk").cat("a").income("chk", "2026-01-01", 10).tx({ acct: "chk", date: "2026-01-02", amt: 0, splits: [{ amt: -3, cat: "a" }] }).build();
    s.transactions[1]!.amount = $(-4);
    const r = computeBudget(s, { through: "2026-01-01" });
    expect(r.warnings.join()).toContain("split transaction");
  });

  it("assignments to Ready to Assign itself are ignored", () => {
    const r = snap().account("chk").income("chk", "2026-01-01", 100).assign("2026-01", RTA_ID, 40).run("2026-01");
    expect(m(r, "2026-01").rta).toBe($(100));
  });
});

describe("§6.2 Ready to Assign", () => {
  it("RTA(M) = carry + income − last month's cash overspend − assigned", () => {
    const r = snap().account("chk").cat("a").cat("b").income("chk", "2026-01-01", 1000).assign("2026-01", "a", 600).spend("chk", "2026-01-10", "b", 50).income("chk", "2026-02-01", 200).assign("2026-02", "a", 100).run("2026-02");
    expect(m(r, "2026-01")).toMatchObject({ rta: $(400), income: $(1000), assigned: $(600), leftOverFromLastMonth: 0n, cashOverspending: $(50) });
    expect(m(r, "2026-02")).toMatchObject({ leftOverFromLastMonth: $(400), cashOverspendingLastMonth: $(50), rta: $(400 + 200 - 50 - 100) });
  });

  it("negative RTA carries into the next month by default (ADR-E3)", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-01-01", 100).assign("2026-01", "a", 150).run("2026-02");
    expect(m(r, "2026-01").rta).toBe($(-50));
    expect(m(r, "2026-02").rta).toBe($(-50));
  });

  it("negativeRtaCarries: false resets negative RTA at rollover", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-01-01", 100).assign("2026-01", "a", 150).run("2026-02", { negativeRtaCarries: false });
    expect(m(r, "2026-02").rta).toBe(0n);
  });

  it("outflows categorized to RTA reduce it", () => {
    const r = snap().account("chk").income("chk", "2026-01-01", 100).tx({ acct: "chk", date: "2026-01-02", amt: -30, cat: RTA_ID }).run("2026-01");
    expect(m(r, "2026-01").rta).toBe($(70));
  });

  it("card lines categorized to RTA only change the card's debt (ADR-E12, verified)", () => {
    const b = snap().account("chk").card("visa").income("chk", "2026-01-01", 100).spend("visa", "2026-01-02", null, 80).tx({ acct: "visa", date: "2026-01-05", amt: 25, cat: RTA_ID }).tx({ acct: "visa", date: "2026-01-06", amt: -10, cat: RTA_ID });
    const r = b.run("2026-01");
    expect(m(r, "2026-01")).toMatchObject({ income: $(100), rta: $(100), inflowFromDebtAccounts: 0n });
    expect(c(r, "2026-01", pay("visa")).activity).toBe(0n);
    expect(c(r, "2026-01", pay("visa")).payment!.debt).toBe($(65));
    // cardRtaLines: income restores the old behavior
    expect(m(b.run("2026-01", { cardRtaLines: "income" }), "2026-01").income).toBe($(115));
  });

  it("an RTA-categorized card inflow that pushes the card above zero reaches RTA as Inflow from Debt Account", () => {
    const r = snap().account("chk").card("visa").spend("visa", "2026-01-02", null, 10).tx({ acct: "visa", date: "2026-01-05", amt: 25, cat: RTA_ID }).run("2026-01");
    expect(m(r, "2026-01")).toMatchObject({ income: 0n, inflowFromDebtAccounts: $(15), rta: $(15) });
  });

  it("assign ahead: future assignments are subtracted from the current month's display", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-10-01", 2000).assign("2026-10", "a", 1000).assign("2026-11", "a", 800).run("2026-10");
    const oct = m(r, "2026-10");
    expect(oct.rta).toBe($(1000));
    expect(oct.readyToAssignDisplay).toBe($(200));
    expect(oct.assignedInFuture).toBe($(800));
    expect(r.monthList).toEqual(["2026-10-01"]); // future months computed internally but trimmed
  });

  it("future-month over-assignment shows the current month as 0, the future month negative", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-10-01", 1000).assign("2026-10", "a", 1000).assign("2026-11", "a", 500).run("2026-11");
    expect(m(r, "2026-10")).toMatchObject({ rta: 0n, readyToAssignDisplay: 0n, assignedInFuture: 0n });
    expect(m(r, "2026-11")).toMatchObject({ rta: $(-500), readyToAssignDisplay: $(-500) });
  });

  it("future income does not raise an earlier month's display", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-10-01", 1000).assign("2026-10", "a", 400).income("chk", "2026-11-01", 500).run("2026-11");
    expect(m(r, "2026-10").readyToAssignDisplay).toBe($(600));
    expect(m(r, "2026-11").readyToAssignDisplay).toBe($(1100));
  });

  it("past leftover that was assigned later shows as assigned-in-future", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-09-01", 300).assign("2026-10", "a", 300).run("2026-10");
    expect(m(r, "2026-09")).toMatchObject({ rta: $(300), readyToAssignDisplay: 0n, assignedInFuture: $(300) });
  });

  it("rtaDisplay: raw disables the future adjustment", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-10-01", 2000).assign("2026-11", "a", 800).run("2026-10", { rtaDisplay: "raw" });
    expect(m(r, "2026-10")).toMatchObject({ readyToAssignDisplay: $(2000), assignedInFuture: 0n });
  });

  it("a negative current month is shown as-is even with future assignments", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-10-01", 100).assign("2026-10", "a", 200).assign("2026-11", "a", 50).run("2026-10");
    expect(m(r, "2026-10").readyToAssignDisplay).toBe($(-100));
  });

  it("from trims output and adds empty leading months", () => {
    const r = snap().account("chk").income("chk", "2026-03-01", 10).run("2026-04", { from: "2026-02-01" });
    expect(r.monthList).toEqual(["2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(m(r, "2026-04").rta).toBe($(10));
    const r2 = snap().account("chk").income("chk", "2026-01-01", 10).run("2026-04", { from: "2026-03-01" });
    expect(r2.monthList).toEqual(["2026-03-01", "2026-04-01"]);
    expect(m(r2, "2026-03").rta).toBe($(10));
  });

  it("an empty snapshot yields the through month only", () => {
    const r = snap().run("2026-05");
    expect(r.monthList).toEqual(["2026-05-01"]);
    expect(m(r, "2026-05").rta).toBe(0n);
  });

  it("resolveOptions applies defaults and ignores undefined", () => {
    const o = resolveOptions({ through: "2026-01-01", overspendAttribution: undefined, negativeRtaCarries: false });
    expect(o.overspendAttribution).toBe("cash_first");
    expect(o.cardRtaLines).toBe("debt_only");
    expect(o.negativeRtaCarries).toBe(false);
  });
});

describe("§6.3 overspending", () => {
  it("cash overspending is subtracted from next month's RTA and shown red", () => {
    const r = snap().account("chk").cat("a").income("chk", "2026-01-01", 500).assign("2026-01", "a", 50).spend("chk", "2026-01-05", "a", 80).run("2026-02");
    expect(c(r, "2026-01", "a")).toMatchObject({ available: $(-30), cashOverspend: $(30), creditOverspend: 0n, status: "overspent_cash", cashSpending: $(-80), creditSpending: 0n });
    expect(c(r, "2026-01", "a").statusLabel).toBe("Overspent $30.00");
    expect(m(r, "2026-02").rta).toBe($(500 - 50 - 30));
  });

  it("credit overspending is not subtracted from RTA; it stays as card debt (yellow)", () => {
    const r = snap().account("chk").card("visa").cat("a").income("chk", "2026-01-01", 500).assign("2026-01", "a", 50).spend("visa", "2026-01-05", "a", 80).run("2026-02");
    expect(c(r, "2026-01", "a")).toMatchObject({ available: $(-30), cashOverspend: 0n, creditOverspend: $(30), status: "overspent_credit", creditSpending: $(-80) });
    expect(c(r, "2026-01", "a").statusLabel).toBe("Overspent $30.00 on credit");
    expect(m(r, "2026-02").rta).toBe($(450));
    expect(c(r, "2026-01", pay("visa")).available).toBe($(50));
  });

  it("mixed overspending: cash takes the funds first, regardless of date (ADR-E1, verified)", () => {
    // funds 100; card 50 on the 2nd, cash 80 on the 3rd → cash uses 80 first, card gets 20 → −30 credit
    const r1 = snap().account("chk").card("visa").cat("a").income("chk", "2026-01-01", 500).assign("2026-01", "a", 100).spend("visa", "2026-01-02", "a", 50).spend("chk", "2026-01-03", "a", 80).run("2026-02");
    expect(c(r1, "2026-01", "a")).toMatchObject({ available: $(-30), cashOverspend: 0n, creditOverspend: $(30), status: "overspent_credit" });
    expect(c(r1, "2026-01", pay("visa")).activity).toBe($(20));
    expect(m(r1, "2026-02").cashOverspendingLastMonth).toBe(0n);
    // reversed dates: same result
    const r2 = snap().account("chk").card("visa").cat("a").income("chk", "2026-01-01", 500).assign("2026-01", "a", 100).spend("chk", "2026-01-02", "a", 80).spend("visa", "2026-01-03", "a", 50).run("2026-01");
    expect(c(r2, "2026-01", "a")).toMatchObject({ cashOverspend: 0n, creditOverspend: $(30) });
    expect(c(r2, "2026-01", pay("visa")).activity).toBe($(20));
    // both kinds negative: funds 50, cash 80 (−30 cash), card 50 (all unfunded) → red with both parts
    const r3 = snap().account("chk").card("visa").cat("a").income("chk", "2026-01-01", 500).assign("2026-01", "a", 50).spend("chk", "2026-01-02", "a", 80).spend("visa", "2026-01-03", "a", 50).run("2026-02");
    expect(c(r3, "2026-01", "a")).toMatchObject({ available: $(-80), cashOverspend: $(30), creditOverspend: $(50), status: "overspent_cash" });
    expect(c(r3, "2026-01", "a").statusLabel).toContain("$30.00 cash");
    expect(m(r3, "2026-02").cashOverspendingLastMonth).toBe($(30));
  });

  it("overspendAttribution: chronological funds in date order (card first → cash overspending)", () => {
    const b = snap().account("chk").card("visa").cat("a").income("chk", "2026-01-01", 500).assign("2026-01", "a", 100).spend("visa", "2026-01-02", "a", 50).spend("chk", "2026-01-03", "a", 80);
    const r = b.run("2026-01", { overspendAttribution: "chronological" });
    expect(c(r, "2026-01", pay("visa")).activity).toBe($(50));
    expect(c(r, "2026-01", "a")).toMatchObject({ creditOverspend: 0n, cashOverspend: $(30), status: "overspent_cash" });
  });

  it("chronological: a refund after the card purchase doesn't fund it retroactively", () => {
    const r = snap().account("chk").card("visa").cat("a").income("chk", "2026-01-01", 500).spend("visa", "2026-01-02", "a", 50).tx({ acct: "chk", date: "2026-01-04", amt: 50, cat: "a" }).run("2026-01", { overspendAttribution: "chronological" });
    expect(c(r, "2026-01", pay("visa")).activity).toBe(0n);
    expect(c(r, "2026-01", "a").available).toBe(0n);
  });

  it("a later refund reduces overspending; credit part is capped by the negative", () => {
    const r = snap().account("chk").card("visa").cat("a").income("chk", "2026-01-01", 500).spend("visa", "2026-01-02", "a", 50).tx({ acct: "chk", date: "2026-01-04", amt: 40, cat: "a" }).run("2026-01");
    expect(c(r, "2026-01", "a")).toMatchObject({ available: $(-10), creditOverspend: $(10), cashOverspend: 0n });
  });

  it("inflows to a category fund later card spending in the same month", () => {
    const r = snap().account("chk").card("visa").cat("a").income("chk", "2026-01-01", 500).tx({ acct: "chk", date: "2026-01-02", amt: 40, cat: "a" }).spend("visa", "2026-01-03", "a", 40).run("2026-01");
    expect(c(r, "2026-01", pay("visa")).activity).toBe($(40));
  });
});

describe("helpers", () => {
  it("suggestedCardPayment = min(P(K) available, owed)", () => {
    expect(suggestedCardPayment($(300), $(-500))).toBe($(300));
    expect(suggestedCardPayment($(800), $(-500))).toBe($(500));
    expect(suggestedCardPayment($(-5), $(-500))).toBe(0n);
    expect(suggestedCardPayment($(100), $(20))).toBe(0n);
  });

  it("orderedBudgetCategories follows group sort then category sort and excludes RTA", () => {
    const s = snap().card("visa").group("g-top", -5).cat("z", { groupId: "g-top", sort: 2 }).cat("y", { groupId: "g-top", sort: 1 }).build();
    const ids = orderedBudgetCategories(s).map((x) => x.id);
    expect(ids.slice(0, 2)).toEqual(["y", "z"]);
    expect(ids).not.toContain(RTA_ID);
  });

  it("status zero / fully spent / funded", () => {
    const r = snap().account("chk").cat("a").cat("b").cat("z").income("chk", "2026-01-01", 500).assign("2026-01", "a", 40).spend("chk", "2026-01-02", "a", 40).assign("2026-01", "b", 10).run("2026-01");
    expect(c(r, "2026-01", "a")).toMatchObject({ status: "zero", statusLabel: "Fully spent" });
    expect(c(r, "2026-01", "b")).toMatchObject({ status: "funded", statusLabel: "Funded" });
    expect(c(r, "2026-01", "z")).toMatchObject({ status: "zero", statusLabel: "Zero" });
  });
});
