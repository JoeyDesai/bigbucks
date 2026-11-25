import { describe, expect, it } from "vitest";
import {
  AiClient,
  collectAgentRun,
  executeConfirmedAction,
  InMemoryUsageSink,
  rejectPendingAction,
  runAgent,
  toolDefinitions,
  toSseFrame,
  buildAgentSystem,
  PendingActionError,
  SpeechExtractor,
  speechFromMarkdown,
  MASK,
  type ActionExecutor,
  type AgentEvent,
  type AiToolContext,
  type ExecutedWrite,
  type RunAgentOptions,
  type BetaToolResultBlockParam,
} from "../src";
import { FakeAnthropic, fakeMessage, textBlock, textReply, toolUseBlock, InMemoryAuditSink, InMemoryPendingActionStore, type FakeResponder, type FakeResponse } from "../src/testing";

const now = () => new Date("2026-10-22T16:30:00Z");

function makeCtx(overrides: Partial<AiToolContext> = {}) {
  const calls: string[] = [];
  const ctx: AiToolContext = {
    async getOverview() {
      calls.push("getOverview");
      return { month: "2026-10-01", readyToAssign: 1_250_000n, overspent: [], unapprovedCount: 3, uncategorizedCount: 1, netWorth: 512_000_000n, lastSync: [] };
    },
    async getBudgetMonth(month) {
      calls.push(`getBudgetMonth:${month}`);
      return {
        month,
        readyToAssign: 0n,
        categories: [{ categoryId: "c-groc", group: "Everyday", category: "Groceries", assigned: 350_000n, activity: -200_000n, available: 150_000n, target: null }],
      };
    },
    async queryTransactions(f) {
      calls.push(`queryTransactions:${JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      return {
        rows: [{ id: "t1", date: "2026-10-03", account: "Contoso card", payee: "Lowe's", category: "Misc", categoryId: "c-misc", amount: -312_400n, memo: "order 99887766", approved: true, cleared: "cleared", isSplit: false, isTransfer: false }],
        totalCount: 1,
        totals: { inflow: 0n, outflow: -312_400n, net: -312_400n },
      };
    },
    async spendingSummary(a) {
      calls.push("spendingSummary");
      return { startDate: a.startDate, endDate: a.endDate, groupBy: a.groupBy, rows: [{ key: "c-dining", label: "Dining Out", outflow: -812_000n, inflow: 0n, net: -812_000n, count: 31 }], total: { outflow: -812_000n, inflow: 0n, net: -812_000n } };
    },
    async netWorth() {
      return { points: [] };
    },
    async holdings() {
      return { asOf: null, holdings: [], total: 0n };
    },
    sql: {
      async runReadOnly() {
        calls.push("sql");
        return { columns: ["n"], rows: [{ n: 1 }] };
      },
    },
    async getMerchantProfile() {
      return null;
    },
    async saveMerchantProfile() {},
    async saveReport() {
      return { id: "r1" };
    },
    async getTransactionsByIds(ids) {
      // 14 transactions totalling $612.40 (t1 = $44.30, the rest $43.70)
      const all = Array.from({ length: 14 }, (_, i) => ({ id: `t${i + 1}`, date: "2026-10-01", payee: "Lowe's", amount: i === 0 ? -44_300n : -43_700n, categoryId: "c-misc", isSplit: false, approved: false }));
      return all.filter((t) => ids.includes(t.id));
    },
    async getCategories() {
      return [
        { id: "c-misc", name: "Misc", group: "Everyday", kind: "normal" },
        { id: "c-house", name: "House Projects", group: "Home", kind: "normal" },
        { id: "c-groc", name: "Groceries", group: "Everyday", kind: "normal" },
      ];
    },
    ...overrides,
  };
  return { ctx, calls };
}

const prompt: RunAgentOptions["prompt"] = {
  now: now(),
  speaker: { id: "u-alex", name: "Alex" },
  householdMemory: ["Costco runs are mostly groceries"],
  categories: [
    { id: "c-misc", name: "Misc", group: "Everyday", kind: "normal" },
    { id: "c-house", name: "House Projects", group: "Home", kind: "normal" },
  ],
  accounts: [{ id: "a1", name: "Contoso Checking 4421", kind: "checking", onBudget: true, entity: "Household" }],
};

function setup(responder: FakeResponder | FakeResponse[], usageSeed: Record<string, bigint> = {}) {
  const fake = new FakeAnthropic(responder);
  const usage = new InMemoryUsageSink(usageSeed);
  const ai = new AiClient({ anthropic: fake, usage, now });
  const store = new InMemoryPendingActionStore();
  const { ctx, calls } = makeCtx();
  const run = (userMessage: string, extra: Partial<RunAgentOptions> = {}) =>
    collectAgentRun(runAgent({ ai, ctx, actions: store, prompt, history: [], userMessage, ...extra }));
  return { fake, usage, ai, store, ctx, calls, run };
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe("agent loop", () => {
  it("round-trips tool_use → tool_result and streams the final text + speech", async () => {
    const { fake, run, calls, usage } = setup([
      fakeMessage({ content: [textBlock("Checking. "), toolUseBlock("spending_summary", { group_by: "category", start_date: "2026-01-01", end_date: "2026-10-22" }, "tu_1")] }),
      textReply("You spent **$812.00** on Dining Out from Jan 1 to Oct 22, 2026.<speech>You spent eight hundred twelve dollars eating out this year.</speech>"),
    ]);
    const { events, done } = await run("How much did we spend eating out this year?");
    expect(types(events)).toEqual(expect.arrayContaining(["text_delta", "tool_call", "tool_result", "done"]));
    expect(calls).toContain("spendingSummary");
    expect(fake.calls).toHaveLength(2);
    // second request carries the tool_result for tu_1, with dollars formatted for the model
    const second = fake.calls[1]!.params.messages;
    const last = second[second.length - 1]!;
    const tr = (last.content as BetaToolResultBlockParam[])[0]!;
    expect(tr).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(String(tr.content)).toContain('"-$812.00"');
    expect(done.stopReason).toBe("end_turn");
    expect(done.text).toBe("Checking. You spent **$812.00** on Dining Out from Jan 1 to Oct 22, 2026.");
    expect(done.text).not.toContain("<speech>");
    expect(done.speech).toBe("You spent eight hundred twelve dollars eating out this year.");
    const streamed = events.filter((e): e is Extract<AgentEvent, { type: "text_delta" }> => e.type === "text_delta").map((e) => e.text).join("");
    expect(streamed).toBe(done.text);
    expect(done.toolIterations).toBe(1);
    expect(done.newMessages).toHaveLength(4); // user, assistant(tool_use), user(tool_result), assistant
    expect(usage.records.map((r) => r.purpose)).toEqual(["chat", "chat"]);
  });

  it("sends system + tools with cache breakpoints, Sonnet by default, Opus in deep mode, and the refusal fallback", async () => {
    const { fake, run } = setup([textReply("Hi.<speech>Hi.</speech>"), textReply("Hi.")]);
    await run("hello");
    const p = fake.calls[0]!.params;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.fallbacks).toBe("default");
    expect(p.cache_control).toEqual({ type: "ephemeral" });
    const tools = p.tools as { name: string; cache_control?: unknown }[];
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(tools.filter((t) => t.cache_control)).toHaveLength(1);
    const sys = p.system as { text: string; cache_control?: unknown }[];
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(sys[1]!.text).toContain("Today is Thursday 2026-10-22");
    expect(sys[1]!.text).toContain("You are talking with Alex.");
    await run("deep", { deep: true });
    expect(fake.calls[1]!.params.model).toBe("claude-opus-5-5");
    expect(fake.calls[1]!.params.output_config?.effort).toBe("high");
  });

  it("caps tool iterations at 12, then forces a final answer with tool_choice none", async () => {
    let n = 0;
    const responder: FakeResponder = (params) => {
      if (params.tool_choice?.type === "none") return textReply("I checked a lot but could not finish. <speech>I ran out of steps.</speech>");
      n++;
      return fakeMessage({ content: [toolUseBlock("get_overview", {}, `tu_${n}`)] });
    };
    const { fake, run, calls } = setup(responder);
    const { done, events } = await run("loop forever");
    expect(calls.filter((c) => c === "getOverview")).toHaveLength(12);
    expect(done.toolIterations).toBe(12);
    expect(done.stopReason).toBe("iteration_cap");
    expect(fake.calls).toHaveLength(13);
    expect(fake.calls[12]!.params.tool_choice).toEqual({ type: "none" });
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(12);
    expect(done.speech).toBe("I ran out of steps.");
  });

  it("write tools create pending action cards and never execute", async () => {
    const executed: string[] = [];
    const { run, store } = setup([
      fakeMessage({
        content: [toolUseBlock("recategorize", { transaction_ids: Array.from({ length: 14 }, (_, i) => `t${i + 1}`), category_id: "c-house" }, "tu_w")],
      }),
      textReply("Ready to confirm: move 14 Lowe's transactions to House Projects.<speech>It's ready for you to confirm.</speech>"),
    ]);
    const { events, done } = await run("Categorize everything from Lowe's this month as House Projects");
    const pending = events.find((e): e is Extract<AgentEvent, { type: "pending_action" }> => e.type === "pending_action");
    expect(pending?.action.humanDiff).toBe("Move 14 transactions ($612.40) from Misc → House Projects");
    expect(pending?.action.status).toBe("awaiting_confirmation");
    expect(pending?.action.requestedBy).toBe("u-alex");
    expect(done.pendingActionIds).toEqual([pending!.action.id]);
    expect(executed).toEqual([]);
    const stored = await store.get(pending!.action.id);
    expect(stored?.status).toBe("awaiting_confirmation");
    const toolResultMsg = done.newMessages[2]!.content as BetaToolResultBlockParam[];
    expect(String(toolResultMsg[0]!.content)).toContain("awaiting_user_confirmation");
  });

  it("returns validation errors to the model as is_error tool results", async () => {
    const { fake, run } = setup([
      fakeMessage({ content: [toolUseBlock("recategorize", { transaction_ids: ["t1"], category_id: "nope" }, "tu_bad"), toolUseBlock("get_budget_month", { month: "October" }, "tu_bad2")] }),
      textReply("Sorry."),
    ]);
    const { events } = await run("x");
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results.map((r) => r.isError)).toEqual([true, true]);
    expect(results[0]!.summary).toContain("Unknown category id nope");
    const trs = fake.calls[1]!.params.messages.at(-1)!.content as BetaToolResultBlockParam[];
    expect(trs).toHaveLength(2); // both results in one user message
    expect(trs.every((t) => t.is_error)).toBe(true);
  });

  it("redacts free text in read-tool results before they reach the model", async () => {
    const { fake, run } = setup([fakeMessage({ content: [toolUseBlock("query_transactions", { payee_text: "Lowe's" }, "tu_q")] }), textReply("ok")]);
    await run("x");
    const tr = (fake.calls[1]!.params.messages.at(-1)!.content as BetaToolResultBlockParam[])[0]!;
    expect(String(tr.content)).toContain(`order ${MASK}`);
    expect(String(tr.content)).not.toContain("99887766");
  });

  it("emits chart events from render_chart and runs sql_query through the guard", async () => {
    const spec = { type: "pie", title: "September spending", format: "currency", series: [{ name: "Spending", data: [{ x: "Groceries", y: 812.4 }] }] };
    const { run, calls } = setup([
      fakeMessage({ content: [toolUseBlock("render_chart", { spec }, "tu_c"), toolUseBlock("sql_query", { sql: "DELETE FROM transactions" }, "tu_s")] }),
      textReply("Here you go."),
    ]);
    const { events } = await run("Where did our money go in September?");
    const chart = events.find((e) => e.type === "chart");
    expect(chart).toMatchObject({ type: "chart", spec: { type: "pie" } });
    const sqlRes = events.find((e) => e.type === "tool_result" && e.name === "sql_query");
    expect(sqlRes).toMatchObject({ isError: true });
    expect(calls).not.toContain("sql");
  });

  it("is disabled at the monthly cap", async () => {
    const { fake, run } = setup([], { "2026-10-01": 8_000_000n });
    const { events, done } = await run("hi");
    expect(events[0]).toMatchObject({ type: "error", code: "cap_exceeded" });
    expect(done.stopReason).toBe("cap_exceeded");
    expect(fake.calls).toHaveLength(0);
  });

  it("stops on refusal without running tools", async () => {
    const { run } = setup([fakeMessage({ content: [], stop_reason: "refusal" })]);
    const { done, events } = await run("x");
    expect(done.stopReason).toBe("refusal");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("closes tool_use blocks it did not run on max_tokens so history stays valid", async () => {
    const { run, calls } = setup([fakeMessage({ content: [toolUseBlock("get_overview", {}, "tu_x")], stop_reason: "max_tokens" })]);
    const { done } = await run("x");
    expect(done.stopReason).toBe("max_tokens");
    expect(calls).not.toContain("getOverview");
    const closing = done.newMessages.at(-1)!.content as BetaToolResultBlockParam[];
    expect(closing[0]).toMatchObject({ tool_use_id: "tu_x", is_error: true });
  });

  it("re-issues a turn when the stream fails on unparseable tool JSON (bounded)", async () => {
    const { fake, run } = setup([new SyntaxError("Unexpected token"), textReply("ok")]);
    const { done } = await run("x");
    expect(done.stopReason).toBe("end_turn");
    expect(fake.calls).toHaveLength(2);
  });

  it("serializes events for SSE", () => {
    const frame = toSseFrame({ type: "tool_result", id: "a", name: "x", summary: "s", isError: false });
    expect(frame).toBe('event: tool_result\ndata: {"type":"tool_result","id":"a","name":"x","summary":"s","isError":false}\n\n');
    expect(toSseFrame({ type: "done", stopReason: "end_turn", text: "", speech: "", toolIterations: 0, requests: 1, newMessages: [], pendingActionIds: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costMicroUsd: 5n } })).toContain('"costMicroUsd":"5"');
  });
});

describe("tool definitions", () => {
  it("defines every §11.3 tool once with object schemas", () => {
    const names = toolDefinitions().map((t) => t.name);
    expect(names).toEqual([
      "get_overview", "get_budget_month", "query_transactions", "spending_summary", "net_worth", "holdings", "sql_query", "lookup_merchant", "render_chart", "save_report",
      "recategorize", "split_transaction", "approve", "create_rule", "assign", "move_money", "auto_assign", "create_category", "update_target", "remember",
    ]);
    for (const t of toolDefinitions()) expect(t.input_schema.type).toBe("object");
    expect(JSON.stringify(toolDefinitions())).toBe(JSON.stringify(toolDefinitions())); // deterministic (cache-stable)
  });

  it("redacts account numbers from the system prompt", () => {
    const sys = buildAgentSystem(prompt);
    expect(sys[0]!.text).toContain(`Contoso Checking ${MASK}`);
    expect(sys[0]!.text).toContain("Never state a number without getting it from a tool");
  });
});

describe("executeConfirmedAction", () => {
  async function pendingRecategorize() {
    const s = setup([
      fakeMessage({ content: [toolUseBlock("recategorize", { transaction_ids: ["t1", "t2"], category_id: "c-house" }, "tu_w")] }),
      textReply("Ready to confirm."),
    ]);
    const { done } = await s.run("move them");
    return { ...s, actionId: done.pendingActionIds[0]! };
  }

  function executor(log: unknown[]): ActionExecutor {
    const handler = async (input: unknown): Promise<ExecutedWrite> => {
      log.push(input);
      return { entity: "transactions", entityId: null, before: { category: "c-misc" }, after: { category: "c-house" }, summary: "Moved 2" };
    };
    return {
      recategorize: handler, split_transaction: handler, approve: handler, create_rule: handler, assign: handler, move_money: handler,
      auto_assign: handler, create_category: handler, update_target: handler, remember: handler,
    };
  }

  it("runs the executor once and audits actor=ai, confirmed_by=user", async () => {
    const { store, actionId } = await pendingRecategorize();
    const log: unknown[] = [];
    const audit = new InMemoryAuditSink();
    const r = await executeConfirmedAction({ actionId, confirmedBy: "u-sam", store, executor: executor(log), audit, now });
    expect(r.status).toBe("confirmed");
    expect(log).toEqual([{ transaction_ids: ["t1", "t2"], category_id: "c-house" }]);
    expect(audit.entries).toEqual([
      { at: "2026-10-22T16:30:00.000Z", userId: "u-alex", actor: "ai", confirmedBy: "u-sam", action: "ai.recategorize", entity: "transactions", entityId: null, before: { category: "c-misc" }, after: { category: "c-house" } },
    ]);
    expect((await store.get(actionId))?.status).toBe("confirmed");
    // a confirmation applies to that card only — a second confirm is refused
    await expect(executeConfirmedAction({ actionId, confirmedBy: "u-sam", store, executor: executor(log), audit })).rejects.toBeInstanceOf(PendingActionError);
    expect(log).toHaveLength(1);
  });

  it("cancel prevents execution; executor failures mark the card failed without audit", async () => {
    const a = await pendingRecategorize();
    expect(await rejectPendingAction(a.store, a.actionId, "u-alex")).toBe(true);
    await expect(executeConfirmedAction({ actionId: a.actionId, confirmedBy: "u-alex", store: a.store, executor: executor([]), audit: new InMemoryAuditSink() })).rejects.toThrow(/rejected/);

    const b = await pendingRecategorize();
    const audit = new InMemoryAuditSink();
    const failing = { ...executor([]), recategorize: async () => { throw new Error("db down"); } };
    const r = await executeConfirmedAction({ actionId: b.actionId, confirmedBy: "u-alex", store: b.store, executor: failing, audit });
    expect(r).toMatchObject({ status: "failed", error: "db down" });
    expect(audit.entries).toHaveLength(0);
    expect((await b.store.get(b.actionId))?.status).toBe("failed");
  });

  it("validates edited input against the tool schema", async () => {
    const { store, actionId } = await pendingRecategorize();
    await expect(
      executeConfirmedAction({ actionId, confirmedBy: "u", store, executor: executor([]), audit: new InMemoryAuditSink(), editedInput: { transaction_ids: [] } }),
    ).rejects.toThrow(/Invalid input/);
  });
});

describe("pending action diffs", () => {
  async function diffFor(tool: string, input: unknown) {
    const s = setup([fakeMessage({ content: [toolUseBlock(tool, input, "tu")] }), textReply("ok")]);
    const { events } = await s.run("x");
    const p = events.find((e): e is Extract<AgentEvent, { type: "pending_action" }> => e.type === "pending_action");
    const err = events.find((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result" && e.isError);
    return p?.action.humanDiff ?? `ERROR: ${err?.summary}`;
  }

  it.each([
    ["move_money", { month: "2026-10", from_category_id: "c-misc", to_category_id: "c-groc", amount: "150" }, "Move $150.00 from Misc → Groceries (October 2026)"],
    ["move_money", { month: "2026-10", from_category_id: "ready_to_assign", to_category_id: "c-groc", amount: "20.5" }, "Move $20.50 from Ready to Assign → Groceries (October 2026)"],
    ["assign", { month: "2026-10", category_id: "c-groc", amount: "200", mode: "add" }, "Assign $200.00 more to Groceries for October 2026 (Assigned $350.00 → $550.00)"],
    ["approve", { transaction_ids: ["t1", "t2"] }, "Approve 2 transactions ($88.00)"],
    ["create_rule", { payee_contains: "Lowe's", category_id: "c-house", apply_to_existing: false }, "Create rule: payee contains “Lowe's” → House Projects"],
    ["create_category", { group: "Home", name: "Pet Care" }, "Create category “Pet Care” in Home"],
    ["remember", { fact: "Costco runs are mostly groceries" }, "Remember: “Costco runs are mostly groceries”"],
    ["update_target", { category_id: "c-groc", target: { type: "need_refill", amount: "900", cadence: "monthly" } }, "Set target for Groceries: need refill, $900.00, monthly"],
    ["auto_assign", { month: "2026-10", mode: "underfunded" }, "Auto-assign (underfunded) for October 2026, all categories"],
    ["split_transaction", { transaction_id: "t2", lines: [{ category_id: "c-groc", amount: "40" }, { category_id: "c-house", amount: "3.70" }] }, "Split Lowe's $43.70 (2026-10-01) into Groceries $40.00 + House Projects $3.70"],
    ["split_transaction", { transaction_id: "t2", lines: [{ category_id: "c-groc", amount: "40" }, { category_id: "c-house", amount: "1" }] }, "ERROR: Split lines add up to $41.00 but the transaction is $43.70"],
    ["move_money", { month: "2026-10", from_category_id: "c-misc", to_category_id: "c-misc", amount: "1" }, "ERROR: from and to must differ"],
    ["assign", { month: "2026-10", category_id: "c-groc", amount: "12.345", mode: "set" }, "ERROR: Invalid input"],
  ])("%s %j", async (tool, input, expected) => {
    const d = await diffFor(tool, input);
    if (expected.startsWith("ERROR: Invalid input")) expect(d).toMatch(/^ERROR: Invalid input/);
    else expect(d).toBe(expected);
  });
});

describe("speech", () => {
  it("extracts a speech tag split across deltas", () => {
    const s = new SpeechExtractor();
    let shown = "";
    for (const d of ["Total is $5.", " <sp", "eech>Five dol", "lars.</spe", "ech>"]) shown += s.push(d);
    shown += s.flush();
    expect(shown).toBe("Total is $5. ");
    expect(s.speech).toBe("Five dollars.");
  });
  it("derives speech from markdown when the tag is missing", () => {
    expect(speechFromMarkdown("**$612.40** spent at Lowe's in October.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nWant a chart? Extra.")).toBe(
      "$612.40 spent at Lowe's in October. Want a chart?",
    );
  });
});
