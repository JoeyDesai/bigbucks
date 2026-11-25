/**
 * ReadOnlySqlExecutor for the agent's sql_query tool: a separate pg pool that logs in as
 * `homebase_ro` (SELECT on the v_* reporting views only) and runs each query inside
 * BEGIN READ ONLY with a statement timeout, always ending in ROLLBACK.
 *
 * Size caps, so one query can't OOM the web process (e.g. `repeat('x', 4e8)` × 600 rows):
 *   1. `SELECT … LIMIT 0` first, to learn the column names/types without running the query;
 *   2. the real query is wrapped so every cell is capped SERVER-SIDE (text cut to
 *      SQL_MAX_CELL_CHARS with a marker, any other oversized value replaced by NULL), so no single
 *      DataRow can be large;
 *   3. rows are pulled through a cursor in small batches, stopping at ~SQL_MAX_RESULT_BYTES.
 *
 * URL: HOMEBASE_RO_DATABASE_URL, or DATABASE_URL with the user/password swapped for
 * homebase_ro / HOMEBASE_RO_PASSWORD.
 */
import { createDb } from "@homebase/db";
import {
  readOnlySqlStatements,
  SQL_MAX_CELL_CHARS,
  SQL_MAX_COLUMNS,
  SQL_MAX_RESULT_BYTES,
  SQL_READONLY_ROLE,
  type ReadOnlySqlExecutor,
  type SqlResult,
} from "../agent/sqlGuard";

export function resolveReadOnlyDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.HOMEBASE_RO_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const base = env.DATABASE_URL?.trim();
  if (!base) throw new Error("set HOMEBASE_RO_DATABASE_URL, or DATABASE_URL plus HOMEBASE_RO_PASSWORD");
  const u = new URL(base);
  u.username = SQL_READONLY_ROLE;
  u.password = env.HOMEBASE_RO_PASSWORD?.trim() ?? "";
  return u.toString();
}

type Pool = ReturnType<typeof createDb>["pool"];

const FETCH_BATCH = 50;
/** text, varchar, bpchar, name: capped with left() so the column keeps a text type. */
const TEXT_OIDS = new Set([25, 1043, 1042, 19]);
export const CELL_TRUNCATED_MARKER = "…[truncated]";

/**
 * Wrap a validated query so no cell can exceed SQL_MAX_CELL_CHARS. Columns are renamed positionally
 * (`AS hb_cap(c1, c2, …)`), which also copes with duplicate or odd names like "?column?"; the caller
 * maps them back by position.
 */
export function cappedQuery(query: string, oids: number[]): string {
  if (oids.length === 0) return `SELECT * FROM (\n${query}\n) AS hb_cap`;
  const n = SQL_MAX_CELL_CHARS;
  const cols = oids.map((_, i) => `c${i + 1}`);
  const proj = oids.map((oid, i) => {
    const c = `hb_cap.${cols[i]}`;
    return TEXT_OIDS.has(oid)
      ? `CASE WHEN length(${c}) > ${n} THEN left(${c}, ${n}) || '${CELL_TRUNCATED_MARKER}' ELSE ${c}::text END`
      : `CASE WHEN octet_length(${c}::text) > ${n} THEN NULL ELSE ${c} END`;
  });
  return `SELECT ${proj.join(", ")} FROM (\n${query}\n) AS hb_cap(${cols.join(", ")})`;
}

/** Rough wire/heap size of one row, for the result-size cap. */
function approxBytes(values: unknown[]): number {
  let n = 8;
  for (const v of values) {
    if (v === null || v === undefined) n += 4;
    else if (typeof v === "string") n += v.length * 2;
    else if (Buffer.isBuffer(v)) n += v.length;
    else if (typeof v === "object" && !(v instanceof Date)) n += JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))?.length ?? 0;
    else n += 16;
  }
  return n;
}

export class DbReadOnlySqlExecutor implements ReadOnlySqlExecutor {
  private readonly pool: Pool;
  private verified = false;

  constructor(url: string = resolveReadOnlyDatabaseUrl(), opts: { max?: number } = {}) {
    this.pool = createDb(url, { max: opts.max ?? 2 }).pool;
  }

  async runReadOnly(wrappedSql: string, opts: { timeoutMs: number; role: typeof SQL_READONLY_ROLE }): Promise<SqlResult> {
    const client = await this.pool.connect();
    try {
      if (!this.verified) {
        const who = await client.query<{ u: string }>("SELECT current_user AS u");
        if (who.rows[0]?.u !== opts.role) throw new Error(`read-only SQL must run as ${opts.role}, connected as ${who.rows[0]?.u ?? "?"}`);
        this.verified = true;
      }
      const [begin, setTimeout, query, rollback] = readOnlySqlStatements(wrappedSql, opts.timeoutMs);
      await client.query(begin!);
      try {
        await client.query(setTimeout!);
        const shape = await client.query(`SELECT * FROM (\n${query!}\n) AS hb_shape LIMIT 0`);
        const fields = shape.fields.map((f) => ({ name: f.name, oid: f.dataTypeID }));
        if (fields.length > SQL_MAX_COLUMNS) throw new Error(`query returns ${fields.length} columns; at most ${SQL_MAX_COLUMNS} are allowed`);
        await client.query(`DECLARE hb_ai_cursor NO SCROLL CURSOR FOR ${cappedQuery(query!, fields.map((f) => f.oid))}`);
        const rows: Record<string, unknown>[] = [];
        let bytes = 0;
        let truncatedBytes = false;
        // statement_timeout is per statement (each FETCH); keep the whole read inside one budget too.
        const deadline = Date.now() + opts.timeoutMs;
        for (;;) {
          if (Date.now() > deadline) throw new Error("canceling statement due to statement timeout (cursor read exceeded the time budget)");
          const batch = await client.query({ text: `FETCH ${FETCH_BATCH} FROM hb_ai_cursor`, rowMode: "array" });
          for (const values of batch.rows as unknown[][]) {
            const row: Record<string, unknown> = {};
            fields.forEach((f, i) => (row[f.name] = values[i]));
            bytes += approxBytes(values);
            if (bytes > SQL_MAX_RESULT_BYTES) {
              truncatedBytes = true;
              break;
            }
            rows.push(row);
          }
          if (truncatedBytes || batch.rows.length < FETCH_BATCH) break;
        }
        return { columns: fields.map((f) => f.name), columnTypes: fields.map((f) => f.oid), rows, ...(truncatedBytes ? { truncatedBytes } : {}) };
      } finally {
        await client.query(rollback!).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
