/**
 * Integration-test database for the web app: `<TEST_DATABASE_URL minus _test>_web_<suite>_test`, reset,
 * migrated with drizzle's migrator (not runMigrations, which reconfigures the cluster-wide homebase_ro
 * role other suites assert on) and demo-seeded. Returns null (tests skip) when Postgres is down.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { MIGRATIONS_DIR, createDb, type Db } from "@homebase/db";
// The seed isn't exported from @homebase/db's entry point; tests import it directly.
import { seedDemo } from "../../../../packages/db/src/seed/demo";

export function webTestUrl(suite: string): string {
  const base = process.env.TEST_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_test";
  const u = new URL(base);
  const name = u.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`refusing to use ${name}: test database names must end in _test`);
  u.pathname = `/${name.replace(/_test$/, "")}_web_${suite}_test`;
  return u.toString();
}

/** One database per suite file, so files can run in parallel. */
export async function prepareWebTestDb(suite: string): Promise<{ db: Db; close: () => Promise<void> } | null> {
  if (!/^[a-z0-9]+$/.test(suite)) throw new Error("suite names are lowercase alphanumerics");
  const url = webTestUrl(suite);
  const name = new URL(url).pathname.slice(1);
  const base = process.env.TEST_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_test";
  const admin = createDb(base, { max: 1 }).pool;
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (!exists.rowCount) await admin.query(`create database "${name}"`);
  } catch (e) {
    console.warn(`[web db tests skipped] Postgres not reachable at ${base}: ${(e as Error).message}`);
    return null;
  } finally {
    await admin.end().catch(() => undefined);
  }
  const c = createDb(url, { max: 1 }).pool;
  await c.query("DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await c.end();
  const { db, pool } = createDb(url, { max: 4 });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await seedDemo(db);
  return { db, close: () => pool.end() };
}
