import { describe, expect, it } from "vitest";
import { registerJobs, runJob } from "../src/boss";
import { JobError } from "../src/jobs/common";
import { JOBS, JOB_TZ, jobDef } from "../src/jobs/definitions";
import { HANDLERS } from "../src/jobs/handlers";
import { fitToBudget, planSimplefinWindows } from "../src/jobs/sync/simplefin";
import { silentLogger } from "../src/log";
import type { WorkerContext } from "../src/context";

describe("job registration (§8.1)", () => {
  it("lists every job with its America/New_York cron", () => {
    expect(JOBS.map((j) => [j.name, j.cron])).toEqual([
      ["sync.simplefin", "17 5,11,17,23 * * *"],
      ["sync.mercury", "7 7-22 * * *"],
      ["sync.coinbase", "5 23 * * *"],
      ["sync.rentcast", "0 9 2 * *"],
      ["sync.manual", null],
      ["ynab.delta", "30 4 * * *"],
      ["categorize.pending", null],
      ["categorize.batch", "30 2 * * *"],
      ["price.manual", "7 * * * *"],
      ["snapshot.networth", "55 23 * * *"],
      ["scheduled.materialize", "10 0 * * *"],
      ["digest.weekly", "0 18 * * 0"],
      ["backup.check", "45 3 * * *"],
      ["health.connections", "0 8 * * *"],
    ]);
    for (const j of JOBS) {
      expect(HANDLERS[j.name], j.name).toBeTypeOf("function");
      if (j.name !== "sync.manual") expect([j.retryLimit, j.retryBackoff], j.name).toEqual([3, true]);
      expect(["stately", "singleton", "standard"]).toContain(j.policy);
    }
    expect(jobDef("categorize.pending").policy).toBe("singleton");
    expect(jobDef("sync.simplefin").policy).toBe("stately");
  });

  it("registers queues, schedules (tz America/New_York) and one worker per job", async () => {
    const calls: { op: string; name: string; arg?: unknown }[] = [];
    const queues = new Set<string>(["sync.simplefin"]);
    const boss = {
      getQueue: async (n: string) => (queues.has(n) ? { name: n } : null),
      createQueue: async (n: string, o: unknown) => void calls.push({ op: "create", name: n, arg: o }),
      updateQueue: async (n: string, o: unknown) => void calls.push({ op: "update", name: n, arg: o }),
      schedule: async (n: string, cron: string, _d: unknown, o: { tz: string }) => void calls.push({ op: "schedule", name: n, arg: [cron, o.tz] }),
      unschedule: async (n: string) => void calls.push({ op: "unschedule", name: n }),
      work: async (n: string, o: unknown) => void calls.push({ op: "work", name: n, arg: o }),
    };
    const names = await registerJobs(boss as never, { log: silentLogger() } as WorkerContext);
    expect(names).toEqual(JOBS.map((j) => j.name));
    expect(calls.find((c) => c.op === "update")?.name).toBe("sync.simplefin");
    expect(calls.filter((c) => c.op === "create")).toHaveLength(JOBS.length - 1);
    expect(calls.filter((c) => c.op === "schedule").map((c) => c.arg)).toContainEqual(["17 5,11,17,23 * * *", JOB_TZ]);
    expect(calls.filter((c) => c.op === "schedule").every((c) => (c.arg as string[])[1] === "America/New_York")).toBe(true);
    expect(calls.filter((c) => c.op === "unschedule").map((c) => c.name)).toEqual(["price.bitcoin", "sync.manual", "categorize.pending"]);
    expect(calls.filter((c) => c.op === "work")).toHaveLength(JOBS.length);
    expect(calls.find((c) => c.op === "create" && c.name === "sync.mercury")?.arg).toMatchObject({ policy: "stately", retryLimit: 3, retryBackoff: true });
  });

  it("marks the job's connections `error` only after the final retry", async () => {
    const marked: string[] = [];
    const ctx = {
      log: silentLogger(),
      now: () => new Date(),
      db: { update: () => ({ set: () => ({ where: async () => void marked.push("x") }) }) },
    } as unknown as WorkerContext;
    const fail = async () => {
      throw new JobError("boom", ["conn-1"]);
    };
    await expect(runJob(ctx, jobDef("sync.mercury"), fail, { id: "1", data: {}, retryCount: 1, retryLimit: 3 })).rejects.toThrow("boom");
    expect(marked).toEqual([]);
    await expect(runJob(ctx, jobDef("sync.mercury"), fail, { id: "1", data: {}, retryCount: 3, retryLimit: 3 })).rejects.toThrow("boom");
    expect(marked).toEqual(["x"]);
  });
});

describe("SimpleFIN request planning (§7.1)", () => {
  it("first run fetches backfill + overlap in one 45-day window", () => {
    const p = planSimplefinWindows("2026-10-22", "2026-10-22", undefined);
    expect(p.windows.map((w) => [w.from, w.to, w.backfill])).toEqual([["2026-09-22", "2026-10-22", true]]);
    expect(p.normal).toEqual({ since: "2026-10-08", until: "2026-10-22" });
  });

  it("later runs fetch only the 14-day overlap", () => {
    const p = planSimplefinWindows("2026-10-23", "2026-10-22", { target: "2026-09-22", coveredFrom: "2026-09-22", done: true });
    expect(p.windows.map((w) => [w.from, w.to])).toEqual([["2026-10-09", "2026-10-23"]]);
  });

  it("a long backfill is split newest-first so a tight budget keeps recent data", () => {
    const p = planSimplefinWindows("2026-10-22", "2026-10-01", { target: "2026-06-01", coveredFrom: null, done: false });
    expect(p.windows.map((w) => [w.from, w.to, w.backfill])).toEqual([
      ["2026-10-08", "2026-10-22", false],
      ["2026-08-30", "2026-10-07", true],
      ["2026-07-16", "2026-08-29", true],
      ["2026-06-01", "2026-07-15", true],
    ]);
    // 5 used today → only one request left: the normal window.
    expect(fitToBudget(p.windows, { usedToday: 5, manualToday: 0 }, "scheduled").take).toHaveLength(1);
    expect(fitToBudget(p.windows, { usedToday: 6, manualToday: 0 }, "scheduled")).toMatchObject({ take: [], reason: expect.stringContaining("6") });
    expect(fitToBudget(p.windows, { usedToday: 2, manualToday: 2 }, "manual")).toMatchObject({ take: [], reason: expect.stringContaining("2 per day") });
    // Resume: covered back to 2026-08-30 → remaining windows end the day before.
    const later = planSimplefinWindows("2026-10-22", "2026-10-01", { target: "2026-06-01", coveredFrom: "2026-08-30", done: false });
    expect(later.windows.filter((w) => w.backfill).map((w) => [w.from, w.to])).toEqual([
      ["2026-07-16", "2026-08-29"],
      ["2026-06-01", "2026-07-15"],
    ]);
  });
});

describe("pg-boss 10.4.2 against Postgres", () => {
  it("creates queues and America/New_York schedules, and runs a sent job", async () => {
    const { freshDb } = await import("./helpers");
    const { createBoss } = await import("../src/boss");
    const { pool, url } = await freshDb();
    const boss = createBoss(url, "pgboss");
    boss.on("error", () => {});
    await boss.start();
    try {
      const ran: unknown[] = [];
      const handlers = Object.fromEntries(JOBS.map((j) => [j.name, async (_c: WorkerContext, d: unknown) => void ran.push([j.name, d])]));
      await registerJobs(boss, { log: silentLogger(), now: () => new Date() } as WorkerContext, { handlers });
      await registerJobs(boss, { log: silentLogger(), now: () => new Date() } as WorkerContext, { handlers }); // idempotent restart
      const schedules = await boss.getSchedules();
      expect(schedules.map((s) => s.name).sort()).toEqual(JOBS.filter((j) => j.cron).map((j) => j.name).sort());
      expect(new Set(schedules.map((s) => (s as unknown as { timezone: string }).timezone))).toEqual(new Set(["America/New_York"]));
      const q = await boss.getQueue("categorize.pending");
      expect(q).toMatchObject({ policy: "singleton", retryLimit: 3, retryBackoff: true });
      await boss.send("sync.manual", { provider: "mercury" }, { singletonKey: "mercury" });
      for (let i = 0; i < 50 && !ran.length; i++) await new Promise((r) => setTimeout(r, 200));
      expect(ran).toEqual([["sync.manual", { provider: "mercury" }]]);
    } finally {
      await boss.stop({ graceful: false, wait: true, timeout: 5000 });
      await pool.end();
    }
  });
});
