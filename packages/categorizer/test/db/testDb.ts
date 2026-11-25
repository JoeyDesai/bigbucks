/**
 * Integration-test database: a per-package database next to TEST_DATABASE_URL
 * (homebase_test → homebase_categorizer_test) so this suite never resets a database another
 * package's tests are using. Migrated and seeded with the demo data. Returns null (tests skip)
 * when Postgres isn't reachable — run `pnpm db:dev` first.
 */
import { createDb, runMigrations, type Db } from "@homebase/db";
// The seed isn't exported from @homebase/db's entry point; tests import it directly.
import { seedDemo } from "../../../db/src/seed/demo";

export const BASE_TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_test";
export const RO_TEST_PASSWORD = "homebase-ro-test";

export function packageTestUrl(name: string): string {
  const u = new URL(BASE_TEST_URL);
  const base = u.pathname.slice(1).replace(/_test$/, "");
  u.pathname = `/${base}_${name}_test`;
  return u.toString();
}

export interface TestDb {
  url: string;
  db: Db;
  pool: ReturnType<typeof createDb>["pool"];
  close(): Promise<void>;
}

export async function prepareTestDb(name: string): Promise<TestDb | null> {
  const url = packageTestUrl(name);
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith("_test")) throw new Error(`refusing to reset ${dbName}`);
  const admin = createDb(BASE_TEST_URL, { max: 1 }).pool;
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (rows.length === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    console.warn(`[db tests skipped] Postgres not reachable at ${BASE_TEST_URL}: ${(e as Error).message}`);
    return null;
  } finally {
    await admin.end().catch(() => undefined);
  }
  const reset = createDb(url, { max: 1 }).pool;
  await reset.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await reset.end();
  await runMigrations(url, { roPassword: RO_TEST_PASSWORD });
  const { db, pool } = createDb(url, { max: 4 });
  await seedDemo(db);
  return { url, db, pool, close: () => pool.end() };
}
