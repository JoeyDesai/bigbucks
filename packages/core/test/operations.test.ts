import { and, asc, eq, isNotNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, auditLog, budgetMonthCache, budgetMonthSummary, budgetOperations, categories, categoryGroups, monthAssignments, monthNotes, targets, transactions } from "@homebase/db";
import { parseMilli } from "@homebase/shared";
import {
  assign,
  autoAssign,
  createCategory,
  editTarget,
  hideCategory,
  listRecentMoves,
  mergeCategories,
  moveMoney,
  redo,
  renameCategory,
  reorderCategories,
  setMonthNote,
  snoozeTarget,
  undo,
  unhideCategory,
} from "../src/budget/operations";
import { getBudgetMonth } from "../src/budget/view";
import { aiCtx } from "../src/context";
import { ConflictError, ValidationError } from "../src/errors";
import { createTransaction } from "../src/transactions/mutate";
import { MONTH, TODAY, useDemoDb } from "./helpers";

const env = useDemoDb();
const $ = parseMilli;

async function catId(name: string): Promise<string> {
  const [c] = await env.db.select({ id: categories.id }).from(categories).where(eq(categories.name, name));
  if (!c) throw new Error(`no category ${name}`);
  return c.id;
}

/** Full budget state: assignments + every cache row + summaries. */
async function budgetState() {
  const asg = await env.db.select({ m: monthAssignments.month, c: monthAssignments.categoryId, a: monthAssignments.assignedMilli }).from(monthAssignments).orderBy(asc(monthAssignments.month), asc(monthAssignments.categoryId));
  const cache = await env.db
    .select({ m: budgetMonthCache.month, c: budgetMonthCache.categoryId, as: budgetMonthCache.assignedMilli, ac: budgetMonthCache.activityMilli, av: budgetMonthCache.availableMilli, ci: budgetMonthCache.carryInMilli, n: budgetMonthCache.neededMilli, u: budgetMonthCache.underfundedMilli })
    .from(budgetMonthCache)
    .orderBy(asc(budgetMonthCache.month), asc(budgetMonthCache.categoryId));
  const sum = await env.db.select({ m: budgetMonthSummary.month, r: budgetMonthSummary.rtaMilli, f: budgetMonthSummary.assignedFutureMilli, c: budgetMonthSummary.costToBeMeMilli }).from(budgetMonthSummary).orderBy(asc(budgetMonthSummary.month));
  return { asg, cache, sum };
}

const plan = () => getBudgetMonth(env.db, MONTH, { today: TODAY });
const cat = async (name: string) => (await plan()).groups.flatMap((g) => [...g.categories]).concat((await plan()).hidden).find((c) => c.name === name)!;

describe("assign / undo / redo", () => {
  beforeEach(async () => {
    await env.reseed();
    await plan(); // warm the cache
  });

  it("restores the exact state", async () => {
    const groceries = await catId("Groceries");
    const s0 = await budgetState();
    const rta0 = (await plan()).summary.readyToAssign;
    const r = await assign(env.ctx, { month: MONTH, categoryId: groceries, expr: "+50" });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.to - r.changes[0]!.from).toBe($("50"));
    expect(r.rtaDelta).toBe(-$("50"));
    const s1 = await budgetState();
    expect(s1).not.toEqual(s0);
    expect((await plan()).summary.readyToAssign).toBe(rta0 - $("50"));
    const [op] = await env.db.select().from(budgetOperations).where(eq(budgetOperations.id, r.operationId!));
    expect(op!.kind).toBe("assign");
    const audits = await env.db.select().from(auditLog).where(eq(auditLog.action, "budget.assign"));
    expect(audits.at(-1)!.actor).toBe("user");

    await undo(env.ctx, r.operationId!);
    expect(await budgetState()).toEqual(s0);
    await expect(undo(env.ctx, r.operationId!)).rejects.toBeInstanceOf(ConflictError);
    await redo(env.ctx, r.operationId!);
    expect(await budgetState()).toEqual(s1);
  });

  it("sets an absolute amount and refuses a stale undo", async () => {
    const gas = await catId("Gas");
    const a = await assign(env.ctx, { month: MONTH, categoryId: gas, amount: $("300") });
    await assign(env.ctx, { month: MONTH, categoryId: gas, amount: $("310") });
    await expect(undo(env.ctx, a.operationId!)).rejects.toBeInstanceOf(ConflictError);
    expect((await cat("Gas")).assigned).toBe($("310"));
  });

  it("rejects assigning to Ready to Assign / bad expressions", async () => {
    const [rta] = await env.db.select().from(categories).where(eq(categories.kind, "internal_rta"));
    await expect(assign(env.ctx, { month: MONTH, categoryId: rta!.id, amount: 1n })).rejects.toBeInstanceOf(ValidationError);
    const gas = await catId("Gas");
    await expect(assign(env.ctx, { month: MONTH, categoryId: gas, expr: "abc" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("AI writes need a confirming user", async () => {
    const gas = await catId("Gas");
    await expect(assign({ ...env.ctx, actor: "ai", confirmedBy: null }, { month: MONTH, categoryId: gas, amount: 1n })).rejects.toBeInstanceOf(ValidationError);
    const r = await assign(aiCtx(env.db, env.alexId, env.alexId, TODAY), { month: MONTH, categoryId: gas, expr: "+1" });
    const [a] = await env.db.select().from(auditLog).where(and(eq(auditLog.action, "budget.assign"), eq(auditLog.actor, "ai")));
    expect(a!.confirmedBy).toBe(env.alexId);
    expect(r.operationId).toBeTruthy();
  });
});

describe("moveMoney", () => {
  beforeEach(async () => {
    await env.reseed();
  });

  it("moves between categories without touching RTA", async () => {
    const dates = await catId("Dates");
    const ent = await catId("Entertainment");
    const before = await plan();
    const r = await moveMoney(env.ctx, { month: MONTH, from: ent, to: dates, amount: $("15") });
    expect(r.rtaDelta).toBe(0n);
    const after = await plan();
    expect(after.summary.readyToAssign).toBe(before.summary.readyToAssign);
    const f = (v: typeof before, n: string) => v.groups.flatMap((g) => g.categories).find((c) => c.name === n)!;
    expect(f(after, "Dates").available - f(before, "Dates").available).toBe($("15"));
    expect(f(after, "Entertainment").available - f(before, "Entertainment").available).toBe(-$("15"));
    const moves = await listRecentMoves(env.db, MONTH);
    expect(moves[0]!.id).toBe(r.operationId);
    expect(moves[0]!.description).toBe("Moved $15.00 from Entertainment to Dates");
    expect(moves[0]!.canUndo).toBe(true);
    // seeded legacy rows are listed but can't be undone
    expect(moves.some((m) => !m.canUndo && m.kind === "auto_assign")).toBe(true);
  });

  it("moves to and from Ready to Assign", async () => {
    const misc = await catId("Misc");
    const before = await plan();
    const r = await moveMoney(env.ctx, { month: MONTH, from: "rta", to: misc, amount: $("137.42") });
    expect(r.rtaDelta).toBe(-$("137.42"));
    const after = await plan();
    expect(after.summary.readyToAssign).toBe(before.summary.readyToAssign - $("137.42"));
    expect(after.groups.flatMap((g) => g.categories).find((c) => c.name === "Misc")!.available).toBe(0n);
    await moveMoney(env.ctx, { month: MONTH, from: misc, to: "rta", amount: $("37.42") });
    expect((await plan()).summary.readyToAssign).toBe(before.summary.readyToAssign - $("100"));
    await expect(moveMoney(env.ctx, { month: MONTH, from: misc, to: misc, amount: 1n })).rejects.toBeInstanceOf(ValidationError);
    await expect(moveMoney(env.ctx, { month: MONTH, from: "rta", to: misc, amount: 0n })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("autoAssign", () => {
  beforeEach(async () => {
    await env.reseed();
  });

  it("underfunded leaves RTA ≥ 0 and is undone as one operation", async () => {
    const before = await plan();
    const s0 = await budgetState();
    expect(before.summary.readyToAssign).toBeGreaterThan(0n);
    const ops0 = (await env.db.select().from(budgetOperations)).length;
    const r = await autoAssign(env.ctx, { month: MONTH, mode: "underfunded" });
    expect(r.changes.length).toBeGreaterThan(0);
    const after = await plan();
    expect(after.summary.readyToAssign).toBeGreaterThanOrEqual(0n);
    expect(after.summary.readyToAssign).toBeLessThan(before.summary.readyToAssign);
    expect(after.summary.readyToAssign).toBe(before.summary.readyToAssign + r.rtaDelta);
    expect((await env.db.select().from(budgetOperations)).length).toBe(ops0 + 1);
    await undo(env.ctx, r.operationId!);
    expect(await budgetState()).toEqual(s0);
  });

  it("reset assigned on a selection", async () => {
    const gas = await catId("Gas");
    const r = await autoAssign(env.ctx, { month: MONTH, mode: "reset_assigned", categoryIds: [gas] });
    expect(r.changes).toHaveLength(1);
    expect((await cat("Gas")).assigned).toBe(0n);
  });
});

describe("targets", () => {
  beforeEach(async () => {
    await env.reseed();
  });

  it("editTarget writes a new effective_from row; earlier months keep the old target", async () => {
    const groceries = await catId("Groceries");
    const sepBefore = await getBudgetMonth(env.db, "2026-09-01", { today: TODAY });
    const g = (v: typeof sepBefore) => v.groups.flatMap((x) => x.categories).find((c) => c.id === groceries)!;
    const r = await editTarget(env.ctx, { categoryId: groceries, target: { type: "need_set_aside", amount: $("1000") } });
    expect(r.recomputedFrom).toBe(MONTH);
    const rows = await env.db.select().from(targets).where(eq(targets.categoryId, groceries)).orderBy(asc(targets.effectiveFrom));
    expect(rows.map((t) => t.effectiveFrom)).toEqual(["2025-05-01", MONTH]);
    expect((await cat("Groceries")).needed).toBe($("1000"));
    expect((await cat("Groceries")).target!.label).toBe("Set aside $1,000.00 each month");
    const sepAfter = await getBudgetMonth(env.db, "2026-09-01", { today: TODAY });
    expect(g(sepAfter).needed).toBe(g(sepBefore).needed);
    await undo(env.ctx, r.operationId!);
    expect((await env.db.select().from(targets).where(eq(targets.categoryId, groceries))).length).toBe(1);
    expect((await cat("Groceries")).needed).toBe($("950"));
  });

  it("removing a target leaves a tombstone", async () => {
    const gas = await catId("Gas");
    await editTarget(env.ctx, { categoryId: gas, target: null });
    const c = await cat("Gas");
    expect(c.target).toBeNull();
    expect(c.hasTarget).toBe(false);
    await expect(editTarget(env.ctx, { categoryId: gas, target: null })).rejects.toBeInstanceOf(ValidationError);
  });

  it("snooze zeroes needed for that month only", async () => {
    const gas = await catId("Gas");
    const r = await snoozeTarget(env.ctx, { categoryId: gas, month: MONTH });
    const c = await cat("Gas");
    expect(c.snoozed).toBe(true);
    expect(c.needed).toBe(0n);
    const nov = await getBudgetMonth(env.db, "2026-11-01", { today: TODAY });
    expect(nov.groups.flatMap((g) => g.categories).find((x) => x.id === gas)!.needed).toBe($("220"));
    await undo(env.ctx, r.operationId!);
    expect((await cat("Gas")).needed).toBe($("220"));
  });
});

describe("notes and categories", () => {
  beforeEach(async () => {
    await env.reseed();
  });

  it("month notes are undoable", async () => {
    const r = await setMonthNote(env.ctx, { month: MONTH, note: "Hello" });
    expect((await plan()).monthNote).toBe("Hello");
    await undo(env.ctx, r.operationId!);
    expect((await plan()).monthNote).toBe("Car registration due in November.");
    const gas = await catId("Gas");
    const r2 = await setMonthNote(env.ctx, { month: MONTH, categoryId: gas, note: "road trip" });
    expect((await cat("Gas")).monthNote).toBe("road trip");
    await undo(env.ctx, r2.operationId!);
    expect(await env.db.select().from(monthNotes).where(eq(monthNotes.categoryId, gas))).toHaveLength(0);
  });

  it("create, rename, hide, reorder — each undoable", async () => {
    const [needs] = await env.db.select().from(categoryGroups).where(eq(categoryGroups.name, "Needs"));
    const created = await createCategory(env.ctx, { groupId: needs!.id, name: "🧹 Cleaning" });
    expect((await plan()).groups.find((g) => g.id === needs!.id)!.categories.at(-1)!.name).toBe("🧹 Cleaning");
    const ren = await renameCategory(env.ctx, created.entityId, "🧽 Cleaning");
    expect((await cat("🧽 Cleaning")).id).toBe(created.entityId);
    await undo(env.ctx, ren.operationId!);
    expect((await cat("🧹 Cleaning")).id).toBe(created.entityId);
    await hideCategory(env.ctx, created.entityId);
    expect((await plan()).hidden.map((c) => c.id)).toContain(created.entityId);
    await unhideCategory(env.ctx, created.entityId);
    const ids = (await plan()).groups.find((g) => g.id === needs!.id)!.categories.map((c) => c.id);
    const reversed = [...ids].reverse();
    const ro = await reorderCategories(env.ctx, { groupId: needs!.id, categoryIds: reversed });
    expect((await plan()).groups.find((g) => g.id === needs!.id)!.categories.map((c) => c.id)).toEqual(reversed);
    await undo(env.ctx, ro.operationId!);
    expect((await plan()).groups.find((g) => g.id === needs!.id)!.categories.map((c) => c.id)).toEqual(ids);
    const [cc] = await env.db.select().from(categoryGroups).where(eq(categoryGroups.name, "Credit Card Payments"));
    await expect(createCategory(env.ctx, { groupId: cc!.id, name: "nope" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("mergeCategories recategorizes history and sums assignments", async () => {
    const dates = await catId("Dates");
    const ent = await catId("Entertainment");
    const v0 = await plan();
    const f = (v: typeof v0, id: string) => v.groups.flatMap((g) => g.categories).find((c) => c.id === id);
    const nTx = (await env.db.select({ id: transactions.id }).from(transactions).where(eq(transactions.categoryId, dates))).length;
    const r = await mergeCategories(env.ctx, { sourceId: dates, targetId: ent });
    expect(r.transactions).toBe(nTx);
    expect(await env.db.select().from(transactions).where(eq(transactions.categoryId, dates))).toHaveLength(0);
    expect(await env.db.select().from(monthAssignments).where(eq(monthAssignments.categoryId, dates))).toHaveLength(0);
    const v1 = await plan();
    expect(f(v1, dates)).toBeUndefined();
    expect(f(v1, ent)!.available).toBe(f(v0, ent)!.available + f(v0, dates)!.available);
    expect(v1.summary.readyToAssign).toBe(v0.summary.readyToAssign);
    const [src] = await env.db.select().from(categories).where(and(eq(categories.id, dates), isNotNull(categories.deletedAt)));
    expect(src).toBeDefined();
  });
});

describe("credit card payment category", () => {
  beforeEach(async () => {
    await env.reseed();
  });

  it("funded card spending moves money into P(K); unfunded spending is credit overspending", async () => {
    const [cashBack] = await env.db.select().from(accounts).where(eq(accounts.name, "Cash Back Card"));
    const before = await plan();
    const pay0 = before.groups[0]!.categories.find((c) => c.name === "Cash Back Card")!;
    const groceries0 = before.groups.flatMap((g) => g.categories).find((c) => c.name === "Groceries")!;
    expect(groceries0.available).toBeGreaterThan($("20"));
    await createTransaction(env.ctx, { accountId: cashBack!.id, date: "2026-10-21", amount: -$("20"), payeeName: "Kroger", categoryId: await catId("Groceries") });
    const mid = await plan();
    const pay1 = mid.groups[0]!.categories.find((c) => c.name === "Cash Back Card")!;
    expect(pay1.available - pay0.available).toBe($("20"));
    expect(pay1.activity - pay0.activity).toBe($("20"));
    // Misc is already overspent on credit: a further card purchase is unfunded
    await createTransaction(env.ctx, { accountId: cashBack!.id, date: "2026-10-21", amount: -$("10"), payeeName: "Lowe's", categoryId: await catId("Misc") });
    const after = await plan();
    const pay2 = after.groups[0]!.categories.find((c) => c.name === "Cash Back Card")!;
    expect(pay2.available).toBe(pay1.available);
    const misc = after.groups.flatMap((g) => g.categories).find((c) => c.name === "Misc")!;
    expect(misc.creditOverspend).toBe($("147.42"));
    expect(after.summary.readyToAssign).toBe(before.summary.readyToAssign);
  });
});

describe("assign ahead", () => {
  it("caches every month up to the new last assigned month", async () => {
    await env.reseed();
    await plan();
    const gas = await catId("Gas");
    const r = await assign(env.ctx, { month: "2027-01-01", categoryId: gas, amount: $("50") });
    expect(r.recomputedFrom).toBe("2026-12-01");
    const months = (await env.db.select({ m: budgetMonthSummary.month }).from(budgetMonthSummary)).map((x) => x.m).sort();
    expect(months.slice(-3)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    const dec = await getBudgetMonth(env.db, "2026-12-01", { today: TODAY });
    expect(dec.fromCache).toBe(true);
    expect((await plan()).summary.readyToAssign).toBe((await getBudgetMonth(env.db, "2027-01-01", { today: TODAY })).summary.readyToAssign);
    await undo(env.ctx, r.operationId!);
    const after = (await env.db.select({ m: budgetMonthSummary.month }).from(budgetMonthSummary)).map((x) => x.m).sort();
    expect(after.at(-1)).toBe("2026-11-01");
  });

  it("undoing a category creation fails cleanly once it has transactions", async () => {
    await env.reseed();
    const [needs] = await env.db.select().from(categoryGroups).where(eq(categoryGroups.name, "Needs"));
    const c = await createCategory(env.ctx, { groupId: needs!.id, name: "Temp" });
    const [checking] = await env.db.select().from(accounts).where(eq(accounts.name, "Checking"));
    await createTransaction(env.ctx, { accountId: checking!.id, date: "2026-10-21", amount: -$("5"), categoryId: c.entityId });
    await expect(undo(env.ctx, c.operationId!)).rejects.toBeInstanceOf(ConflictError);
  });
});
