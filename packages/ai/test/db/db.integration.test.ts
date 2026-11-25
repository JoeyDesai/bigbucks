import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { configureReadOnlyRole, schema as s } from "@homebase/db";
import {
  AiClient,
  collectAgentRun,
  executeConfirmedAction,
  rejectPendingAction,
  runAgent,
  runGuardedSql,
  type ActionExecutor,
  type AiToolContext,
  type ExecutedWrite,
} from "../../src";
import { CELL_TRUNCATED_MARKER } from "../../src/db/sqlExecutor";
import { SQL_MAX_CELL_CHARS, SQL_MAX_RESULT_BYTES } from "../../src/agent/sqlGuard";
import { createConversation, DbAgentRecorder, DbAuditSink, DbPendingActionStore, DbReadOnlySqlExecutor, DbUsageSink, loadConversationHistory, resolveReadOnlyDatabaseUrl } from "../../src/db";
import { FakeAnthropic, fakeMessage, textReply, toolUseBlock } from "../../src/testing";
import { prepareTestDb, RO_TEST_PASSWORD } from "./testDb";

const t = await prepareTestDb("ai");

describe.skipIf(!t)("ai DB stores (Postgres)", { timeout: 60_000 }, () => {
  const db = t!.db;
  const ro = t ? new DbReadOnlySqlExecutor(resolveReadOnlyDatabaseUrl({ DATABASE_URL: t.url, HOMEBASE_RO_PASSWORD: RO_TEST_PASSWORD })) : null;
  afterAll(async () => {
    await ro?.close();
    await t?.close();
  });

  const users = async () => db.select().from(s.users);

  it("DbUsageSink records ai_usage and sums the America/New_York month exactly", async () => {
    const sink = new DbUsageSink(db);
    const base = { purpose: "chat" as const, model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, batch: false, estimated: false, month: "2026-10-01" };
    await sink.record({ ...base, at: "2026-10-01T03:59:00Z", costMicroUsd: 999_999n }); // Sep 30 23:59 in New York
    await sink.record({ ...base, at: "2026-10-01T04:00:00Z", costMicroUsd: 1_234_567n }); // Oct 1 00:00 in New York
    await sink.record({ ...base, at: "2026-10-31T23:00:00Z", costMicroUsd: 1n });
    await sink.record({ ...base, at: "2026-11-01T04:00:00Z", costMicroUsd: 5n }); // Nov 1 00:00 NY
    expect(await sink.monthToDateMicroUsd("2026-10-01")).toBe(1_234_568n);
    expect(await sink.monthToDateMicroUsd("2026-09-01")).toBe(999_999n);
    const ai = new AiClient({ anthropic: new FakeAnthropic([]), usage: sink, now: () => new Date("2026-10-15T12:00:00Z"), capMicroUsd: 1_000_000n });
    expect((await ai.capStatus()).state).toBe("exceeded");
  });

  it("DbPendingActionStore: save/get and compare-and-set transitions; executeConfirmedAction audits", async () => {
    const [alex, sam] = await users();
    const conversationId = await createConversation(db, { userId: alex!.id, title: "test" });
    const store = new DbPendingActionStore(db);
    const action = { id: "0192f3a0-0000-7000-8000-00000000a001", tool: "remember" as const, input: { fact: "Costco is groceries" }, humanDiff: "Remember: “Costco is groceries”", status: "awaiting_confirmation" as const, createdAt: new Date().toISOString(), conversationId, toolUseId: "tu_1" };
    await store.save(action);
    expect(await store.get(action.id)).toMatchObject({ tool: "remember", status: "awaiting_confirmation", requestedBy: alex!.id, humanDiff: action.humanDiff, toolUseId: "tu_1" });

    const audit = new DbAuditSink(db);
    const runs: unknown[] = [];
    const handler = async (input: unknown): Promise<ExecutedWrite> => {
      runs.push(input);
      return { entity: "household_memory", entityId: "m1", after: { text: "Costco is groceries", n: 1n } };
    };
    const executor = Object.fromEntries(["recategorize", "split_transaction", "approve", "create_rule", "assign", "move_money", "auto_assign", "create_category", "update_target", "remember"].map((k) => [k, handler])) as unknown as ActionExecutor;
    const [r1, r2] = await Promise.allSettled([
      executeConfirmedAction({ actionId: action.id, confirmedBy: sam!.id, store, executor, audit }),
      executeConfirmedAction({ actionId: action.id, confirmedBy: sam!.id, store, executor, audit }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(runs).toHaveLength(1);
    expect((await store.get(action.id))?.status).toBe("confirmed");
    const [row] = await db.select().from(s.aiToolCalls).where(eq(s.aiToolCalls.id, action.id));
    expect(row).toMatchObject({ status: "confirmed", confirmedBy: sam!.id, error: null });
    expect(row!.confirmedAt).toBeInstanceOf(Date);
    const [log] = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "ai.remember"));
    expect(log).toMatchObject({ actor: "ai", userId: alex!.id, confirmedBy: sam!.id, entity: "household_memory", entityId: "m1", after: { text: "Costco is groceries", n: "1" } });

    // failure and cancel encodings
    const failing = { ...action, id: "0192f3a0-0000-7000-8000-00000000a002", toolUseId: "tu_2" };
    await store.save(failing);
    const bad = { ...executor, remember: async () => { throw new Error("boom"); } } as ActionExecutor;
    expect(await executeConfirmedAction({ actionId: failing.id, confirmedBy: sam!.id, store, executor: bad, audit })).toMatchObject({ status: "failed", error: "boom" });
    expect((await store.get(failing.id))?.status).toBe("failed");
    const cancel = { ...action, id: "0192f3a0-0000-7000-8000-00000000a003", toolUseId: "tu_3" };
    await store.save(cancel);
    expect(await rejectPendingAction(store, cancel.id, alex!.id)).toBe(true);
    expect(await rejectPendingAction(store, cancel.id, alex!.id)).toBe(false);
    expect((await store.get(cancel.id))?.status).toBe("rejected");
  });

  it("DbAgentRecorder persists messages and tool calls, linking the pending action to its message", async () => {
    const [alex] = await users();
    const conversationId = await createConversation(db, { userId: alex!.id });
    const recorder = new DbAgentRecorder(db, conversationId);
    const cats = await db.select().from(s.categories);
    const misc = cats.find((c) => c.name.includes("Misc"))!;
    const ctx = {
      async getOverview() {
        return { month: "2026-10-01", readyToAssign: 412_180n, overspent: [], unapprovedCount: 11, uncategorizedCount: 3, netWorth: 1n, lastSync: [] };
      },
      async getCategories() {
        return cats.map((c) => ({ id: c.id, name: c.name, group: "g", kind: c.kind }));
      },
    } as unknown as AiToolContext;
    const fake = new FakeAnthropic([
      fakeMessage({ content: [toolUseBlock("get_overview", {}, "tu_read"), toolUseBlock("remember", { fact: "Misc is for odds and ends" }, "tu_write"), toolUseBlock("get_budget_month", { month: "bad" }, "tu_err")] }),
      textReply(`Ready to Assign is $412.18. <speech>You have about four hundred dollars to assign.</speech>`),
    ]);
    const ai = new AiClient({ anthropic: fake, usage: new DbUsageSink(db), now: () => new Date("2026-10-22T16:00:00Z") });
    const { done } = await collectAgentRun(
      runAgent({ ai, ctx, actions: recorder.pendingActionStore(), recorder, conversationId, history: [], userMessage: "How much is left to assign?", prompt: { now: new Date(), speaker: { id: alex!.id, name: "Alex" }, householdMemory: [], categories: [], accounts: [] } }),
    );
    expect(done.stopReason).toBe("end_turn");
    void misc;
    const msgs = await db.select().from(s.aiMessages).where(eq(s.aiMessages.conversationId, conversationId)).orderBy(s.aiMessages.createdAt);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[1]!.model).toBe("claude-sonnet-5-5");
    expect(Number(msgs[1]!.costUsd)).toBeGreaterThan(0);
    const calls = await db.select().from(s.aiToolCalls).where(eq(s.aiToolCalls.conversationId, conversationId));
    expect(calls.map((c) => [c.toolUseId, c.status, c.messageId === msgs[1]!.id]).sort()).toEqual([
      ["tu_err", "auto", true],
      ["tu_read", "auto", true],
      ["tu_write", "awaiting_confirmation", true],
    ]);
    expect(calls.find((c) => c.toolUseId === "tu_err")!.error).toMatch(/Invalid input/);
    const usage = await db.select().from(s.aiUsage).where(eq(s.aiUsage.conversationId, conversationId));
    expect(usage).toHaveLength(2);
    expect(usage[0]!.userId).toBe(alex!.id);
    const history = await loadConversationHistory(db, conversationId);
    expect(history).toHaveLength(4);
  });

  it("DbReadOnlySqlExecutor runs as homebase_ro, read-only, views only, with a statement timeout", async () => {
    // homebase_ro is cluster-wide; another package's test run may have reset it to NOLOGIN.
    await configureReadOnlyRole(t!.pool, RO_TEST_PASSWORD);
    const ok = await runGuardedSql(ro!, "SELECT category_name, count(*) AS n FROM v_transactions_flat WHERE category_name IS NOT NULL GROUP BY 1 ORDER BY 2 DESC");
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.rowCount).toBeGreaterThan(5);
    expect(typeof ok.rows[0]!.n).toBe("string"); // int8 counts are plain strings, not money
    // Bypass the static guard to prove the database-side layers hold on their own:
    const opts = { timeoutMs: 1000, role: "homebase_ro" as const };
    await expect(ro!.runReadOnly("SELECT * FROM transactions LIMIT 1", opts)).rejects.toThrow(/permission denied/);
    // The executor only ever runs its input as a subquery, so non-SELECT input can't even parse.
    await expect(ro!.runReadOnly("CREATE TABLE x (a int)", opts)).rejects.toThrow(/syntax error|read-only transaction|permission denied/);
    await expect(ro!.runReadOnly("SELECT pg_sleep(3)", opts)).rejects.toThrow(/statement timeout/);
    // the connection is still healthy after errors
    expect((await ro!.runReadOnly("SELECT current_user AS u", opts)).rows[0]).toEqual({ u: "homebase_ro" });
  });

  it("DbReadOnlySqlExecutor caps cells server-side and the whole result at ~2 MB", async () => {
    await configureReadOnlyRole(t!.pool, RO_TEST_PASSWORD);
    const opts = { timeoutMs: 5000, role: "homebase_ro" as const };
    // Bypasses the guard (which rejects repeat()) to prove the executor bounds memory on its own.
    const big = await ro!.runReadOnly("SELECT n, repeat('x', 100000) AS big, array_fill(7, ARRAY[100000]) AS arr FROM generate_series(1, 600) n", opts);
    expect(big.truncatedBytes).toBe(true);
    expect(big.rows.length).toBeGreaterThan(10);
    expect(big.rows.length).toBeLessThan(600);
    expect(big.columns).toEqual(["n", "big", "arr"]);
    const first = big.rows[0]!;
    expect(first.n).toBe(1);
    expect(first.big).toBe(`${"x".repeat(SQL_MAX_CELL_CHARS)}${CELL_TRUNCATED_MARKER}`);
    expect(first.arr).toBeNull(); // non-text values over the cap are dropped, not cut
    const bytes = big.rows.reduce((a, r) => a + JSON.stringify(r).length, 0);
    expect(bytes).toBeLessThanOrEqual(SQL_MAX_RESULT_BYTES);
    // duplicate / anonymous column names survive the positional rename
    const dup = await ro!.runReadOnly("SELECT 1 + 1, 'a'::varchar AS v, 2::bigint AS v2", opts);
    expect(dup.rows).toEqual([{ "?column?": 2, v: "a", v2: 2n }]);
  });

  it("sql_query results are redacted by value, whatever the column is called (SELECT memo AS m)", async () => {
    await configureReadOnlyRole(t!.pool, RO_TEST_PASSWORD);
    const r = await runGuardedSql(ro!, "SELECT 'Card 4111 1111 ref 98765' AS m, date AS d, amount_milli AS a, to_char(date, 'YYYY-MM') AS ym FROM v_transactions_flat LIMIT 1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]!.m).toBe("Card •••• •••• ref ••••");
    expect(r.rows[0]!.d).toMatch(/^\d{4}-\d{2}-\d{2}$/); // dates are not masked
    expect(r.rows[0]!.ym).toMatch(/^\d{4}-\d{2}$/);
    expect(typeof r.rows[0]!.a).toBe("string"); // int8 → plain integer string, not masked
    expect(r.rows[0]!.a).toMatch(/^-?\d+$/);
  });

  it("resolves the read-only URL from env", () => {
    expect(resolveReadOnlyDatabaseUrl({ HOMEBASE_RO_DATABASE_URL: "postgres://x@h/db" })).toBe("postgres://x@h/db");
    expect(resolveReadOnlyDatabaseUrl({ DATABASE_URL: "postgres://homebase:secret@db:5432/homebase", HOMEBASE_RO_PASSWORD: "p@ss" })).toBe("postgres://homebase_ro:p%40ss@db:5432/homebase");
    expect(() => resolveReadOnlyDatabaseUrl({})).toThrow();
  });
});
