import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accounts, budgetMonthCache, categories, transactions } from "@homebase/db";
import { ENGINE_VERSION } from "@homebase/engine";
import { parseMilli } from "@homebase/shared";
import { clearBudgetMemo, ensureFresh, recompute } from "../src/budget/cache";
import { getOverview } from "../src/overview";
import { listAccounts } from "../src/transactions/accounts";
import { getTransaction, listTransactions } from "../src/transactions/list";
import { deleteTransactions, recategorize } from "../src/transactions/mutate";
import { listPayees } from "../src/payees";
import { netWorth } from "../src/wealth/netWorth";
import { accountsBySection } from "../src/wealth/sections";
import { TODAY, useDemoDb } from "./helpers";

const env = useDemoDb();
const $ = parseMilli;

describe("raw-SQL timestamps are Date objects", () => {
  it("listAccounts / getTransaction / listTransactions", async () => {
    const list = await listAccounts(env.db, { today: TODAY });
    const checking = list.find((a) => a.name === "Checking")!;
    expect(checking.lastSyncAt).toBeInstanceOf(Date);
    expect(() => checking.lastSyncAt!.toISOString()).not.toThrow();
    expect(list.every((a) => a.lastSyncAt === null || a.lastSyncAt instanceof Date)).toBe(true);

    const [amazon] = await env.db.select().from(transactions).where(sql`${transactions.catz} -> 'suggestions' IS NOT NULL AND ${transactions.categoryId} IS NULL`).limit(1);
    const [misc] = await env.db.select().from(categories).where(eq(categories.name, "Misc"));
    await recategorize(env.ctx, [amazon!.id], misc!.id);
    const detail = await getTransaction(env.db, amazon!.id);
    expect(detail.events.length).toBeGreaterThan(0);
    for (const e of detail.events) expect(e.at).toBeInstanceOf(Date);
    expect(detail.postedAt === null || detail.postedAt instanceof Date).toBe(true);

    await deleteTransactions(env.ctx, [amazon!.id]);
    const page = await listTransactions(env.db, { includeDeleted: true, dateFrom: amazon!.date, dateTo: amazon!.date }, { limit: 200 });
    const row = page.rows.find((r) => r.id === amazon!.id)!;
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(page.rows.filter((r) => r.id !== amazon!.id).every((r) => r.deletedAt === null)).toBe(true);
    expect((await listPayees(env.db, { includeDeleted: true })).length).toBeGreaterThan(0);
    await env.reseed();
  });
});

describe("tracking-account balances come from snapshots", () => {
  it("listAccounts, accountsBySection and getOverview agree with net worth", async () => {
    const list = await listAccounts(env.db, { today: TODAY });
    for (const name of ["Mortgage", "Litware Brokerage", "Litware 401k (Alex)", "Mercury Checking", "Home"]) {
      const a = list.find((x) => x.name === name)!;
      expect(a.onBudget).toBe(false);
      expect(a.balance, name).toBe(a.syncedBalance);
    }
    const mortgage = list.find((a) => a.name === "Mortgage")!;
    expect(mortgage.balance).toBeLessThan(-$("250000")); // owed, not the +$47k of transfers in its ledger
    expect(mortgage.workingBalance).toBeGreaterThan(0n);
    // on-budget accounts keep the ledger's working balance
    const checking = list.find((a) => a.name === "Checking")!;
    expect(checking.balance).toBe(checking.workingBalance);

    const [household] = await env.db.execute<{ id: string }>(sql`SELECT id FROM entities WHERE name = 'Household'`).then((r) => r.rows);
    const nw = await netWorth(env.db, { period: "1M", today: TODAY });
    const sumHousehold = list.filter((a) => a.entityId === household!.id).reduce((s, a) => s + a.balance, 0n);
    expect(sumHousehold).toBe(nw.headline.netWorth);

    const { sections } = await accountsBySection(env.db, { today: TODAY });
    expect(sections.reduce((s, x) => s + x.total, 0n)).toBe(nw.headline.netWorth);
    const mort = sections.find((s) => s.key === "mortgage")!;
    expect(mort.total).toBe(mortgage.syncedBalance);

    const o = await getOverview(env.db, { today: TODAY });
    expect(o.netWorth).toBe(nw.headline.netWorth);
    const householdIds = new Set(list.filter((a) => a.entityId === household!.id).map((a) => a.id));
    expect(o.accounts.filter((a) => householdIds.has(a.id)).reduce((s, a) => s + a.balance, 0n)).toBe(nw.headline.netWorth);
    expect(o.accounts.find((a) => a.name === "Mortgage")!.balance).toBe(mortgage.syncedBalance);
  });
});

describe("concurrent ensureFresh on a stale cache", () => {
  it("serializes the recomputes: no failed inserts, one rewrite, everyone sees the fresh cache", async () => {
    await recompute(env.db, { today: TODAY });
    const [checking] = await env.db.select().from(accounts).where(eq(accounts.name, "Checking"));
    for (let round = 0; round < 3; round++) {
      // an outside write (sync worker) makes the cache stale; a cold process has no memo
      await env.db.insert(transactions).values({ accountId: checking!.id, date: "2026-10-21", amountMilli: -$("1.11"), cleared: "cleared", approved: false, source: "manual" });
      clearBudgetMemo();
      const results = await Promise.all(Array.from({ length: 6 }, () => ensureFresh(env.db, TODAY)));
      expect(results.filter((r) => r.recomputed).length).toBeGreaterThanOrEqual(1);
      const fps = new Set(results.map((r) => r.state.fingerprint));
      expect(fps.size).toBe(1);
      const oct = results.map((r) => r.result.months["2026-10-01"]!.readyToAssignDisplay);
      expect(new Set(oct).size).toBe(1);
      const again = await ensureFresh(env.db, TODAY);
      expect(again.recomputed).toBe(false);
    }
    const dup = await env.db.execute<{ n: bigint }>(sql`SELECT count(*) AS n FROM (SELECT month, category_id FROM budget_month_cache WHERE engine_version = ${ENGINE_VERSION} GROUP BY 1, 2 HAVING count(*) > 1) d`);
    expect(Number(dup.rows[0]!.n)).toBe(0);
    expect((await env.db.select().from(budgetMonthCache)).length).toBeGreaterThan(0);
    await env.reseed();
  });
});
