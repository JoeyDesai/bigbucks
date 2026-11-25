/**
 * Test harness. The worker gets its own database (`<base>_worker_test`, derived from TEST_DATABASE_URL)
 * so its resets can't collide with other packages' suites running against homebase_test in parallel.
 * Refuses any database whose name does not end in `_test`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { MIGRATIONS_DIR, createDb, createKeyring, generateMasterKey, type Db, type Keyring } from "@homebase/db";
import type { FetchLike } from "@homebase/connectors";
import { localRecompute } from "../src/budget";
import type { WorkerContext } from "../src/context";
import { parseWorkerEnv } from "../src/env";
import type { CategorizeRequest, TransferDetector } from "../src/hooks";
import { deterministicDigest } from "@homebase/ai";
import { silentLogger } from "../src/log";
import type { AlertType, PushMessage, Pusher } from "../src/push";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "../../..");
export const CONNECTOR_FIXTURES = resolve(REPO, "packages/connectors/test/fixtures");
export const ENGINE_SYNTHETIC_PLAN = resolve(REPO, "packages/engine/test/golden/synthetic/plan.json");

export function readFixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function workerTestUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_test";
  const u = new URL(base);
  const name = u.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`refusing to use ${name}: test database names must end in _test`);
  u.pathname = `/${name.replace(/_test$/, "")}_worker_test`;
  return u.toString();
}

/** Create (if needed) and reset the worker test database, run migrations, return a Db. */
export async function freshDb(): Promise<{ db: Db; pool: pg.Pool; url: string }> {
  const url = workerTestUrl();
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`refusing to reset ${name}`);
  const base = process.env.TEST_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_test";
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
  if (!exists.rowCount) await admin.query(`create database "${name}"`);
  await admin.end();

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await c.end();
  // drizzle's migrator directly: runMigrations would also reconfigure the cluster-wide homebase_ro role,
  // which the db package's own suite asserts on concurrently.
  const { db, pool } = createDb(url, { max: 4 });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, pool, url };
}

export interface Recorded {
  enqueued: { name: string; data?: object }[];
  recomputed: (string | null | undefined)[];
  pushes: { to: string; type: AlertType; msg: PushMessage }[];
  categorize: CategorizeRequest[];
}

export const TEST_NOW = new Date("2026-10-22T16:00:00Z"); // 12:00 America/New_York

export function makeCtx(db: Db, o: { now?: () => Date; fetch?: FetchLike; keyring?: Keyring; detectTransfers?: TransferDetector; env?: Record<string, string> } = {}): { ctx: WorkerContext; rec: Recorded } {
  const rec: Recorded = { enqueued: [], recomputed: [], pushes: [], categorize: [] };
  const push: Pusher = {
    async sendToUser(userId, type, msg) {
      rec.pushes.push({ to: userId, type, msg });
      return { sent: 1, pruned: 0, failed: 0, skipped: false };
    },
    async sendToAdmins(type, msg) {
      rec.pushes.push({ to: "admins", type, msg });
      return { sent: 1, pruned: 0, failed: 0, skipped: false };
    },
    async sendToAll(type, msg) {
      rec.pushes.push({ to: "all", type, msg });
      return { sent: 1, pruned: 0, failed: 0, skipped: false };
    },
  };
  const ctx: WorkerContext = {
    db,
    log: silentLogger(),
    env: parseWorkerEnv({ NODE_ENV: "test", ...(o.env ?? {}) }),
    keyring: o.keyring ?? createKeyring(generateMasterKey()),
    http: o.fetch ? { fetch: o.fetch, retries: 0, sleep: async () => {} } : { fetch: noNetwork, retries: 0 },
    now: o.now ?? (() => TEST_NOW),
    enqueue: async (name, data) => {
      rec.enqueued.push({ name, ...(data ? { data } : {}) });
    },
    recompute: async (d, opts) => {
      rec.recomputed.push(opts.fromMonth);
      return localRecompute(d, opts);
    },
    detectTransfers: o.detectTransfers ?? (() => ({ auto: [], suggestions: [] })),
    categorizePending: async (req) => {
      rec.categorize.push(req);
      return { processed: req.transactionIds?.length ?? 0 };
    },
    categorizeBatch: async (req) => {
      rec.categorize.push(req);
      return { processed: 0 };
    },
    digest: async (s) => deterministicDigest(s),
    push,
  };
  return { ctx, rec };
}

/** Any test that forgets to inject fetch fails loudly instead of touching the network. */
export const noNetwork: FetchLike = async (url) => {
  throw new Error(`network disabled in tests (${new URL(url).host})`);
};

/** A fetch that serves a JSON body for SimpleFIN /accounts and records requests. */
export function simplefinFetch(body: () => unknown): { fetch: FetchLike; calls: { url: string; auth: string | null; method: string }[] } {
  const calls: { url: string; auth: string | null; method: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization"), method: init?.method ?? "GET" });
    if (!new URL(url).pathname.endsWith("/accounts")) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body()), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}
