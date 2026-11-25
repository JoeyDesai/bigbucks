import { describe, expect, it } from "vitest";
import { unwrapYnabPlan, ynabPlanToSnapshot } from "../src/ynab";

const minimal = () => ({
  id: "p",
  accounts: [
    { id: "a", name: "Checking", type: "checking", on_budget: true, closed: false },
    { id: "k", name: "Card", type: "creditCard", on_budget: true, closed: false },
    { id: "w", name: "Weird", type: "spaceship", on_budget: false, closed: false },
  ],
  category_groups: [
    { id: "gi", name: "Internal Master Category", hidden: false, internal: true },
    { id: "gc", name: "Credit Card Payments", hidden: false },
  ],
  categories: [
    { id: "r", category_group_id: "gi", name: "Inflow: Ready to Assign", hidden: false },
    { id: "pk", category_group_id: "gc", name: "Card", hidden: false },
    { id: "px", category_group_id: "gc", name: "Gone Card", hidden: false },
  ],
  months: [{ month: "2026-01-01", to_be_budgeted: "1000", categories: [{ id: "pk", budgeted: 5, activity: 0, balance: 5 }] }],
  transactions: [{ id: "t", date: "2026-01-02", amount: 1000, cleared: "weird", account_id: "a", category_id: "r" }],
  scheduled_transactions: [{ id: "s", date_next: "2026-02-01", frequency: "fortnightly", amount: -5, account_id: "a" }],
});

describe("ynabPlanToSnapshot edge cases", () => {
  it("unwraps data.plan, legacy data.budget, { plan } and a bare plan", () => {
    expect(unwrapYnabPlan({ data: { plan: minimal(), server_knowledge: 7 } }).serverKnowledge).toBe(7);
    expect(unwrapYnabPlan({ data: { budget: minimal() } }).plan.id).toBe("p");
    expect(unwrapYnabPlan({ plan: minimal() }).plan.id).toBe("p");
    expect(unwrapYnabPlan(minimal()).serverKnowledge).toBeNull();
    expect(() => unwrapYnabPlan(null)).toThrow(/not an object/);
    expect(() => unwrapYnabPlan({ data: {} })).toThrow(/no plan found/);
  });

  it("warns on unknown enums and unlinked payment categories; accepts string amounts", () => {
    const r = ynabPlanToSnapshot({ data: { budget: minimal() } });
    expect(r.snapshot.accounts.find((a) => a.id === "w")!.kind).toBe("other");
    expect(r.snapshot.categories.find((c) => c.id === "pk")).toMatchObject({ kind: "cc_payment", linkedAccountId: "k" });
    expect(r.snapshot.categories.find((c) => c.id === "px")!.kind).toBe("normal");
    expect(r.snapshot.transactions[0]!.cleared).toBe("cleared");
    expect(r.snapshot.scheduled[0]!.frequency).toBe("once");
    expect(r.expected[0]!.toBeBudgeted).toBe(1000n);
    expect(r.planName).toBeNull();
    expect(r.warnings.join("\n")).toMatch(/unknown account type spaceship/);
    expect(r.warnings.join("\n")).toMatch(/Gone Card/);
    expect(r.warnings.join("\n")).toMatch(/unknown cleared status weird/);
    expect(r.warnings.join("\n")).toMatch(/unknown frequency fortnightly/);
  });

  it("warns when there is no Ready to Assign category and when a payment category links to a non-liability", () => {
    const p = minimal();
    p.categories = p.categories.filter((c) => c.id !== "r");
    p.accounts.push({ id: "z", name: "Odd", type: "checking", on_budget: true, closed: false });
    p.categories.push({ id: "pz", category_group_id: "gc", name: "Odd", hidden: false });
    const r = ynabPlanToSnapshot(p);
    expect(r.warnings.join("\n")).toMatch(/no 'Inflow: Ready to Assign'/);
    expect(r.snapshot.categories.find((c) => c.id === "pz")!.kind).toBe("normal");
  });

  it("rejects malformed input with a path", () => {
    const p1 = minimal() as Record<string, unknown>;
    p1.transactions = [{ id: "t", date: "2026-01-02", amount: 1.5, cleared: "cleared", account_id: "a" }];
    expect(() => ynabPlanToSnapshot(p1)).toThrow(/plan\.transactions\[0\]\.amount: expected integer milliunits/);
    const p2 = minimal() as Record<string, unknown>;
    p2.months = "nope";
    expect(() => ynabPlanToSnapshot(p2)).toThrow(/plan\.months: not an array/);
    const p3 = minimal() as Record<string, unknown>;
    delete p3.months;
    expect(() => ynabPlanToSnapshot(p3)).toThrow(/plan\.months: missing array/);
    const p4 = minimal() as Record<string, unknown>;
    p4.category_groups = [42];
    expect(() => ynabPlanToSnapshot(p4)).toThrow(/category_groups\[0\]: not an object/);
    const p5 = minimal() as Record<string, unknown>;
    p5.accounts = [{ id: "a", type: "checking" }];
    expect(() => ynabPlanToSnapshot(p5)).toThrow(/accounts\[0\]\.name: expected string/);
  });

  it("skips deleted months and deleted goal categories; bigint amounts pass through", () => {
    const p = minimal() as ReturnType<typeof minimal> & Record<string, unknown>;
    (p.months as unknown[]).push({ month: "2026-02-01", deleted: true, to_be_budgeted: 0, categories: [] });
    p.categories.push({ id: "dg", category_group_id: "gc", name: "x", hidden: false, deleted: true, goal_type: "MF", goal_target: 5 } as never);
    p.transactions[0]!.amount = 7n as never;
    const r = ynabPlanToSnapshot(p);
    expect(r.expected).toHaveLength(1);
    expect(r.snapshot.targets).toEqual([]);
    expect(r.snapshot.transactions[0]!.amount).toBe(7n);
  });
});
