import { createDb, runMigrations } from "@homebase/db";
import { coreTestUrl, ensureDatabase } from "./db";

/** Once per run: fresh schema + migrations. Each test file re-seeds the demo data itself. */
export default async function setup(): Promise<void> {
  const url = coreTestUrl();
  await ensureDatabase(url);
  const { pool } = createDb(url, { max: 1 });
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await pool.end();
  await runMigrations(url);
}
