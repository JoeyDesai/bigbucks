import { describe, expect, it } from "vitest";
import { parseRule, ruleToJson, testRuleAgainstHistory } from "@homebase/categorizer";
import { aiRuleToCanonical, describeRule } from "./rules";

const CAT = "0192f3a0-0000-7000-8000-0000000000c1";
const ACCT = "0192f3a0-0000-7000-8000-0000000000a1";

describe("aiRuleToCanonical", () => {
  it("maps the agent's simple input onto categorizer conditions and actions", () => {
    const r = aiRuleToCanonical({ payee_contains: "Lowe's", min_abs_amount: "10", max_abs_amount: "500.50", account_ids: [ACCT], category_id: CAT, set_payee_name: "Lowe's", auto_approve: true, apply_to_existing: true });
    expect(r.conditions).toEqual([
      { field: "payee", op: "contains", value: "Lowe's" },
      { field: "amount", op: "range", sign: "any", minMilli: 10_000n, maxMilli: 500_500n },
      { field: "account", op: "in", accountIds: [ACCT] },
    ]);
    expect(r.actions).toEqual({ setCategoryId: CAT, setPayee: { name: "Lowe's" }, autoApprove: true });
  });

  it("round-trips through the stored JSON format", () => {
    const r = aiRuleToCanonical({ payee_equals: "Netflix", description_contains: "NETFLIX.COM", category_id: CAT, apply_to_existing: false });
    const json = ruleToJson(r);
    expect(json.conditions).toEqual([
      { field: "payee", op: "equals", value: "Netflix" },
      { field: "raw_description", op: "contains", value: "NETFLIX.COM" },
    ]);
    const back = parseRule({ id: "x", priority: 100, enabled: true, source: "user", ...json });
    expect(back.conditions).toEqual(r.conditions);
    expect(back.actions).toEqual(r.actions);
  });

  it("matches history like the categorizer does (absolute amounts, payee contains)", () => {
    const r = aiRuleToCanonical({ payee_contains: "lowe", max_abs_amount: "100", category_id: CAT, apply_to_existing: true });
    const h = (id: string, payee: string, amount: bigint) => ({ id, payeeName: payee, payeeKey: null, rawDescription: payee, amountMilli: amount, accountId: ACCT, date: "2026-10-01", categoryId: null });
    const t = testRuleAgainstHistory(r, [h("1", "Lowe's #123", -45_000n), h("2", "Lowe's", -145_000n), h("3", "Home Depot", -10_000n)]);
    expect(t.matchCount).toBe(1);
    expect(t.sampleIds).toEqual(["1"]);
  });

  it("rejects an input without conditions", () => {
    expect(() => aiRuleToCanonical({ category_id: CAT, apply_to_existing: false })).toThrow();
  });
});

describe("describeRule", () => {
  it("writes a readable when/then", () => {
    const d = describeRule(aiRuleToCanonical({ payee_contains: "Lowe's", min_abs_amount: "20", category_id: CAT, auto_approve: true, apply_to_existing: false }), { category: () => "House Projects" });
    expect(d.when).toBe("payee contains “Lowe's” and amount ≥ $20.00");
    expect(d.then).toBe("category House Projects, auto-approve");
  });
});
