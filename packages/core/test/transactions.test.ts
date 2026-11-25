import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, categories, categorizationEvents, reconciliations, scheduledTransactions, transactionSplits, transactions } from "@homebase/db";
import { parseMilli, type Catz } from "@homebase/shared";
import { getBudgetMonth } from "../src/budget/view";
import { ValidationError } from "../src/errors";
import { createAccount, getAccount, listAccounts, updateAccount } from "../src/transactions/accounts";
import { getTransaction, listTransactions } from "../src/transactions/list";
import { approveTransactions, createTransaction, deleteTransactions, markTransfer, recategorize, splitTransaction, updateTransaction } from "../src/transactions/mutate";
import { reconcile } from "../src/transactions/reconcile";
import { approveAllHighConfidence, reviewInbox } from "../src/transactions/review";
import { createScheduled, listScheduled, materializeDue } from "../src/transactions/scheduled";
import { MONTH, TODAY, useDemoDb } from "./helpers";

const env = useDemoDb();
const $ = parseMilli;

async function catId(name: string): Promise<string> {
  const [c] = await env.db.select({ id: categories.id }).from(categories).where(eq(categories.name, name));
  return c!.id;
}
async function acct(name: string) {
  const [a] = await env.db.select().from(accounts).where(eq(accounts.name, name));
  return a!;
}
const plan = () => getBudgetMonth(env.db, MONTH, { today: TODAY });

describe("investment accounts stay out of review", () => {
  it("a new brokerage transaction isn't listed for review or as uncategorized, but its own account still lists it", async () => {
    const brokerage = await acct("Litware Brokerage");
    const t = await createTransaction(env.ctx, { accountId: brokerage.id, date: "2026-10-21", amount: $("12.34"), payeeName: "Dividend FXAIX" });
    await env.db.update(transactions).set({ approved: false }).where(eq(transactions.id, t.id));
    try {
      const unapproved = await listTransactions(env.db, { approved: false, excludeInvestments: true }, { limit: 500 });
      expect(unapproved.rows.some((r) => r.id === t.id)).toBe(false);
      const inbox = await reviewInbox(env.db, { limit: 500 });
      expect(inbox.items.some((r) => r.id === t.id)).toBe(false);
      const own = await listTransactions(env.db, { accountIds: [brokerage.id] }, { limit: 500 });
      expect(own.rows.some((r) => r.id === t.id)).toBe(true);
    } finally {
      await deleteTransactions(env.ctx, [t.id]);
    }
  });
});

describe("listTransactions", () => {
  it("paginates with a cursor and keeps a per-account running balance", async () => {
    const checking = await acct("Checking");
    const p1 = await listTransactions(env.db, { accountIds: [checking.id] }, { limit: 25 });
    const p2 = await listTransactions(env.db, { accountIds: [checking.id] }, { limit: 25, cursor: p1.nextCursor });
    expect(p1.rows).toHaveLength(25);
    expect(p1.nextCursor).toBeTruthy();
    const ids = new Set(p1.rows.map((r) => r.id));
    expect(p2.rows.some((r) => ids.has(r.id))).toBe(false);
    expect(p1.rows[24]!.date >= p2.rows[0]!.date).toBe(true);
    // newest row's running balance = the account's working balance (pending excluded)
    const a = await getAccount(env.db, checking.id, { today: TODAY });
    const newestPosted = p1.rows.find((r) => r.cleared !== "pending")!;
    expect(newestPosted.runningBalance).toBe(a.workingBalance);
    // consecutive rows differ by the newer row's amount
    for (let i = 0; i < p1.rows.length - 1; i++) {
      const r = p1.rows[i]!;
      const next = p1.rows[i + 1]!;
      if (r.cleared === "pending" || next.cleared === "pending") continue;
      expect(r.runningBalance! - next.runningBalance!).toBe(r.amount);
    }
    expect(p1.totals!.count).toBe(Number((await env.db.execute<{ n: bigint }>(sql`SELECT count(*) AS n FROM transactions WHERE account_id = ${checking.id} AND deleted_at IS NULL`)).rows[0]!.n));
  });

  it("filters by text, category (incl. split lines), amount and date", async () => {
    const kroger = await listTransactions(env.db, { text: "kroger", dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(kroger.rows.length).toBeGreaterThan(0);
    expect(kroger.rows.every((r) => r.payeeName === "Kroger" || /KROGER/i.test(r.rawDescription ?? ""))).toBe(true);
    const big = await listTransactions(env.db, { maxAmount: -$("1000") }, { limit: 500 });
    expect(big.rows.every((r) => r.amount <= -$("1000"))).toBe(true);
    const groceries = await catId("Groceries");
    const g = await listTransactions(env.db, { categoryIds: [groceries] }, { limit: 500 });
    expect(g.rows.every((r) => r.categoryId === groceries || r.splits.some((s) => s.categoryId === groceries))).toBe(true);
    const unc = await listTransactions(env.db, { uncategorized: true, dateFrom: "2026-10-01" });
    expect(unc.totals!.outflow).toBe(-$("426.50"));
  });
});

describe("transaction writes", () => {
  beforeEach(async () => {
    await env.reseed();
  });

  it("validates split sums and logs a categorization event per line", async () => {
    const checking = await acct("Checking");
    const t = await createTransaction(env.ctx, { accountId: checking.id, date: "2026-10-21", amount: -$("100"), payeeName: "Costco", categoryId: await catId("Groceries") });
    const groceries = await catId("Groceries");
    const misc = await catId("Misc");
    await expect(splitTransaction(env.ctx, t.id, [{ amount: -$("60"), categoryId: groceries }, { amount: -$("30"), categoryId: misc }])).rejects.toBeInstanceOf(ValidationError);
    await expect(splitTransaction(env.ctx, t.id, [{ amount: -$("100"), categoryId: groceries }])).rejects.toBeInstanceOf(ValidationError);
    const before = await plan();
    await splitTransaction(env.ctx, t.id, [{ amount: -$("80"), categoryId: groceries }, { amount: -$("20"), categoryId: misc }]);
    const lines = await env.db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, t.id));
    expect(lines).toHaveLength(2);
    const [row] = await env.db.select().from(transactions).where(eq(transactions.id, t.id));
    expect(row!.isSplit).toBe(true);
    expect(row!.categoryId).toBeNull();
    const after = await plan();
    const f = (v: typeof before, n: string) => v.groups.flatMap((g) => g.categories).find((c) => c.name === n)!;
    expect(f(after, "Groceries").activity - f(before, "Groceries").activity).toBe($("20"));
    expect(f(after, "Misc").activity - f(before, "Misc").activity).toBe(-$("20"));
    const events = await env.db.select().from(categorizationEvents).where(eq(categorizationEvents.transactionId, t.id));
    expect(events.filter((e) => e.method === "user").map((e) => e.finalCategoryId).sort()).toEqual([groceries, groceries, misc].sort());
    // changing a split's amount without new lines is refused
    await expect(updateTransaction(env.ctx, t.id, { amount: -$("90") })).rejects.toBeInstanceOf(ValidationError);
  });

  it("recategorize writes categorization_events with accepted vs the prior suggestion", async () => {
    const amazon = await env.db
      .select()
      .from(transactions)
      .where(and(isNull(transactions.categoryId), eq(transactions.isSplit, false), isNull(transactions.transferAccountId), eq(transactions.approved, false), sql`${transactions.catz} -> 'suggestions' IS NOT NULL`))
      .orderBy(desc(transactions.date));
    expect(amazon.length).toBeGreaterThanOrEqual(2);
    const top = (amazon[0]!.catz as Catz).suggestions![0]!.category_id;
    const other = await catId("Gifts");
    expect(top).not.toBe(other);
    const r1 = await recategorize(env.ctx, [amazon[0]!.id], top);
    const r2 = await recategorize(env.ctx, [amazon[1]!.id], other, { approve: true });
    expect(r1.updated).toEqual([amazon[0]!.id]);
    expect(r2.updated).toEqual([amazon[1]!.id]);
    const e1 = await env.db.select().from(categorizationEvents).where(and(eq(categorizationEvents.transactionId, amazon[0]!.id), eq(categorizationEvents.method, "user")));
    const e2 = await env.db.select().from(categorizationEvents).where(and(eq(categorizationEvents.transactionId, amazon[1]!.id), eq(categorizationEvents.method, "user")));
    expect(e1).toHaveLength(1);
    expect(e1[0]!).toMatchObject({ suggestedCategoryId: top, finalCategoryId: top, accepted: true, userId: env.alexId });
    expect(e2[0]!).toMatchObject({ suggestedCategoryId: top, finalCategoryId: other, accepted: false });
    const [t2] = await env.db.select().from(transactions).where(eq(transactions.id, amazon[1]!.id));
    expect(t2!.approved).toBe(true);
    expect((t2!.catz as Catz).method).toBe("user");
    // uncategorized spending dropped by the two amounts
    const v = await plan();
    expect(v.uncategorized!.activity).toBe(-$("426.50") - amazon[0]!.amountMilli - amazon[1]!.amountMilli);
    // transfers between budget accounts are skipped
    const [xfer] = await env.db.select().from(transactions).where(and(eq(transactions.accountId, (await acct("Checking")).id), eq(transactions.transferAccountId, (await acct("Savings")).id))).limit(1);
    const r3 = await recategorize(env.ctx, [xfer!.id], other);
    expect(r3.skipped).toEqual([{ id: xfer!.id, reason: "transfer between budget accounts" }]);
  });

  it("reconcile creates an adjustment to Ready to Assign and locks cleared rows", async () => {
    const checking = await acct("Checking");
    const a0 = await getAccount(env.db, checking.id, { today: TODAY });
    const rta0 = (await plan()).summary.readyToAssign;
    const res = await reconcile(env.ctx, { accountId: checking.id, statementBalance: a0.clearedBalance + $("12.34"), statementDate: "2026-10-21" });
    expect(res.difference).toBe($("12.34"));
    expect(res.adjustment).not.toBeNull();
    const [rta] = await env.db.select().from(categories).where(eq(categories.kind, "internal_rta"));
    expect(res.adjustment!.categoryId).toBe(rta!.id);
    expect(res.adjustment!.source).toBe("reconciliation");
    const left = await env.db.execute<{ n: bigint }>(sql`SELECT count(*) AS n FROM transactions WHERE account_id = ${checking.id} AND cleared = 'cleared' AND deleted_at IS NULL`);
    expect(Number(left.rows[0]!.n)).toBe(0);
    const [adj] = await env.db.select().from(transactions).where(eq(transactions.id, res.adjustment!.id));
    expect(adj!.cleared).toBe("reconciled");
    const [rec] = await env.db.select().from(reconciliations).where(eq(reconciliations.id, res.reconciliationId));
    expect(rec!.adjustmentTxId).toBe(res.adjustment!.id);
    expect(rec!.clearedBalanceMilli).toBe(a0.clearedBalance);
    expect((await getAccount(env.db, checking.id, { today: TODAY })).clearedBalance).toBe(a0.clearedBalance + $("12.34"));
    expect((await plan()).summary.readyToAssign).toBe(rta0 + $("12.34"));
    // already balanced: no adjustment
    const again = await reconcile(env.ctx, { accountId: checking.id, statementBalance: a0.clearedBalance + $("12.34") });
    expect(again.adjustment).toBeNull();
  });

  it("reconciling a card adjusts its payment category", async () => {
    const cashBack = await acct("Cash Back Card");
    const a0 = await getAccount(env.db, cashBack.id, { today: TODAY });
    const res = await reconcile(env.ctx, { accountId: cashBack.id, statementBalance: a0.clearedBalance - $("5") });
    const [pk] = await env.db.select().from(categories).where(and(eq(categories.kind, "cc_payment"), eq(categories.linkedAccountId, cashBack.id)));
    expect(res.adjustment!.categoryId).toBe(pk!.id);
  });

  it("markTransfer creates and links the pair; delete removes both", async () => {
    const checking = await acct("Checking");
    const savings = await acct("Savings");
    const t = await createTransaction(env.ctx, { accountId: checking.id, date: "2026-10-21", amount: -$("250"), payeeName: "Online transfer", categoryId: await catId("Misc") });
    const { transaction, pair } = await markTransfer(env.ctx, t.id, { accountId: savings.id });
    expect(transaction.transferPairId).toBe(pair.id);
    expect(pair.transferPairId).toBe(t.id);
    expect(pair.amountMilli).toBe($("250"));
    expect(transaction.categoryId).toBeNull();
    const ev = await env.db.select().from(categorizationEvents).where(and(eq(categorizationEvents.transactionId, t.id), eq(categorizationEvents.method, "user")));
    expect(ev.at(-1)!.finalCategoryId).toBeNull();
    // editing the amount mirrors to the pair
    await updateTransaction(env.ctx, t.id, { amount: -$("260") });
    expect((await getTransaction(env.db, pair.id)).amount).toBe($("260"));
    const del = await deleteTransactions(env.ctx, [t.id]);
    expect(del.deleted.sort()).toEqual([t.id, pair.id].sort());
  });

  it("transfers created in one step get a pair and the budget side keeps its category", async () => {
    const checking = await acct("Checking");
    const brokerage = await acct("Litware Brokerage");
    const ira = await catId("Alex's Retirement");
    const t = await createTransaction(env.ctx, { accountId: checking.id, date: "2026-10-21", amount: -$("100"), transferAccountId: brokerage.id, categoryId: ira });
    expect(t.categoryId).toBe(ira);
    const pair = await getTransaction(env.db, t.transferPairId!);
    expect(pair.accountId).toBe(brokerage.id);
    expect(pair.categoryId).toBeNull();
  });
});

describe("review inbox", () => {
  beforeEach(async () => {
    await env.reseed();
  });

  it("lists unapproved newest first with top-3 suggestions", async () => {
    const inbox = await reviewInbox(env.db, { limit: 100 });
    const n = await env.db.execute<{ n: bigint }>(sql`SELECT count(*) AS n FROM transactions WHERE NOT approved AND deleted_at IS NULL`);
    expect(inbox.count).toBe(Number(n.rows[0]!.n));
    expect(inbox.items.length).toBe(inbox.count);
    for (let i = 1; i < inbox.items.length; i++) expect(inbox.items[i - 1]!.date >= inbox.items[i]!.date).toBe(true);
    const withSugg = inbox.items.filter((i) => i.suggestions.length > 1);
    expect(withSugg.length).toBeGreaterThan(0);
    for (const i of withSugg) {
      expect(i.suggestions.length).toBeLessThanOrEqual(3);
      expect(i.suggestions[0]!.confidence).toBeGreaterThanOrEqual(i.suggestions.at(-1)!.confidence);
      expect(i.suggestions[0]!.categoryName).toBeTruthy();
    }
  });

  it("approveAllHighConfidence approves only confident, reviewable rows", async () => {
    const before = await reviewInbox(env.db, { limit: 200 });
    const r = await approveAllHighConfidence(env.ctx, { threshold: 0.9 });
    const after = await reviewInbox(env.db, { limit: 200 });
    expect(after.count).toBe(before.count - r.approved.length);
    const approved = before.items.filter((i) => r.approved.includes(i.id));
    for (const a of approved) {
      expect(a.confidence!).toBeGreaterThanOrEqual(0.9);
      expect(a.categoryId !== null || a.transferAccountId !== null || a.isSplit).toBe(true);
    }
    const misc = await catId("Misc");
    expect(approved.some((a) => a.categoryId === misc)).toBe(false);
    // approving closes pending categorization events
    if (approved[0]) {
      const ev = await env.db.select().from(categorizationEvents).where(eq(categorizationEvents.transactionId, approved[0].id));
      expect(ev.every((e) => e.accepted !== null || e.shadow)).toBe(true);
    }
    expect((await approveTransactions(env.ctx, r.approved)).approved).toEqual([]);
  });
});

describe("scheduled transactions", () => {
  beforeEach(async () => {
    await env.reseed();
  });

  it("materializeDue enters due occurrences once and advances next_date", async () => {
    const day = "2026-10-26";
    const due = (await listScheduled(env.db, { today: TODAY })).filter((s) => s.nextDate <= day);
    expect(due.length).toBeGreaterThanOrEqual(3);
    const r = await materializeDue({ ...env.ctx, today: day });
    expect(r.created.length).toBe(due.length);
    for (const c of r.created) {
      const t = await getTransaction(env.db, c.transactionId);
      expect(t.approved).toBe(false);
      expect(t.cleared).toBe("uncleared");
      expect(t.source).toBe("scheduled");
    }
    const payroll = due.find((s) => s.memo?.startsWith("Payroll"))!;
    const [p] = await env.db.select().from(scheduledTransactions).where(eq(scheduledTransactions.id, payroll.id));
    expect(p!.nextDate).toBe("2026-11-23");
    const xfer = due.find((s) => s.transferAccountId && s.amountMilli === -$("500"))!;
    const made = r.created.find((c) => c.scheduledId === xfer.id)!;
    expect((await getTransaction(env.db, made.transactionId)).transferPairId).toBeTruthy();
    const again = await materializeDue({ ...env.ctx, today: day });
    expect(again.created).toHaveLength(0);
  });

  it("creates a schedule and validates splits", async () => {
    const checking = await acct("Checking");
    await expect(
      createScheduled(env.ctx, { accountId: checking.id, date: "2026-11-05", frequency: "monthly", amount: -$("50"), splits: [{ amount: -$("20"), categoryId: await catId("Gas") }, { amount: -$("20"), categoryId: await catId("Groceries") }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    const s = await createScheduled(env.ctx, { accountId: checking.id, date: "2026-11-05", frequency: "monthly", amount: -$("50"), payeeName: "Gym", categoryId: await catId("Entertainment") });
    const list = await listScheduled(env.db, { today: TODAY, horizonDays: 60 });
    expect(list.find((x) => x.id === s.id)!.upcoming).toEqual(["2026-11-05", "2026-12-05"]);
  });
});

describe("accounts", () => {
  beforeEach(async () => {
    await env.reseed();
  });

  it("lists balances, sync freshness and connection status", async () => {
    const list = await listAccounts(env.db, { today: TODAY });
    const checking = list.find((a) => a.name === "Checking")!;
    expect(checking.workingBalance).toBe(checking.clearedBalance + checking.unclearedBalance);
    expect(checking.balance).toBe(checking.workingBalance);
    expect(checking.syncedBalance).toBe(checking.workingBalance);
    expect(checking.statusColor).toBe("green");
    const home = list.find((a) => a.name === "Home")!;
    expect(home.transactionCount).toBe(0);
    expect(home.balance).toBe(home.syncedBalance);
    expect(list.find((a) => a.name === "Mercury Checking")!.entityName).toBe("Northwind Studio LLC");
  });

  it("creating an on-budget card creates its payment category; starting debt doesn't touch RTA", async () => {
    const rta0 = (await plan()).summary.readyToAssign;
    const card = await createAccount(env.ctx, { name: "Chase Sapphire", kind: "credit_card", startingBalance: -$("1200"), startingDate: "2026-10-20" });
    expect(card.onBudget).toBe(true);
    const [pk] = await env.db.select().from(categories).where(and(eq(categories.kind, "cc_payment"), eq(categories.linkedAccountId, card.id)));
    expect(pk!.name).toBe("Chase Sapphire");
    const v = await plan();
    const pc = v.groups[0]!.categories.find((c) => c.id === pk!.id)!;
    expect(v.groups[0]!.isCreditCardPayments).toBe(true);
    expect(pc.payment!.debt).toBe($("1200"));
    expect(pc.underfunded).toBe($("1200"));
    expect(v.summary.readyToAssign).toBe(rta0);
    // a new cash account's starting balance goes to Ready to Assign
    await createAccount(env.ctx, { name: "Cash jar", kind: "cash", startingBalance: $("40"), startingDate: "2026-10-20" });
    expect((await plan()).summary.readyToAssign).toBe(rta0 + $("40"));
    // renaming the card renames its payment category; tracking accounts default off budget
    await updateAccount(env.ctx, card.id, { name: "Sapphire Preferred", nickname: "Sapphire" });
    const [pk2] = await env.db.select().from(categories).where(eq(categories.id, pk!.id));
    expect(pk2!.name).toBe("Sapphire Preferred");
    const ira = await createAccount(env.ctx, { name: "Roth IRA", kind: "retirement", monthlyContribution: $("500") });
    expect(ira.onBudget).toBe(false);
  });
});
