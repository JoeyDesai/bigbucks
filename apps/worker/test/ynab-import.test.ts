/**
 * §10 YNAB import into <base>_worker_test from synthetic exports, then the budget computed from the DB
 * must equal YNAB's own month figures (to_be_budgeted; budgeted/activity/balance per category).
 */
import { eq, isNotNull, sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, budgetMonthSummary, categories, payees, settings, targets, transactions, transactionSplits, type Db } from "@homebase/db";
import { ENGINE_VERSION, computeBudget, ynabPlanToSnapshot } from "@homebase/engine";
import { defaultRecompute, loadBudgetSnapshot, recomputeBudget } from "../src/budget";
import { importYnabPlan } from "../src/ynab/import";
import { formatParity, ynabParity } from "../src/ynab/parity";
import { CONNECTOR_FIXTURES, ENGINE_SYNTHETIC_PLAN, freshDb, readFixture } from "./helpers";

let db: Db;
let pool: pg.Pool;
const now = new Date("2026-10-22T16:00:00Z");
const count = async (q: string) => Number(Object.values((await pool.query(q)).rows[0] as object)[0]);
const counts = async () => ({
  accounts: await count("select count(*) from accounts"),
  groups: await count("select count(*) from category_groups"),
  categories: await count("select count(*) from categories"),
  payees: await count("select count(*) from payees"),
  transactions: await count("select count(*) from transactions"),
  splits: await count("select count(*) from transaction_splits"),
  scheduled: await count("select count(*) from scheduled_transactions"),
  assignments: await count("select count(*) from month_assignments"),
  targets: await count("select count(*) from targets"),
});

beforeAll(async () => {
  ({ db, pool } = await freshDb());
});
afterAll(async () => {
  await pool?.end();
});

describe("YNAB import (engine golden synthetic plan)", () => {
  const raw = readFixture<{ data: { plan: { months: Array<{ categories: Array<{ id: string; budgeted: number }> }> } } }>(ENGINE_SYNTHETIC_PLAN);

  it("imports every entity in one transaction with the §10 mapping", async () => {
    const s = await importYnabPlan(db, raw, { now });
    expect(s).toMatchObject({ planId: "plan-synthetic", serverKnowledge: 4242, accounts: 4, transactions: { inserted: 15, deleted: 1, updated: 0, mergedIntoSynced: 0 }, splits: 2, scheduled: 3, targets: 2 });

    const accts = await db.select().from(accounts);
    expect(accts.map((a) => [a.ynabId, a.kind, a.onBudget, a.closed, a.source]).sort()).toEqual([
      ["brok", "other", false, false, "ynab_import"],
      ["car", "loan", false, true, "ynab_import"],
      ["chk", "checking", true, false, "ynab_import"],
      ["visa", "credit_card", true, false, "ynab_import"],
    ]);
    const visa = accts.find((a) => a.ynabId === "visa")!;
    const cats = await db.select().from(categories);
    const byY = (y: string) => cats.find((c) => c.ynabId === y)!;
    expect([byY("rta").kind, byY("uncat").kind, byY("pay-visa").kind, byY("pay-visa").linkedAccountId, byY("ccint").kind, byY("ccint").hidden]).toEqual(["internal_rta", "uncategorized", "cc_payment", visa.id, "normal", true]);
    expect(byY("groc").name).toBe("Groceries"); // emoji stripped
    expect(byY("groc").icon).toBe("shopping-basket");
    expect(byY("pay-visa").icon).toBe("credit-card");
    expect(byY("old").deletedAt).not.toBeNull();
    expect(cats.filter((c) => c.ynabId === null)).toEqual([]); // no extra system categories needed

    const [sb] = await db.select().from(transactions).where(eq(transactions.ynabId, "t-sb-visa"));
    expect(sb).toMatchObject({ isStartingBalance: true, cleared: "reconciled", approved: true, source: "ynab_import", importOrder: 1 });
    const [split] = await db.select().from(transactions).where(eq(transactions.ynabId, "t-split"));
    expect(split).toMatchObject({ isSplit: true, categoryId: null });
    const lines = await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, split!.id));
    expect(lines.map((l) => [l.amountMilli, l.categoryId])).toEqual([
      [-40000n, byY("groc").id],
      [-20000n, byY("fun").id],
    ]);
    const [a] = await db.select().from(transactions).where(eq(transactions.ynabId, "t-ccpay-chk"));
    const [b] = await db.select().from(transactions).where(eq(transactions.ynabId, "t-ccpay-visa"));
    expect([a!.transferPairId, b!.transferPairId, a!.transferAccountId]).toEqual([b!.id, a!.id, visa.id]);
    const [del] = await db.select().from(transactions).where(eq(transactions.ynabId, "t-deleted"));
    expect(del!.deletedAt).not.toBeNull();

    const t = await db.select().from(targets).where(eq(targets.categoryId, byY("groc").id));
    expect(t[0]).toMatchObject({ type: "need_set_aside", amountMilli: 200000n, effectiveFrom: "2026-09-01" });
    const [p] = await db.select().from(payees).where(eq(payees.ynabId, "p-xfer-visa"));
    expect(p).toMatchObject({ transferAccountId: visa.id, normalizedKey: "transfervisa" });
    const [setting] = await db.select().from(settings).where(eq(settings.key, "ynab_import"));
    expect(setting!.value).toMatchObject({ plan_id: "plan-synthetic", server_knowledge: 4242 });
  });

  it("the budget computed from the DB matches YNAB's month figures exactly", async () => {
    await recomputeBudget(db, { asOf: "2026-10-22" });
    const report = await ynabParity(db, raw);
    expect(formatParity(report)).toMatch(/matches YNAB exactly/);
    expect(report.rows).toEqual([]);
    expect(report.checked).toBeGreaterThan(15);
    const [oct] = await db.select().from(budgetMonthSummary).where(sql`${budgetMonthSummary.month} = '2026-10-01' and ${budgetMonthSummary.engineVersion} = ${ENGINE_VERSION}`);
    expect(oct!.rtaMilli).toBe(4800000n); // to_be_budgeted in the fixture
    expect(await count("select count(*) from budget_month_cache")).toBeGreaterThan(10);
    // The production path (@homebase/core recompute) writes the same displayed RTA.
    await defaultRecompute(db, { fromMonth: null });
    const [oct2] = await db.select().from(budgetMonthSummary).where(sql`${budgetMonthSummary.month} = '2026-10-01' and ${budgetMonthSummary.engineVersion} = ${ENGINE_VERSION}`);
    expect(oct2!.rtaMilli).toBe(4800000n);
  });

  it("a parity diff is reported when YNAB disagrees", async () => {
    const tampered = structuredClone(raw);
    tampered.data.plan.months[1]!.categories.find((c) => c.id === "groc")!.budgeted += 1000;
    const report = await ynabParity(db, tampered);
    expect(report.rows.map((r) => [r.month, r.category, r.field])).toContainEqual(["2026-10-01", "Groceries", "assigned"]);
  });

  it("re-running is idempotent, and --replace rebuilds YNAB facts without duplicates", async () => {
    const before = await counts();
    const again = await importYnabPlan(db, raw, { now });
    expect(again.transactions).toMatchObject({ inserted: 0, updated: 15, deleted: 1 });
    expect(await counts()).toEqual(before);
    await importYnabPlan(db, raw, { now, replace: true });
    expect(await counts()).toEqual(before);
    expect((await ynabParity(db, raw)).rows).toEqual([]);
  });

  it("deltas update YNAB-owned fields, tombstone deletions and merge into matching synced rows", async () => {
    // A synced Checking row SimpleFIN brought in that YNAB hasn't seen yet.
    const [chk] = await db.select().from(accounts).where(eq(accounts.ynabId, "chk"));
    await db.update(accounts).set({ source: "simplefin", externalId: "ACT-1" }).where(eq(accounts.id, chk!.id));
    const [synced] = await db
      .insert(transactions)
      .values({ accountId: chk!.id, date: "2026-10-21", amountMilli: -42000n, rawDescription: "GROCER #12 FAIRVIEW VA", cleared: "cleared", source: "simplefin", externalId: "TRN-9" })
      .returning();
    const [groc] = await db.select().from(categories).where(eq(categories.ynabId, "groc"));
    const delta = {
      data: {
        server_knowledge: 4300,
        plan: {
          id: "plan-synthetic",
          name: "Synthetic Plan",
          accounts: [],
          payees: [],
          category_groups: [],
          categories: [],
          months: [{ month: "2026-10-01", to_be_budgeted: 4790000, deleted: false, categories: [{ id: "fun", category_group_id: "g-needs", name: "🍿 Fun", hidden: false, budgeted: 60000, activity: 0, balance: 60000, deleted: false }] }],
          transactions: [
            { id: "t-groc2", date: "2026-10-03", amount: -50000, memo: "edited in YNAB", cleared: "cleared", approved: true, flag_color: "red", account_id: "visa", payee_id: null, category_id: "fun", transfer_account_id: null, transfer_transaction_id: null, deleted: false },
            { id: "t-refund", date: "2026-10-08", amount: 30000, memo: null, cleared: "cleared", approved: true, flag_color: null, account_id: "visa", payee_id: null, category_id: "groc", transfer_account_id: null, transfer_transaction_id: null, deleted: true },
            { id: "t-new", date: "2026-10-20", amount: -42000, memo: "milk", cleared: "uncleared", approved: true, flag_color: null, account_id: "chk", payee_id: "p-grocer", category_id: "groc", transfer_account_id: null, transfer_transaction_id: null, deleted: false },
          ],
          subtransactions: [],
          scheduled_transactions: [],
          scheduled_subtransactions: [],
        },
      },
    };
    const s = await importYnabPlan(db, delta, { now, delta: true });
    expect(s.transactions).toEqual({ inserted: 0, updated: 1, mergedIntoSynced: 1, deleted: 1 });
    expect(s.earliestMonth).toBe("2026-10-01");

    const [edited] = await db.select().from(transactions).where(eq(transactions.ynabId, "t-groc2"));
    expect(edited).toMatchObject({ memo: "edited in YNAB", flag: "red" });
    const [refund] = await db.select().from(transactions).where(eq(transactions.ynabId, "t-refund"));
    expect(refund!.deletedAt).not.toBeNull();
    const [merged] = await db.select().from(transactions).where(eq(transactions.id, synced!.id));
    expect(merged).toMatchObject({ ynabId: "t-new", matchedYnabId: "t-new", categoryId: groc!.id, memo: "milk", externalId: "TRN-9", amountMilli: -42000n, date: "2026-10-21", source: "simplefin" });
    expect(await count("select count(*) from transactions where amount_milli = -42000")).toBe(1);
    const [fun] = await db.select().from(categories).where(eq(categories.ynabId, "fun"));
    expect(await count(`select assigned_milli from month_assignments where month = '2026-10-01' and category_id = '${fun!.id}'`)).toBe(60000);
    const [setting] = await db.select().from(settings).where(eq(settings.key, "ynab_import"));
    expect(setting!.value).toMatchObject({ server_knowledge: 4300, last_delta_at: now.toISOString() });
  });
});

describe("YNAB import (connectors synthetic fixture)", () => {
  it("imports and re-imports idempotently", async () => {
    ({ db, pool } = await freshDb());
    const raw = readFixture(`${CONNECTOR_FIXTURES}/ynab-plan-synthetic.json`);
    const first = await importYnabPlan(db, raw, { now });
    expect(first.planName).toBe("My Budget");
    expect(first.transactions.inserted).toBeGreaterThan(0);
    const before = await counts();
    await importYnabPlan(db, raw, { now });
    expect(await counts()).toEqual(before);
    // One internal_rta and one uncategorized, each card has a payment category.
    expect(await count("select count(*) from categories where kind = 'internal_rta'")).toBe(1);
    expect(await count("select count(*) from categories where kind = 'uncategorized'")).toBe(1);
    expect(await count("select count(*) from accounts a where a.on_budget and a.kind = 'credit_card' and not a.closed and a.deleted_at is null and not exists (select 1 from categories c where c.kind = 'cc_payment' and c.linked_account_id = a.id)")).toBe(0);
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(transactions).where(isNotNull(transactions.ynabId));
    expect(rows[0]!.n).toBe(before.transactions);
    await recomputeBudget(db, {});
    const report = await ynabParity(db, raw);
    // This fixture's month figures are illustrative (its few transactions don't produce them, even in the
    // engine alone), so assert the DB round trip is lossless instead: DB-based RTA == engine-only RTA.
    const mapped = ynabPlanToSnapshot(raw);
    const direct = computeBudget(mapped.snapshot, { through: mapped.lastMonth! });
    const viaDb = computeBudget(await loadBudgetSnapshot(db), { through: mapped.lastMonth! });
    expect(report.months.map((m) => viaDb.months[m]!.readyToAssignDisplay)).toEqual(report.months.map((m) => direct.months[m]!.readyToAssignDisplay));
  });
});
