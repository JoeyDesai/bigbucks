import { describe, expect, it } from "vitest";
import { parseMilli } from "@homebase/shared";
import { availablePill, availableState, signedTone, targetProgress } from "./budget-display";
import type { CategoryVM, TargetVM } from "./view-models";

const $ = parseMilli;
const target = (o: Partial<TargetVM> = {}): TargetVM => ({ type: "need_set_aside", description: "", amount: $("100"), needed: $("100"), underfunded: 0n, ...o });
const cat = (o: Partial<CategoryVM>): CategoryVM => ({ id: "c", groupId: "g", name: "X", kind: "normal", assigned: $("100"), activity: 0n, available: $("100"), target: target(), ...o });

describe("availableState", () => {
  it("green when positive, gray at zero", () => {
    expect(availableState(cat({}))).toBe("funded");
    expect(availableState(cat({ available: 0n }))).toBe("zero");
  });
  it("yellow for credit overspending, red for cash or mixed", () => {
    expect(availableState(cat({ available: $("-10"), creditOverspend: $("10"), cashOverspend: 0n }))).toBe("credit_overspent");
    expect(availableState(cat({ available: $("-10"), cashOverspend: $("10") }))).toBe("cash_overspent");
    expect(availableState(cat({ available: $("-10"), cashOverspend: $("4"), creditOverspend: $("6") }))).toBe("cash_overspent");
    expect(availableState(cat({ available: $("-10") }))).toBe("cash_overspent");
  });
  it("yellow when underfunded with an upcoming transaction", () => {
    expect(availableState(cat({ available: $("2"), upcoming: $("8"), target: target({ underfunded: $("6") }) }))).toBe("upcoming");
  });
});

describe("targetProgress labels", () => {
  it("Funded / Spent / Fully Spent / Overspent / more needed / Snoozed (YNAB wording)", () => {
    expect(targetProgress(cat({}))?.label).toBe("Funded");
    expect(targetProgress(cat({ activity: $("-40"), available: $("60") }))?.label).toBe("Funded. Spent $40.00 of $100.00");
    expect(targetProgress(cat({ activity: $("-100"), available: 0n }))?.label).toBe("Fully Spent");
    expect(targetProgress(cat({ activity: $("-130"), available: $("-30") }))?.label).toBe("Overspent. $130.00 of $100.00");
    expect(targetProgress(cat({ assigned: $("20"), available: $("20"), target: target({ underfunded: $("80"), dueLabel: "Oct 31" }) }))?.label).toBe("$80.00 more needed by Oct 31");
    expect(targetProgress(cat({ assigned: $("20"), available: $("20"), target: target({ underfunded: $("80") }) }))?.label).toBe("$80.00 more needed this month");
    expect(targetProgress(cat({ target: target({ snoozed: true }) }))?.label).toBe("Snoozed");
    expect(targetProgress(cat({ target: null }))).toBeNull();
  });
  it("available pill: check when the target is met, card icon for credit overspending", () => {
    expect(availablePill(cat({}))).toEqual({ tone: "pos", icon: "check" });
    expect(availablePill(cat({ target: null }))).toEqual({ tone: "pos", icon: null });
    expect(availablePill(cat({ available: 0n }))).toEqual({ tone: "zero", icon: null });
    expect(availablePill(cat({ available: $("-10"), creditOverspend: $("10"), cashOverspend: 0n }))).toEqual({ tone: "warn", icon: "card" });
    expect(availablePill(cat({ available: $("-10"), cashOverspend: $("10") }))).toEqual({ tone: "neg", icon: null });
  });
  it("signed tone", () => {
    expect(signedTone(1n)).toBe("pos");
    expect(signedTone(-1n)).toBe("neg");
    expect(signedTone(0n)).toBe("zero");
  });
});
