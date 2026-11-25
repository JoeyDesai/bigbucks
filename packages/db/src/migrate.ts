import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";
import { env } from "./env";

// path.resolve (not `new URL("../migrations", import.meta.url)`) so bundlers like Turbopack, which
// treat that URL pattern as an asset import, can bundle this module into apps/web.
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
export const RO_ROLE = "homebase_ro";

export interface MigrateOptions {
  /** Password for homebase_ro. Omit or null → NOLOGIN. */
  roPassword?: string | null;
}

/** Apply pending migrations, then (re)configure the read-only reporting role. Safe to run repeatedly. */
export async function runMigrations(url: string, opts: MigrateOptions = {}): Promise<void> {
  const { db, pool } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    await configureReadOnlyRole(pool, opts.roPassword ?? null);
  } finally {
    await pool.end();
  }
}

/**
 * homebase_ro is what the AI's sql_query tool connects as (§4.6, §11.3): SELECT on the v_* reporting views
 * only, read-only transactions by default, and a 5 s statement timeout. Views run with their owner's
 * rights, so no base-table grants are needed (or given).
 */
export async function configureReadOnlyRole(pool: pg.Pool, password: string | null): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RO_ROLE}') THEN CREATE ROLE ${RO_ROLE} NOLOGIN; END IF;
    END $$`);
    const login = password ? `LOGIN PASSWORD ${client.escapeLiteral(password)}` : "NOLOGIN PASSWORD NULL";
    await client.query(`ALTER ROLE ${RO_ROLE} WITH ${login} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    await client.query(`ALTER ROLE ${RO_ROLE} SET statement_timeout = '5s'`);
    await client.query(`ALTER ROLE ${RO_ROLE} SET default_transaction_read_only = on`);
    await client.query(`ALTER ROLE ${RO_ROLE} SET idle_in_transaction_session_timeout = '30s'`);

    const { rows } = await client.query<{ db: string }>("SELECT current_database() AS db");
    await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(rows[0]!.db)} TO ${RO_ROLE}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${RO_ROLE}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${RO_ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RO_ROLE}`);
    const views = await client.query<{ viewname: string }>(
      String.raw`SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname LIKE 'v\_%' ORDER BY viewname`,
    );
    for (const { viewname } of views.rows) {
      await client.query(`GRANT SELECT ON public.${client.escapeIdentifier(viewname)} TO ${RO_ROLE}`);
    }
    await client.query("COMMIT");
    return views.rows.map((r) => r.viewname);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e = env();
  runMigrations(e.DATABASE_URL, { roPassword: e.HOMEBASE_RO_PASSWORD ?? null })
    .then(() => console.log("migrations applied; homebase_ro configured"))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
