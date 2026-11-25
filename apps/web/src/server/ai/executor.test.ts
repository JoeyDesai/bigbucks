import { describe, expect, it } from "vitest";
import type { Ctx } from "@homebase/core";
import type { Db } from "@homebase/db";
import { createActionExecutor, type ExecutorDeps } from "./executor";

const REQ = "0192f3a0-0000-7000-8000-00000000000a";
const CONFIRM = "0192f3a0-0000-7000-8000-00000000000b";
const CAT = "0192f3a0-0000-7000-8000-0000000000c1";
const CAT2 = "0192f3a0-0000-7000-8000-0000000000c2";
const T1 = "0192f3a0-0000-7000-8000-0000000000f1";
const T2 = "0192f3a0-0000-7000-8000-0000000000f2";
const db = {} as Db;

type Call = { fn: string; ctx: Ctx; args: unknown[] };

function fakeDeps(over: Partial<ExecutorDeps> = {}): { deps: ExecutorDeps; calls: Call[] } {
  const calls: Call[] = [];
  const rec =
    <R>(fn: string, ret: R) =>
    async (ctx: Ctx, ...args: unknown[]) => {
      calls.push({ fn, ctx, args });
      return ret;
    };
  const deps: ExecutorDeps = {
    recategorize: async (ctx, ids, categoryId) => {
      calls.push({ fn: "recategorize", ctx, args: [ids, categoryId] });
      return { updated: ids, skipped: [], total: -1000n };
    },
    splitTransaction: rec("splitTransaction", { id: T1 }),
    getTransactionAmount: async () => ({ amount: -100_000n, categoryId: null, isSplit: false }),
    approveTransactions: async (ctx, ids) => {
      calls.push({ fn: "approve", ctx, args: [ids] });
      return { approved: ids };
    },
    assign: rec("assign", { operationId: "op1" }),
    moveMoney: rec("moveMoney", { operationId: "op2" }),
    autoAssign: rec("autoAssign", { operationId: "op3", changes: [1, 2, 3] }),
    listGroups: async () => [
      { id: "g-sys", name: "Credit Card Payments", isSystem: true },
      { id: "g1", name: "Wants", isSystem: false },
    ],
    createGroup: rec("createGroup", { entityId: "g-new" }),
    createCategory: rec("createCategory", { entityId: "c-new" }),
    editTarget: rec("editTarget", { operationId: "op4" }),
    addMemory: rec("addMemory", { id: "m1" }),
    insertRule: rec("insertRule", "rule-1"),
    loadRuleSubjects: async () => [
      { id: T1, payeeName: "Lowe's", payeeKey: "lowes", rawDescription: "LOWES #123", amountMilli: -50_000n, accountId: "a", date: "2026-10-02", categoryId: CAT2 },
      { id: T2, payeeName: "Lowe's", payeeKey: "lowes", rawDescription: "LOWES #123", amountMilli: -20_000n, accountId: "a", date: "2026-10-05", categoryId: CAT },
      { id: "t3", payeeName: "Target", payeeKey: "target", rawDescription: "TARGET", amountMilli: -20_000n, accountId: "a", date: "2026-10-05", categoryId: CAT2 },
    ],
    ...over,
  };
  return { deps, calls };
}

const meta = { actionId: "act1", confirmedBy: CONFIRM };

describe("createActionExecutor", () => {
  it("runs every write as actor=ai with the requester and the confirming user", async () => {
    const { deps, calls } = fakeDeps();
    const ex = createActionExecutor({ db, requestedBy: REQ, deps, today: "2026-10-22" });
    const r = await ex.recategorize({ transaction_ids: [T1, T1, T2], category_id: CAT }, meta);
    expect(calls[0]!.args).toEqual([[T1, T2], CAT]);
    expect(calls[0]!.ctx).toMatchObject({ actor: "ai", userId: REQ, confirmedBy: CONFIRM, today: "2026-10-22" });
    expect(r).toMatchObject({ entity: "transaction", summary: "Moved 2 transactions" });
  });

  it("maps Ready to Assign to core's rta endpoint and dollars to milli", async () => {
    const { deps, calls } = fakeDeps();
    const ex = createActionExecutor({ db, requestedBy: REQ, deps });
    await ex.move_money({ month: "2026-10", from_category_id: "ready_to_assign", to_category_id: CAT, amount: "612.40" }, meta);
    expect(calls[0]!.args[0]).toEqual({ month: "2026-10-01", from: "rta", to: CAT, amount: 612_400n });
  });

  it("assign: set uses an amount, add uses the +expr mini-language", async () => {
    const { deps, calls } = fakeDeps();
    const ex = createActionExecutor({ db, requestedBy: REQ, deps });
    await ex.assign({ month: "2026-10", category_id: CAT, amount: "50", mode: "set" }, meta);
    await ex.assign({ month: "2026-10-01", category_id: CAT, amount: "12.5", mode: "add" }, meta);
    expect(calls[0]!.args[0]).toEqual({ month: "2026-10-01", categoryId: CAT, amount: 50_000n });
    expect(calls[1]!.args[0]).toEqual({ month: "2026-10-01", categoryId: CAT, expr: "+12.5" });
  });

  it("split lines take the transaction's sign", async () => {
    const { deps, calls } = fakeDeps();
    const ex = createActionExecutor({ db, requestedBy: REQ, deps });
    await ex.split_transaction({ transaction_id: T1, lines: [{ category_id: CAT, amount: "60" }, { category_id: CAT2, amount: "40", memo: "kids" }] }, meta);
    expect(calls[0]!.args).toEqual([T1, [{ amount: -60_000n, categoryId: CAT, memo: null }, { amount: -40_000n, categoryId: CAT2, memo: "kids" }]]);
  });

  it("create_category reuses a group by name, or creates it", async () => {
    const { deps, calls } = fakeDeps();
    const ex = createActionExecutor({ db, requestedBy: REQ, deps });
    await ex.create_category({ group: "wants", name: "Hobbies" }, meta);
    expect(calls.map((c) => c.fn)).toEqual(["createCategory"]);
    expect(calls[0]!.args[0]).toEqual({ groupId: "g1", name: "Hobbies" });
    await ex.create_category({ group: "Kids", name: "Diapers" }, meta);
    expect(calls.slice(1).map((c) => c.fn)).toEqual(["createGroup", "createCategory"]);
    expect(calls[2]!.args[0]).toEqual({ groupId: "g-new", name: "Diapers" });
  });

  it("update_target converts dollar strings and snake_case fields", async () => {
    const { deps, calls } = fakeDeps();
    const ex = createActionExecutor({ db, requestedBy: REQ, deps });
    await ex.update_target({ category_id: CAT, target: { type: "need_set_aside", amount: "450", cadence: "monthly", day: 25 } }, meta);
    expect(calls[0]!.args[0]).toEqual({ categoryId: CAT, target: { type: "need_set_aside", amount: 450_000n, cadence: "monthly", day: 25 } });
  });

  it("create_rule stores the canonical rule and applies it to matching rows whose category differs", async () => {
    const { deps, calls } = fakeDeps();
    const ex = createActionExecutor({ db, requestedBy: REQ, deps });
    const r = await ex.create_rule({ payee_contains: "Lowe", category_id: CAT, apply_to_existing: true }, meta);
    const insert = calls.find((c) => c.fn === "insertRule")!;
    expect(insert.args[0]).toMatchObject({ name: "Lowe", rule: { conditions: [{ field: "payee", op: "contains", value: "Lowe" }], actions: { setCategoryId: CAT } } });
    const recat = calls.find((c) => c.fn === "recategorize")!;
    expect(recat.args).toEqual([[T1], CAT]);
    expect(r).toMatchObject({ entity: "rule", entityId: "rule-1", summary: "Rule created and applied to 1" });
  });

  it("remember, approve and auto_assign pass through", async () => {
    const { deps, calls } = fakeDeps();
    const ex = createActionExecutor({ db, requestedBy: REQ, deps });
    await ex.remember({ fact: "  Costco runs are groceries " }, meta);
    await ex.approve({ transaction_ids: [T1] }, meta);
    const aa = await ex.auto_assign({ month: "2026-10", mode: "underfunded" }, meta);
    expect(calls.map((c) => c.fn)).toEqual(["addMemory", "approve", "autoAssign"]);
    expect(calls[0]!.args[0]).toBe("Costco runs are groceries");
    expect(calls[2]!.args[0]).toEqual({ month: "2026-10-01", mode: "underfunded" });
    expect(aa.summary).toBe("3 categories changed");
  });

  it("a recategorize that changes nothing fails (so the card shows failed, not done)", async () => {
    const { deps } = fakeDeps({ recategorize: async () => ({ updated: [], skipped: [{ id: T1, reason: "split" }], total: 0n }) });
    const ex = createActionExecutor({ db, requestedBy: REQ, deps });
    await expect(ex.recategorize({ transaction_ids: [T1], category_id: CAT }, meta)).rejects.toThrow(/Nothing changed: split/);
  });
});
