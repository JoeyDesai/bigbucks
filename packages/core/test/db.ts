/**
 * Test database for @homebase/core. Derived from TEST_DATABASE_URL (default …/homebase_test) as
 * `<name>_core_test`, so this suite never races the db package (or others) resetting homebase_test.
 * CORE_TEST_DATABASE_URL overrides it. Like the db package, it refuses any database not ending in _test.
 */
import { createDb } from "@homebase/db";

export function coreTestUrl(): string {
  if (process.env.CORE_TEST_DATABASE_URL) return checked(process.env.CORE_TEST_DATABASE_URL);
  const base = new URL(process.env.TEST_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_test");
  const name = base.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`refusing to use ${name}: test database names must end in _test`);
  base.pathname = `/${name.replace(/_test$/, "_core_test")}`;
  return checked(base.toString());
}

function checked(url: string): string {
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`refusing to use ${name}: test database names must end in _test`);
  return url;
}

/** Create the database if missing (connects to TEST_DATABASE_URL's server). */
export async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const { pool } = createDb(admin.toString(), { max: 1 });
  try {
    const { rows } = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rows.length === 0) {
      if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name ${name}`);
      await pool.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await pool.end();
  }
}
