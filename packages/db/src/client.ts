import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { env } from "./env";

/**
 * Process-wide pg type parsers so raw `pool.query` / `db.execute` results match the schema conventions:
 * int8 → bigint (money, counts), date → "YYYY-MM-DD" string. Drizzle-typed columns already map these;
 * drizzle's node-postgres driver falls back to these global parsers for everything else.
 */
function installTypeParsers(): void {
  const { builtins } = pg.types;
  const oid = (n: number) => n as (typeof builtins)[keyof typeof builtins];
  pg.types.setTypeParser(builtins.INT8, (v: string) => BigInt(v));
  pg.types.setTypeParser(builtins.DATE, (v: string) => v);
  const parseTextArray = pg.types.getTypeParser(oid(1009)); // text[]
  pg.types.setTypeParser(oid(1016), (v: string) => (parseTextArray(v) as (string | null)[]).map((x) => (x === null ? null : BigInt(x)))); // int8[]
  pg.types.setTypeParser(oid(1182), parseTextArray); // date[] → string[]
}
installTypeParsers();

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A transaction handle has the same query API as Db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface CreateDbOptions {
  /** Max pool size (default 10). */
  max?: number;
  /** Log SQL to stdout. */
  logger?: boolean;
}

export function createDb(url: string = env().DATABASE_URL, opts: CreateDbOptions = {}): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  const db = drizzle({ client: pool, schema, logger: opts.logger ?? false });
  return { db, pool };
}
