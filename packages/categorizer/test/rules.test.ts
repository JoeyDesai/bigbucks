import { describe, expect, it } from "vitest";
import { sumMilli } from "@homebase/shared";
import { applyRules, applySplitTemplate, conditionMatches, orderRules, parseRule, percentToBps, ruleToJson, testRuleAgainstHistory, type Rule, type RuleSubject, SplitTemplateSchema } from "../src";

const subj = (o: Partial<RuleSubject> = {}): RuleSubject => ({
  payeeName: "Lowe's",
  payeeKey: "lowes",
  rawDescription: "PURCHASE AUTHORIZED ON 10/14 LOWE'S #1234 FAIRVIEW VA",
  amountMilli: -48_170n,
  accountId: "a-card",
  date: "2026-10-14",
  ...o,
});

const rule = (o: Partial<Rule> & Pick<Rule, "conditions" | "actions">): Rule => ({ id: o.id ?? "r", priority: 10, enabled: true, source: "user", ...o });

describe("conditions", () => {
  it.each([
    [{ field: "payee", op: "equals", value: "LOWES" }, true],
    [{ field: "payee", op: "equals", value: "Lowe" }, false],
    [{ field: "payee", op: "contains", value: "owe" }, true],
    [{ field: "payee", op: "regex", value: "^low" }, true],
    [{ field: "payee", op: "regex", value: "([" }, false],
    [{ field: "raw_description", op: "contains", value: "fairview" }, true],
    [{ field: "raw_description", op: "equals", value: "purchase authorized on 10/14 lowe's #1234 fairview va" }, true],
    [{ field: "raw_description", op: "regex", value: "#\\d{4}" }, true],
    [{ field: "amount", op: "equals", valueMilli: 48_170n, sign: "any" }, true],
    [{ field: "amount", op: "equals", valueMilli: 48_170n, sign: "inflow" }, false],
    [{ field: "amount", op: "range", minMilli: 40_000n, maxMilli: 50_000n, sign: "outflow" }, true],
    [{ field: "amount", op: "range", minMilli: 50_000n, sign: "any" }, false],
    [{ field: "account", op: "in", accountIds: ["a-fab", "a-card"] }, true],
    [{ field: "account", op: "in", accountIds: ["a-fab"] }, false],
    [{ field: "day_of_month", op: "range", from: 10, to: 20 }, true],
    [{ field: "day_of_month", op: "range", from: 28, to: 3 }, false],
  ] as const)("condition #%# → %s", (c, expected) => {
    expect(conditionMatches(c as never, subj())).toBe(expected);
  });

  it("day-of-month ranges wrap around month end", () => {
    expect(conditionMatches({ field: "day_of_month", op: "range", from: 28, to: 3 }, subj({ date: "2026-10-02" }))).toBe(true);
    expect(conditionMatches({ field: "day_of_month", op: "range", from: 28, to: 3 }, subj({ date: "2026-10-30" }))).toBe(true);
  });
});

describe("rule ordering and application", () => {
  it("user rules run before learned rules; ai_suggested and disabled rules never run", () => {
    const rules = [
      rule({ id: "learned", source: "learned", priority: 1, conditions: [{ field: "payee", op: "equals", value: "Lowe's" }], actions: { setCategoryId: "c-misc" } }),
      rule({ id: "user", source: "user", priority: 50, conditions: [{ field: "payee", op: "contains", value: "lowe" }], actions: { setCategoryId: "c-house" } }),
      rule({ id: "sugg", source: "ai_suggested", priority: 0, conditions: [{ field: "payee", op: "contains", value: "lowe" }], actions: { setCategoryId: "c-groc" } }),
      rule({ id: "off", enabled: false, priority: 0, conditions: [{ field: "payee", op: "contains", value: "lowe" }], actions: { setCategoryId: "c-gas" } }),
    ];
    expect(orderRules(rules).map((r) => r.id)).toEqual(["user", "learned"]);
    const out = applyRules(rules, subj());
    expect(out).toMatchObject({ categoryId: "c-house", decidingRuleId: "user", decidingSource: "user", matchedRuleIds: ["user", "learned"] });
  });

  it("combines a rename rule with a later category rule; first setter of each field wins", () => {
    const rules = [
      rule({ id: "rename", priority: 1, conditions: [{ field: "raw_description", op: "contains", value: "LOWE" }], actions: { setPayee: { name: "Lowe's Home Improvement" }, setMemo: "hardware", autoApprove: true } }),
      rule({ id: "cat", priority: 2, conditions: [{ field: "amount", op: "range", maxMilli: 100_000n, sign: "outflow" }], actions: { setCategoryId: "c-house", setMemo: "ignored" } }),
    ];
    const out = applyRules(rules, subj());
    expect(out).toMatchObject({ payee: { name: "Lowe's Home Improvement" }, memo: "hardware", autoApprove: true, categoryId: "c-house", decidingRuleId: "cat" });
  });

  it("supports mark-as-transfer and split actions", () => {
    const t = applyRules([rule({ conditions: [{ field: "payee", op: "contains", value: "lowe" }], actions: { transferAccountId: "a-chk" } })], subj());
    expect(t.transferAccountId).toBe("a-chk");
    const split = SplitTemplateSchema.parse({ mode: "percent", lines: [{ categoryId: "c-house", percent: "60" }, { categoryId: "c-groc", percent: 40 }] });
    const s = applyRules([rule({ conditions: [{ field: "payee", op: "contains", value: "lowe" }], actions: { split } })], subj());
    expect(s.split).toEqual([
      { categoryId: "c-house", amountMilli: -28_900n },
      { categoryId: "c-groc", amountMilli: -19_270n },
    ]);
  });
});

describe("split templates (exact remainder handling)", () => {
  const pct = (lines: [string, string][]) => SplitTemplateSchema.parse({ mode: "percent", lines: lines.map(([categoryId, percent]) => ({ categoryId, percent })) });

  it("splits $100.00 three ways to the cent and sums exactly", () => {
    const lines = applySplitTemplate(-100_000n, pct([["a", "33.33"], ["b", "33.33"], ["c", "33.34"]]));
    if ("error" in lines) throw new Error(lines.error);
    expect(lines.map((l) => l.amountMilli)).toEqual([-33_330n, -33_330n, -33_340n]);
    expect(sumMilli(lines.map((l) => l.amountMilli))).toBe(-100_000n);
  });

  it("gives leftover cents to the largest remainders", () => {
    const lines = applySplitTemplate(-10_010n, pct([["a", "50"], ["b", "50"]])); // $10.01 → $5.01 + $5.00
    if ("error" in lines) throw new Error(lines.error);
    expect(lines.map((l) => l.amountMilli)).toEqual([-5_010n, -5_000n]);
  });

  it("works in milliunits when the amount is not whole cents", () => {
    const lines = applySplitTemplate(1_001n, pct([["a", "33.33"], ["b", "33.33"], ["c", "33.34"]]));
    if ("error" in lines) throw new Error(lines.error);
    expect(sumMilli(lines.map((l) => l.amountMilli))).toBe(1_001n);
  });

  it("fixed lines with a remainder line", () => {
    const t = SplitTemplateSchema.parse({ mode: "fixed", lines: [{ categoryId: "a", amountMilli: "15000" }, { categoryId: "b", remainder: true }, { categoryId: "c", amountMilli: 5000 }] });
    expect(applySplitTemplate(-48_170n, t)).toEqual([
      { categoryId: "a", amountMilli: -15_000n },
      { categoryId: "b", amountMilli: -28_170n },
      { categoryId: "c", amountMilli: -5_000n },
    ]);
    expect(applySplitTemplate(-10_000n, t)).toEqual({ error: "fixed split lines exceed the transaction amount" });
  });

  it("rejects percent templates that don't add to 100", () => {
    expect(SplitTemplateSchema.safeParse({ mode: "percent", lines: [{ categoryId: "a", percent: "50" }, { categoryId: "b", percent: "40" }] }).success).toBe(false);
    expect(percentToBps("33.33")).toBe(3333);
    expect(percentToBps(12.5)).toBe(1250);
  });
});

describe("parse / serialize / test against history", () => {
  it("parses stored JSON with string milliunits and round-trips", () => {
    const r = parseRule({
      id: "r1",
      priority: 1,
      enabled: true,
      source: "user",
      conditions: [{ field: "amount", op: "range", minMilli: "10000", maxMilli: "20000" }],
      actions: { setCategoryId: "c-house", split: { mode: "percent", lines: [{ categoryId: "a", percent: "50" }, { categoryId: "b", percent: "50" }] } },
    });
    expect(r.conditions[0]).toEqual({ field: "amount", op: "range", minMilli: 10_000n, maxMilli: 20_000n, sign: "any" });
    const j = ruleToJson(r);
    expect(j.conditions).toEqual([{ field: "amount", op: "range", minMilli: "10000", maxMilli: "20000", sign: "any" }]);
    expect(parseRule({ ...r, conditions: j.conditions, actions: j.actions })).toEqual(r);
    expect(() => parseRule({ ...r, conditions: [] })).toThrow();
  });

  it("counts history matches and would-change", () => {
    const hist = [
      { ...subj(), id: "1", categoryId: "c-misc" },
      { ...subj(), id: "2", categoryId: "c-house" },
      { ...subj({ payeeName: "Kroger", payeeKey: "kroger", rawDescription: "KROGER" }), id: "3", categoryId: "c-groc" },
    ];
    expect(testRuleAgainstHistory({ conditions: [{ field: "payee", op: "equals", value: "Lowe's" }], actions: { setCategoryId: "c-house" } }, hist)).toEqual({
      matchCount: 2,
      wouldChangeCount: 1,
      sampleIds: ["1", "2"],
    });
  });
});

describe("legacy (demo seed) rule JSON", () => {
  it("translates {all:[...]} conditions and typed action arrays", () => {
    const r = parseRule({
      id: "seed",
      priority: 10,
      enabled: true,
      source: "user",
      conditions: { all: [{ field: "raw_description", op: "contains", value: "KROGER" }, { field: "amount_milli", op: "lte", value: "-100000" }] },
      actions: [{ type: "set_category", category_id: "c-groc" }, { type: "approve" }, { type: "set_payee", payee_id: "p1" }],
    });
    expect(r.conditions).toEqual([
      { field: "raw_description", op: "contains", value: "KROGER" },
      { field: "amount", op: "range", minMilli: 100_000n, sign: "outflow" },
    ]);
    expect(r.actions).toEqual({ setCategoryId: "c-groc", autoApprove: true, setPayee: { payeeId: "p1" } });
  });

  it("rejects shapes it can't express exactly", () => {
    const base = { id: "x", priority: 1, enabled: true, source: "user" as const, actions: [{ type: "approve" }] };
    expect(() => parseRule({ ...base, conditions: { any: [] } })).toThrow(/any/);
    expect(() => parseRule({ ...base, conditions: { all: [{ field: "amount_milli", op: "lte", value: "500" }] } })).toThrow();
    expect(() => parseRule({ ...base, conditions: [{ field: "payee", op: "contains", value: "x" }], actions: [{ type: "explode" }] })).toThrow(/unsupported/);
  });
});
