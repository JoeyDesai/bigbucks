import { describe, expect, it } from "vitest";
import { categorizeTransaction, categoryHealthInsights, InMemoryCategorizerRepo, recordCorrection, undoLearnedRule, type HealthTxn } from "../src";
import { ACCOUNTS, CATS } from "./fixtures";

const names = new Map(CATS.map((c) => [c.id, c.name]));
const categoryName = (id: string) => names.get(id);
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 22, 12, 0, tick++));

function setup() {
  const repo = new InMemoryCategorizerRepo({
    categories: CATS,
    accounts: ACCOUNTS,
    transactions: [InMemoryCategorizerRepo.txn({ id: "u1", accountId: "a-wfcard", date: "2026-10-18", amountMilli: -30_000n, rawDescription: "LOWE'S #1234", categoryId: "c-misc", approved: false })],
  });
  return repo;
}

describe("learning from corrections (§9.5)", () => {
  it("two consecutive corrections to the same category create a learned rule with a toast", async () => {
    const repo = setup();
    const first = await recordCorrection({ transactionId: "t1", payeeName: "Lowe's", fromCategoryId: "c-misc", toCategoryId: "c-house", userId: "alex" }, { repo, categoryName, now });
    expect(first.learnedRule).toBeNull();
    const second = await recordCorrection({ transactionId: "t2", payeeName: "Lowe's", fromCategoryId: "c-misc", toCategoryId: "c-house", userId: "sam" }, { repo, categoryName, now });
    expect(second.toast).toBe("Learned: Lowe's → House Projects");
    expect(second.learnedRule).toMatchObject({ source: "learned", enabled: true, actions: { setCategoryId: "c-house" }, conditions: [{ field: "payee", op: "equals", value: "Lowe's" }] });
    expect(second.reapplyCandidateIds).toEqual(["u1"]);
    expect(repo.events.map((e) => [e.method, e.accepted])).toEqual([
      ["user", false],
      ["user", false],
    ]);

    // The learned rule now categorizes Lowe's in the pipeline.
    const r = await categorizeTransaction({ id: "t3", accountId: "a-wfcard", date: "2026-10-21", amountMilli: -12_000n, rawDescription: "LOWE'S #1234 FAIRVIEW VA" }, { repo, now });
    expect(r).toMatchObject({ categoryId: "c-house", catz: { method: "rule", rule_id: second.learnedRule!.id } });

    // A third identical correction does not create a duplicate rule.
    const third = await recordCorrection({ transactionId: "t4", payeeName: "Lowe's", fromCategoryId: "c-misc", toCategoryId: "c-house", userId: "alex" }, { repo, categoryName, now });
    expect(third.learnedRule).toBeNull();

    await undoLearnedRule(repo, second.learnedRule!.id);
    expect(repo.rules[0]!.enabled).toBe(false);
  });

  it("corrections to different categories in between reset the streak", async () => {
    const repo = setup();
    await recordCorrection({ transactionId: "t1", payeeName: "Amazon", fromCategoryId: "c-misc", toCategoryId: "c-house", userId: "u" }, { repo, categoryName, now });
    await recordCorrection({ transactionId: "t2", payeeName: "Amazon", fromCategoryId: "c-misc", toCategoryId: "c-groc", userId: "u" }, { repo, categoryName, now });
    const r = await recordCorrection({ transactionId: "t3", payeeName: "Amazon", fromCategoryId: "c-misc", toCategoryId: "c-house", userId: "u" }, { repo, categoryName, now });
    expect(r.learnedRule).toBeNull();
  });

  it("an approval without change is recorded as accepted and does not count as a correction", async () => {
    const repo = setup();
    const r = await recordCorrection({ transactionId: "t1", payeeName: "Kroger", fromCategoryId: "c-groc", toCategoryId: "c-groc", userId: "u" }, { repo, categoryName, now });
    expect(r.learnedRule).toBeNull();
    expect(repo.events[0]!.accepted).toBe(true);
  });

  it("never overrides a user rule, and replaces a stale learned rule", async () => {
    const repo = setup();
    repo.rules.push({ id: "user-r", priority: 1, enabled: true, source: "user", conditions: [{ field: "payee", op: "equals", value: "Lowe's" }], actions: { setCategoryId: "c-misc" } });
    for (const id of ["a", "b"]) await recordCorrection({ transactionId: id, payeeName: "Lowe's", fromCategoryId: "c-misc", toCategoryId: "c-house", userId: "u" }, { repo, categoryName, now });
    expect(repo.rules).toHaveLength(1);

    const repo2 = setup();
    repo2.rules.push({ id: "old", priority: 100, enabled: true, source: "learned", conditions: [{ field: "payee", op: "equals", value: "Lowe's" }], actions: { setCategoryId: "c-misc" } });
    let last;
    for (const id of ["a", "b"]) last = await recordCorrection({ transactionId: id, payeeName: "Lowe's", fromCategoryId: "c-misc", toCategoryId: "c-house", userId: "u" }, { repo: repo2, categoryName, now });
    expect(last!.replacedRuleIds).toEqual(["old"]);
    expect(repo2.rules.find((r) => r.id === "old")!.enabled).toBe(false);
  });
});

describe("category health insight", () => {
  it("flags a category with more than 15 recognizable-merchant transactions in a month", () => {
    const txns: HealthTxn[] = [];
    const add = (payee: string, n: number, cat = "c-misc", month = "2026-09") => {
      for (let i = 0; i < n; i++) txns.push({ id: `${payee}${i}${month}`, date: `${month}-${String(i + 1).padStart(2, "0")}`, payeeKey: payee.toLowerCase(), payeeName: payee, categoryId: cat });
    };
    add("Amazon", 9);
    add("Lowes", 6);
    add("Target", 2);
    add("OneOff", 1);
    add("Kroger", 30, "c-groc", "2026-09");
    add("Amazon", 5, "c-misc", "2026-08");
    const out = categoryHealthInsights(txns, CATS, { categoryIds: ["c-misc"] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ month: "2026-09-01", categoryId: "c-misc", count: 18, recognizableCount: 17 });
    expect(out[0]!.message).toBe("🤷 Misc got 17 transactions in September 2026 from recognizable merchants (Amazon 9, Lowes 6, Target 2). Consider new categories or rules for them.");
    expect(categoryHealthInsights(txns, CATS).map((i) => i.categoryId)).toEqual(["c-groc", "c-misc"]);
  });
});
