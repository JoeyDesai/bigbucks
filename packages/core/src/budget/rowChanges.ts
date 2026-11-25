/**
 * Generic, undoable row edits for budget configuration tables (targets, notes, categories, groups).
 * A RowChange stores the row before and after as JSON (numbers kept as strings so bigint money is exact);
 * Postgres' jsonb_populate_record turns them back into typed rows, so no per-table code is needed.
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbLike } from "../context";
import { ConflictError } from "../errors";
import { stableStringify } from "../json";

export const ROW_TABLES = {
  targets: ["category_id", "effective_from"],
  month_notes: ["id"],
  categories: ["id"],
  category_groups: ["id"],
} as const;
export type RowTable = keyof typeof ROW_TABLES;

export type RowJson = Record<string, string | boolean | null | Record<string, unknown> | unknown[]>;

export interface RowChange {
  table: RowTable;
  pk: Record<string, string>;
  before: RowJson | null;
  after: RowJson | null;
}

function pkWhere(table: RowTable, pk: Record<string, string>): SQL {
  const cols = ROW_TABLES[table];
  return sql.join(
    cols.map((c) => {
      const v = pk[c];
      if (v === undefined) throw new Error(`row change for ${table} is missing key ${c}`);
      return sql`${sql.identifier(c)} = ${v}`;
    }),
    sql` AND `,
  );
}

/** The row as JSON with numbers as strings, without created_at/updated_at; null when absent. */
export async function readRow(db: DbLike, table: RowTable, pk: Record<string, string>): Promise<RowJson | null> {
  const res = await db.execute(sql`
    SELECT (
      SELECT jsonb_object_agg(key, CASE WHEN jsonb_typeof(value) = 'number' THEN to_jsonb(value #>> '{}') ELSE value END)
      FROM jsonb_each(to_jsonb(t.*) - 'created_at' - 'updated_at')
    ) AS row
    FROM ${sql.identifier(table)} t
    WHERE ${pkWhere(table, pk)}`);
  const r = res.rows[0] as { row: RowJson } | undefined;
  return r ? r.row : null;
}

async function writeRow(db: DbLike, table: RowTable, pk: Record<string, string>, row: RowJson | null): Promise<void> {
  if (row === null) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE ${pkWhere(table, pk)}`);
    return;
  }
  const cols = Object.keys(row);
  const pkCols = ROW_TABLES[table] as readonly string[];
  const colList = sql.join(cols.map((c) => sql.identifier(c)), sql`, `);
  const updates = cols.filter((c) => !pkCols.includes(c)).map((c) => sql`${sql.identifier(c)} = EXCLUDED.${sql.identifier(c)}`);
  updates.push(sql`updated_at = now()`);
  await db.execute(sql`
    INSERT INTO ${sql.identifier(table)} (${colList})
    SELECT ${colList} FROM jsonb_populate_record(NULL::${sql.identifier(table)}, ${JSON.stringify(row)}::jsonb)
    ON CONFLICT (${sql.join(pkCols.map((c) => sql.identifier(c)), sql`, `)}) DO UPDATE SET ${sql.join(updates, sql`, `)}`);
}

/** Capture a change around `mutate`: reads the row before and after. */
export async function trackRow(db: DbLike, table: RowTable, pk: Record<string, string>, mutate: () => Promise<unknown>): Promise<RowChange> {
  const before = await readRow(db, table, pk);
  await mutate();
  const after = await readRow(db, table, pk);
  return { table, pk, before, after };
}

export function invertRowChanges(changes: readonly RowChange[]): RowChange[] {
  return [...changes].reverse().map((c) => ({ ...c, before: c.after, after: c.before }));
}

/** Apply changes (each row must currently equal `before`, else ConflictError). */
export async function applyRowChanges(db: DbLike, changes: readonly RowChange[]): Promise<void> {
  for (const c of changes) {
    const cur = await readRow(db, c.table, c.pk);
    if (stableStringify(cur) !== stableStringify(c.before)) {
      throw new ConflictError(`${c.table} ${Object.values(c.pk).join("/")} changed since this operation`);
    }
    try {
      await writeRow(db, c.table, c.pk, c.after);
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === "23503") throw new ConflictError(`${c.table} ${Object.values(c.pk).join("/")} is in use and can't be removed`);
      throw e;
    }
  }
}
