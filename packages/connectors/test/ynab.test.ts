import { describe, expect, it } from "vitest";
import { createSlidingWindowLimiter, createYnabClient, mapGoalCadence, mapGoalType, mapYnabMonthDetail, mapYnabPlan } from "../src/ynab";
import { fixtureJson, json, mockFetch } from "./helpers";

const exportJson = fixtureJson<{ data: { plan: Record<string, unknown>; server_knowledge: number } }>("ynab-plan-synthetic.json");

describe("YNAB client (GET only, /plans paths)", () => {
  it("lists plans, finds My Budget, exports the full plan, then deltas", async () => {
    const { fetch, calls } = mockFetch((u) => {
      if (u.pathname === "/v1/plans") return json({ data: { plans: [{ id: "plan-0001", name: "My Budget" }, { id: "p2", name: "Old" }], default_plan: null } }, 200, { "x-rate-limit": "3/200" });
      if (u.pathname === "/v1/plans/plan-0001") return json(exportJson);
      if (u.pathname === "/v1/plans/plan-0001/months/2026-10-01") return json({ data: { month: (exportJson.data.plan.months as unknown[])[1] } });
      if (u.pathname === "/v1/plans/plan-0001/transactions") return json({ data: { transactions: [], server_knowledge: 4243 } });
      return undefined;
    });
    const c = createYnabClient("pat-SECRET", { http: { fetch } });
    expect(await c.findPlanByName("My Budget")).toMatchObject({ id: "plan-0001" });
    const full = await c.getPlanExport("plan-0001");
    expect(full.server_knowledge).toBe(4242);
    await c.getPlanExport("plan-0001", 4242);
    const month = await c.getMonth("plan-0001", "2026-10-01");
    await c.getTransactions("plan-0001", { lastKnowledgeOfServer: 4242 });
    expect(calls.map((x) => x.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);
    expect(calls.every((x) => x.headers.authorization === "Bearer pat-SECRET")).toBe(true);
    expect(new URL(calls[1]!.url).searchParams.has("last_knowledge_of_server")).toBe(false);
    expect(new URL(calls[2]!.url).searchParams.get("last_knowledge_of_server")).toBe("4242");
    expect(new URL(calls[4]!.url).searchParams.get("last_knowledge_of_server")).toBe("4242");
    expect(calls.every((x) => !x.url.includes("/budgets"))).toBe(true);
    const m = mapYnabMonthDetail({ data: month });
    expect(m.summary).toMatchObject({ month: "2026-10-01", toBeBudgeted: 1_250_000n });
    expect(m.assignments.find((a) => a.categoryYnabId === "c-giving")!.budgeted).toBe(500_000n);
  });

  it("falls back to legacy `budget` envelopes", async () => {
    const { fetch } = mockFetch(() => json({ data: { budget: exportJson.data.plan, server_knowledge: 7 } }));
    const r = await createYnabClient("t", { http: { fetch } }).getPlanExport("plan-0001");
    expect(mapYnabPlan(r).plan.name).toBe("My Budget");
  });
});

describe("200 req/hour limiter", () => {
  it("allows 200 in a rolling hour, then waits for the oldest to expire", async () => {
    let now = 0;
    const slept: number[] = [];
    const l = createSlidingWindowLimiter({ now: () => now, sleep: async (ms) => void (slept.push(ms), (now += ms)) });
    for (let i = 0; i < 200; i++) {
      now += 1000;
      expect(l.tryAcquire()).toBe(true);
    }
    expect(l.tryAcquire()).toBe(false);
    expect(l.remaining()).toBe(0);
    await l.acquire();
    expect(slept).toHaveLength(1);
    expect(now).toBe(1000 + 3_600_000 + 1);
  });

  it("respects the server's X-Rate-Limit header", () => {
    const l = createSlidingWindowLimiter({ now: () => 0 });
    l.observeHeader("199/200");
    expect(l.remaining()).toBe(1);
    expect(l.tryAcquire()).toBe(true);
    expect(l.tryAcquire()).toBe(false);
  });
});

describe("mapYnabPlan", () => {
  const b = mapYnabPlan(exportJson);

  it("plan + server knowledge", () => {
    expect(b.plan).toEqual({ ynabId: "plan-0001", name: "My Budget", lastModifiedOn: "2026-10-22T13:00:00+00:00", firstMonth: "2024-01-01", lastMonth: "2026-11-01" });
    expect(b.serverKnowledge).toBe(4242);
    expect(b.warnings).toEqual([]);
  });

  it("accounts: kinds, on-budget/tracking, closed, milli balances", () => {
    expect(b.accounts.map((a) => [a.name, a.kind, a.onBudget, a.closed])).toEqual([
      ["Checking", "checking", true, false],
      ["Savings", "savings", true, false],
      ["Cash Back Card", "credit_card", true, false],
      ["Rewards Card", "credit_card", true, false],
      ["Old Visa", "credit_card", true, true],
      ["Maple St Mortgage", "mortgage", false, false],
    ]);
    expect(b.accounts[0]!.balance).toBe(4_210_550n);
    expect(b.accounts[5]!.balance).toBe(-281_000_000n);
  });

  it("groups + categories: emoji kept, system categories identified, cc_payment linked", () => {
    expect(b.system).toEqual({ readyToAssignCategoryId: "c-rta", uncategorizedCategoryId: "c-uncat", creditCardPaymentsGroupId: "g-cc", internalGroupId: "g-int" });
    const cat = Object.fromEntries(b.categories.map((c) => [c.ynabId, c]));
    expect(cat["c-rta"]!.kind).toBe("internal_rta");
    expect(cat["c-uncat"]!.kind).toBe("uncategorized");
    expect(cat["c-cc-fab"]).toMatchObject({ kind: "cc_payment", linkedAccountYnabId: "a-fab" });
    expect(cat["c-cc-co"]).toMatchObject({ kind: "cc_payment", linkedAccountYnabId: "a-co" });
    expect(cat["c-mort"]).toMatchObject({ name: "🏠 Mortgage", kind: "normal", note: "Maple St" });
    expect(cat["c-giving"]!.name).toBe("🤝 Giving");
    expect(cat["c-house"]).toMatchObject({ hidden: true });
    expect(b.groups.find((g) => g.ynabId === "g-hidden")!.hidden).toBe(true);
  });

  it("targets per §10 mapping, with cadence and effective_from", () => {
    const t = Object.fromEntries(b.targets.map((x) => [x.categoryYnabId, x]));
    expect(t["c-mort"]).toMatchObject({ type: "need_set_aside", amount: 1_896_200n, cadence: "monthly", cadenceFrequency: 1, effectiveFrom: "2024-01-01", ynabUnderFunded: 0n });
    expect(t["c-groc"]).toMatchObject({ type: "need_refill", amount: 900_000n });
    expect(t["c-giving"]).toMatchObject({ type: "need_set_aside", amount: 500_000n });
    expect(t["c-ynab"]).toMatchObject({ type: "need_set_aside", cadence: "yearly", cadenceFrequency: 1, day: 15, targetDate: "2027-01-15", ynabUnderFunded: 9_080n });
    expect(t["c-gifts"]).toMatchObject({ type: "balance_by_date", targetDate: "2026-12-01", cadence: "none" });
    expect(t["c-sav"]).toMatchObject({ type: "balance", amount: 10_000_000n });
    expect(t["c-extra"]).toMatchObject({ type: "monthly_builder" });
    expect(t["c-car"]).toMatchObject({ type: "debt", amount: 350_000n });
    expect(t["c-water"]).toMatchObject({ cadence: "every_n_months", cadenceFrequency: 3, ynabCadence: 4 });
    expect(t["c-gas"]).toMatchObject({ cadence: "weekly", day: 5, snoozedAt: "2026-10-02T12:00:00Z" });
    expect(t["c-gone"]).toBeUndefined(); // deleted category
  });

  it("goal helpers", () => {
    expect(mapGoalType("NEED", null)).toBe("need_refill");
    expect(mapGoalType("XYZ", null)).toBeNull();
    expect(mapGoalCadence(1, 3)).toEqual({ cadence: "every_n_months", frequency: 3 });
    expect(mapGoalCadence(12, 9)).toEqual({ cadence: "every_n_months", frequency: 11 });
    expect(mapGoalCadence(13, 2)).toEqual({ cadence: "yearly", frequency: 2 });
    expect(mapGoalCadence(14, 5)).toEqual({ cadence: "yearly", frequency: 2 });
    expect(mapGoalCadence(2, 2)).toEqual({ cadence: "weekly", frequency: 2 });
    expect(mapGoalCadence(null, null)).toEqual({ cadence: "none", frequency: 1 });
  });

  it("transactions: splits joined, transfers paired, cleared/approved/flags/memos", () => {
    const t = Object.fromEntries(b.transactions.map((x) => [x.ynabId, x]));
    expect(t["t-pay"]).toMatchObject({ amount: 3_250_000n, categoryYnabId: "c-rta", cleared: "cleared", approved: true, payeeName: "Northwind Studio", importId: "YNAB:3250000:2026-10-15:1", isSplit: false, flag: null });
    expect(t["t-costco"]).toMatchObject({ isSplit: true, flag: "orange", flagName: "check", memo: "split run", approved: false, cleared: "uncleared" });
    expect(t["t-costco"]!.categoryYnabId).toBeUndefined();
    expect(t["t-costco"]!.subtransactions.map((s) => [s.categoryYnabId, s.amount, s.memo])).toEqual([
      ["c-groc", -100_000n, "food"],
      ["c-house", -42_670n, "membership"],
    ]);
    expect(t["t-xfer-out"]).toMatchObject({ transferAccountYnabId: "a-fab", transferPairYnabId: "t-xfer-in", cleared: "reconciled", flag: null });
    expect(t["t-xfer-in"]).toMatchObject({ transferPairYnabId: "t-xfer-out" });
    expect(t["t-del"]).toMatchObject({ deleted: true, flag: "purple" });
  });

  it("scheduled transactions with frequency mapping and split subtransactions", () => {
    const [mort, pay] = b.scheduled;
    expect(mort).toMatchObject({ frequency: "monthly", dateNext: "2026-11-01", amount: -1_896_200n, transferAccountYnabId: "a-mtg", categoryYnabId: "c-mort", memo: "P&I" });
    expect(pay).toMatchObject({ frequency: "twice_monthly", ynabFrequency: "twiceAMonth", flag: "green" });
    expect(pay!.categoryYnabId).toBeUndefined();
    expect(pay!.subtransactions.map((s) => [s.amount, s.categoryYnabId, s.transferAccountYnabId])).toEqual([
      [3_000_000n, "c-rta", undefined],
      [250_000n, undefined, "a-sav"],
    ]);
  });

  it("payees and month assignments", () => {
    expect(b.payees.find((p) => p.ynabId === "p-xfer-fab")).toMatchObject({ transferAccountYnabId: "a-fab" });
    expect(b.months.map((m) => [m.month, m.toBeBudgeted, m.ageOfMoney])).toEqual([
      ["2026-09-01", 0n, 41],
      ["2026-10-01", 1_250_000n, 38],
    ]);
    expect(b.monthAssignments).toHaveLength(6);
    expect(b.monthAssignments.filter((a) => a.categoryYnabId === "c-groc").map((a) => [a.month, a.budgeted])).toEqual([
      ["2026-09-01", 850_000n],
      ["2026-10-01", 900_000n],
    ]);
  });

  it("delta exports (subset of fields) still map; bad rows become warnings", () => {
    const delta = mapYnabPlan({ plan: { id: "plan-0001", name: "My Budget", transactions: [{ id: "t-new", date: "2026-10-22", amount: -5000, cleared: "uncleared", approved: false, account_id: "a-chk", deleted: false }, { id: "broken" }] }, server_knowledge: 4250 });
    expect(delta.transactions).toHaveLength(1);
    expect(delta.serverKnowledge).toBe(4250);
    expect(delta.warnings[0]).toMatch(/transactions\[1\]/);
    expect(() => mapYnabPlan({ nope: true })).toThrow(/YNAB plan/);
  });
});
