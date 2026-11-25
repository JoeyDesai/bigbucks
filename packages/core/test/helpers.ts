import { afterAll, beforeAll } from "vitest";
import { createDb, type Db } from "@homebase/db";
import { DEMO_TODAY, seedDemo } from "../../db/src/seed/demo";
import { clearBudgetMemo } from "../src/budget/cache";
import { userCtx, type Ctx } from "../src/context";
import { coreTestUrl } from "./db";

export const TODAY = DEMO_TODAY;
export const MONTH = "2026-10-01";

export interface TestEnv {
  db: Db;
  ctx: Ctx;
  alexId: string;
  /** Re-seed the demo data (truncates everything). */
  reseed(): Promise<void>;
}

/** Per test file: connect, seed the demo data, and give back a user context pinned to the demo "today". */
export function useDemoDb(): TestEnv {
  const env = {} as TestEnv;
  let pool: { end(): Promise<void> } | undefined;
  beforeAll(async () => {
    const c = createDb(coreTestUrl(), { max: 4 });
    pool = c.pool;
    env.db = c.db;
    env.reseed = async () => {
      await seedDemo(c.db, { force: true });
      clearBudgetMemo();
    };
    await env.reseed();
    const [alex] = await c.db.query.users.findMany({ where: (u, { eq }) => eq(u.displayName, "Alex") });
    env.alexId = alex!.id;
    env.ctx = userCtx(c.db, alex!.id, TODAY);
  });
  afterAll(async () => {
    await pool?.end();
  });
  return env;
}
