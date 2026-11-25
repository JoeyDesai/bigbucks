import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema as s } from "@homebase/db";
import { AiClient, InMemoryUsageSink } from "@homebase/ai";
import { FakeAnthropic, jsonReply, type FakeResponder } from "@homebase/ai/testing";
import { newId } from "@homebase/shared";
import { createCategorizeJob, DbCategorizerRepo } from "../../src/db";
import { recordCorrection } from "../../src";
import { prepareTestDb } from "./testDb";

const t = await prepareTestDb("categorizer");
const now = () => new Date("2026-10-22T15:00:00Z");

describe.skipIf(!t)("DbCategorizerRepo + categorize job (Postgres)", { timeout: 60_000 }, () => {
  const db = t!.db;
  const repo = new DbCategorizerRepo(db);
  afterAll(async () => t?.close());

  async function account(name: string) {
    const [a] = await db.select().from(s.accounts).where(eq(s.accounts.name, name));
    return a!;
  }
  async function category(name: string) {
    const [c] = await db.select().from(s.categories).where(eq(s.categories.name, name));
    return c!;
  }
  async function insertTxn(o: { accountId: string; date: string; amountMilli: bigint; raw: string; categoryId?: string | null; cleared?: "pending" | "cleared" }) {
    const id = newId();
    await db.insert(s.transactions).values({
      id,
      accountId: o.accountId,
      date: o.date,
      amountMilli: o.amountMilli,
      rawDescription: o.raw,
      categoryId: o.categoryId ?? null,
      cleared: o.cleared ?? "cleared",
      source: "simplefin",
      externalId: `test-${id}`,
    });
    return id;
  }
  async function txn(id: string) {
    const [r] = await db.select().from(s.transactions).where(eq(s.transactions.id, id));
    return r!;
  }

  it("reads the seeded catalog, accounts, memory and aliases", async () => {
    const cats = await repo.getCategoryCatalog();
    expect(cats.find((c) => c.kind === "internal_rta")).toBeTruthy();
    const misc = cats.find((c) => c.name.includes("Misc"))!;
    expect(misc.alwaysReview).toBe(true);
    const groceries = cats.find((c) => c.examplePayees?.includes("Kroger"));
    expect(groceries).toBeTruthy();
    const accts = await repo.getAccounts();
    expect(accts.find((a) => a.name === "Mercury Checking")?.isBusiness).toBe(true);
    expect(accts.find((a) => a.name === "Checking")?.isBusiness).toBe(false);
    expect((await repo.getHouseholdMemory()).length).toBeGreaterThan(3);
    expect((await repo.getAliases()).length).toBeGreaterThan(10);
  });

  it("parses the seed's provisional rule JSON (no warnings)", async () => {
    const rules = await repo.getRules();
    expect(repo.ruleWarnings).toEqual([]);
    expect(rules.length).toBeGreaterThanOrEqual(6);
    const kroger = rules.find((r) => r.name === "Kroger → Groceries")!;
    expect(kroger.conditions).toEqual([{ field: "raw_description", op: "contains", value: "KROGER" }]);
    expect(kroger.actions.autoApprove).toBe(true);
    const lowes = rules.find((r) => r.source === "ai_suggested")!;
    expect(lowes.conditions[1]).toEqual({ field: "amount", op: "range", minMilli: 100_000n, sign: "outflow" });
  });

  it("matches payee keys across key styles and reads history, similar transactions and prior reviews", async () => {
    const lowes = await repo.getPayeeByKey("lowes");
    expect(lowes?.name).toBe("Lowe's");
    const hist = await repo.getPayeeHistory("kroger", { before: "2026-10-22" });
    expect(hist.length).toBeGreaterThan(10);
    expect(hist.every((h) => h.date < "2026-10-22")).toBe(true);
    const sim = await repo.similarTransactions({ transactionId: newId(), payeeKey: "kroger", payeeName: "Kroger", rawDescription: "KROGER #0412 FAIRVIEW VA", amountMilli: -85_000n, before: "2026-10-22", limit: 15 });
    expect(sim.length).toBe(15);
    expect(sim[0]!.payee).toBe("Kroger");
    expect(sim[0]!.categoryName).toBeTruthy();
    const payroll = await repo.countPriorReviewed("northwindstudio", { incomeOverMilli: 500_000n, rtaCategoryId: (await category("Inflow: Ready to Assign")).id, before: "2026-10-22" });
    expect(payroll).toBeGreaterThan(3);
  });

  it("round-trips events, rules and merchant profiles", async () => {
    const id = await insertTxn({ accountId: (await account("Cash Back Card")).id, date: "2026-10-20", amountMilli: -12_000n, raw: "LOWE'S #0487 FAIRVIEW VA" });
    await db.update(s.transactions).set({ payeeId: (await repo.getPayeeByKey("lowes"))!.id }).where(eq(s.transactions.id, id));
    await repo.saveEvent({ transactionId: id, payeeKey: "lowes", suggestedCategoryId: null, finalCategoryId: null, method: "ai", confidence: 0.5, model: "claude-haiku-5-5", inputTokens: 1, outputTokens: 2, costMicroUsd: 1234n, accepted: null, at: now().toISOString() });
    const [ev] = await repo.recentEventsForPayee("lowes", 1);
    expect(ev).toMatchObject({ transactionId: id, costMicroUsd: 1234n, accepted: null, method: "ai" });

    const r = await repo.createRule({ name: "test", priority: 5, enabled: true, source: "user", conditions: [{ field: "amount", op: "range", minMilli: 1_000n, sign: "outflow" }], actions: { setMemo: "x" } });
    await repo.recordRuleHit(r.id, now().toISOString());
    await repo.setRuleEnabled(r.id, false);
    const back = (await repo.getRules()).find((x) => x.id === r.id)!;
    expect(back).toMatchObject({ enabled: false, hitCount: 1, conditions: r.conditions });
    await db.delete(s.rules).where(eq(s.rules.id, r.id));

    await repo.upsertMerchantProfile("kesslersminimart", "Kessler's Mini Mart", { website: null, type: "deli", location: "Fairview, VA", description: "x", confidence: 0.8, looked_up_at: now().toISOString(), found: true });
    expect((await repo.getPayeeByKey("kesslersminimart"))?.merchant?.type).toBe("deli");
  });

  it("learning: two corrections create a learned rule stored in the canonical shape", async () => {
    const cashBack = (await account("Cash Back Card")).id;
    const house = await category("House Projects");
    const misc = (await repo.getCategoryCatalog()).find((c) => c.name.includes("Misc"))!;
    const payee = (await repo.getPayeeByKey("lowes"))!;
    const ids = [] as string[];
    for (const d of ["2026-10-10", "2026-10-11"]) {
      const id = await insertTxn({ accountId: cashBack, date: d, amountMilli: -20_000n, raw: "LOWE'S #0487 FAIRVIEW VA", categoryId: misc.id });
      await db.update(s.transactions).set({ payeeId: payee.id }).where(eq(s.transactions.id, id));
      ids.push(id);
    }
    let last;
    for (const id of ids) {
      last = await recordCorrection({ transactionId: id, payeeName: "Lowe's", payeeKey: "lowes", fromCategoryId: misc.id, toCategoryId: house.id, userId: (await db.select().from(s.users))[0]!.id }, { repo, categoryName: () => "House Projects", now });
    }
    expect(last!.toast).toBe("Learned: Lowe's → House Projects");
    const [row] = await db.select().from(s.rules).where(eq(s.rules.id, last!.learnedRule!.id));
    expect(row).toMatchObject({ source: "learned", name: "Lowe's → House Projects", conditions: [{ field: "payee", op: "equals", value: "Lowe's" }], actions: { setCategoryId: house.id } });
    await db.delete(s.rules).where(eq(s.rules.id, row!.id));
    await db.update(s.transactions).set({ catz: { method: "user", confidence: 1, at: now().toISOString() } }).where(inArray(s.transactions.id, ids));
  });

  it("live job: rules, transfers, AI, splits; writes catz/category/approved/payee + events; idempotent", async () => {
    const checking = (await account("Checking")).id;
    const cashBack = (await account("Cash Back Card")).id;
    const rewardsCard = (await account("Rewards Card")).id;
    const dining = (await db.select().from(s.categories)).find((c) => c.name.includes("Eating Out"))!;
    const groceries = (await db.select().from(s.categories)).find((c) => c.name.includes("Groceries"))!;
    const household = (await db.select().from(s.categories)).find((c) => /household|home supplies/i.test(c.name)) ?? groceries;
    const splitRule = await repo.createRule({
      name: "Costco split",
      priority: 1,
      enabled: true,
      source: "user",
      conditions: [{ field: "raw_description", op: "contains", value: "COSTCO TESTSPLIT" }],
      actions: { split: { mode: "percent", lines: [{ categoryId: groceries.id, percent: 8000 }, { categoryId: household.id, percent: 2000 }] } },
    });

    const kroger = await insertTxn({ accountId: cashBack, date: "2026-10-21", amountMilli: -64_210n, raw: "KROGER #0412 FAIRVIEW VA" });
    const payOut = await insertTxn({ accountId: checking, date: "2026-10-20", amountMilli: -777_770n, raw: "FABRIKAM E-PAYMENT 7788" });
    const payIn = await insertTxn({ accountId: cashBack, date: "2026-10-21", amountMilli: 777_770n, raw: "INTERNET PAYMENT - THANK YOU" });
    const mystery = await insertTxn({ accountId: rewardsCard, date: "2026-10-21", amountMilli: -18_400n, raw: "KESSLER S MINI 4411 MILTON VA" });
    const split = await insertTxn({ accountId: cashBack, date: "2026-10-21", amountMilli: -100_010n, raw: "COSTCO TESTSPLIT #1205" });
    const pending = await insertTxn({ accountId: rewardsCard, date: "2026-10-22", amountMilli: -30_000n, raw: "CIRCLE K 0466 FAIRVIEW VA", cleared: "pending" });

    const responder: FakeResponder = () =>
      jsonReply({ category_id: dining.id, confidence: 0.97, payee_name: "Kessler's Mini Mart", is_transfer: false, split: null, needs_web_lookup: false, explanation: "Deli lunch" });
    const fake = new FakeAnthropic(responder);
    const ai = new AiClient({ anthropic: fake, usage: new InMemoryUsageSink(), now });
    const job = createCategorizeJob(db, ai, { now });
    const sum = await job();
    expect(sum.errors).toEqual([]);
    expect(sum.mode).toBe("live");

    const k = await txn(kroger);
    expect(k).toMatchObject({ categoryId: groceries.id, approved: true });
    expect(k.catz).toMatchObject({ method: "rule" });
    expect(k.payeeId).toBeTruthy();

    const out = await txn(payOut);
    const inn = await txn(payIn);
    expect(out).toMatchObject({ transferPairId: payIn, transferAccountId: cashBack, categoryId: null, approved: true });
    expect(inn).toMatchObject({ transferPairId: payOut, transferAccountId: checking, approved: true });
    expect(inn.catz).toMatchObject({ method: "transfer" });

    const m = await txn(mystery);
    expect(m).toMatchObject({ categoryId: dining.id, approved: true });
    expect(m.catz).toMatchObject({ method: "ai", model: "claude-haiku-5-5" });
    const [mp] = await db.select().from(s.payees).where(eq(s.payees.id, m.payeeId!));
    expect(mp!.name).toBe("Kessler's Mini Mart");
    expect((await db.select().from(s.payeeAliases).where(eq(s.payeeAliases.payeeId, mp!.id))).length).toBe(1);

    const sp = await txn(split);
    expect(sp).toMatchObject({ isSplit: true, categoryId: null });
    const lines = await db.select().from(s.transactionSplits).where(eq(s.transactionSplits.transactionId, split));
    expect(lines.map((l) => l.amountMilli).sort()).toEqual([-80_010n, -20_000n].sort());

    expect((await txn(pending)).catz).toBeNull(); // pending rows wait for posting

    const events = await db.select().from(s.categorizationEvents).where(inArray(s.categorizationEvents.transactionId, [kroger, payOut, payIn, mystery, split]));
    expect(events).toHaveLength(5);
    expect(events.find((e) => e.transactionId === mystery)).toMatchObject({ method: "ai", shadow: false, accepted: true });
    expect(Number(events.find((e) => e.transactionId === mystery)!.costUsd)).toBeGreaterThan(0);

    const again = await job();
    expect(again.considered).toBe(0);
    await db.delete(s.rules).where(eq(s.rules.id, splitRule.id));
  });

  it("without AI: unknown merchants stay uncategorized with suggestions, unapproved", async () => {
    const rewardsCard = (await account("Rewards Card")).id;
    const id = await insertTxn({ accountId: rewardsCard, date: "2026-10-21", amountMilli: -9_990n, raw: "ZQX TRADING CO 77" });
    const sum = await createCategorizeJob(db, null, { now })({ transactionIds: [id] });
    expect(sum).toMatchObject({ considered: 1, suggestionsOnly: 1, approved: 0 });
    const r = await txn(id);
    expect(r).toMatchObject({ categoryId: null, approved: false });
    expect(r.catz).not.toBeNull();
  });

  it("shadow mode records a suggestion vs. the existing (YNAB) category and changes nothing", async () => {
    const cashBack = (await account("Cash Back Card")).id;
    const groceries = (await db.select().from(s.categories)).find((c) => c.name.includes("Groceries"))!;
    const id = await insertTxn({ accountId: cashBack, date: "2026-10-21", amountMilli: -55_000n, raw: "KROGER #0377 FAIRVIEW VA", categoryId: groceries.id });
    const before = await txn(id);
    const job = createCategorizeJob(db, null, { now, shadow: true });
    const sum = await job({ transactionIds: [id] });
    expect(sum).toMatchObject({ mode: "shadow", considered: 1, shadowAgreement: { matched: 1, compared: 1 } });
    const after = await txn(id);
    expect(after).toMatchObject({ categoryId: before.categoryId, approved: before.approved, catz: null, payeeId: null });
    const evs = await db.select().from(s.categorizationEvents).where(and(eq(s.categorizationEvents.transactionId, id), eq(s.categorizationEvents.shadow, true)));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ method: "rule", suggestedCategoryId: groceries.id, finalCategoryId: groceries.id, accepted: true });
    const rule = (await repo.getRules()).find((r) => r.name === "Kroger → Groceries")!;
    const hitsBefore = rule.hitCount;
    expect((await job({ transactionIds: [id] })).considered).toBe(0);
    expect((await repo.getRules()).find((r) => r.id === rule.id)!.hitCount).toBe(hitsBefore);
    expect((await db.select().from(s.transactions).where(and(eq(s.transactions.id, id), isNull(s.transactions.catz)))).length).toBe(1);
  });
});
