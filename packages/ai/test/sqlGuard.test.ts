import { describe, expect, it } from "vitest";
import { readOnlySqlStatements, runGuardedSql, validateSelectSql, type ReadOnlySqlExecutor } from "../src";

const ok = (sql: string) => {
  const r = validateSelectSql(sql);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r;
};
const rejected = (sql: string) => {
  const r = validateSelectSql(sql);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.reason;
};

describe("sql guard: accepts", () => {
  it.each([
    "SELECT category, sum(amount_milli) FROM v_transactions_flat WHERE date >= '2026-01-01' GROUP BY 1 ORDER BY 2",
    "select * from v_month_category;",
    "WITH m AS (SELECT month, sum(activity) a FROM v_month_category GROUP BY month) SELECT * FROM m ORDER BY month",
    "SELECT t.payee, extract(year from t.date) y FROM v_transactions_flat t JOIN v_payee_spend_monthly p ON p.payee = t.payee",
    "SELECT a.x FROM v_net_worth_daily a, v_holdings_latest b WHERE a.date = b.as_of",
    "SELECT payee FROM v_transactions_flat WHERE payee IS DISTINCT FROM 'Amazon'",
    "SELECT 'delete; drop table x' AS s FROM v_cashflow_monthly -- trailing comment",
    "SELECT /* inline */ count(*) FROM v_transactions_flat WHERE memo = 'it''s; fine'",
    "SELECT d::date FROM generate_series('2026-01-01'::date, '2026-03-01'::date, interval '1 month') d",
    "SELECT * FROM (SELECT payee FROM v_transactions_flat) sub",
    "SELECT substring(payee from 1 for 3) FROM v_transactions_flat",
  ])("%s", (sql) => {
    expect(ok(sql).ok).toBe(true);
  });

  it("enforces LIMIT 500 by wrapping (fetching one extra row to detect truncation)", () => {
    const r = ok("SELECT * FROM v_transactions_flat LIMIT 100000;");
    expect(r.wrapped).toMatch(/^SELECT \* FROM \(\nSELECT \* FROM v_transactions_flat LIMIT 100000\n\) AS homebase_ai_q LIMIT 501$/);
  });
});

describe("sql guard: rejects", () => {
  it.each([
    ["SELECT 1; SELECT 2", "only a single statement is allowed"],
    ["SELECT * FROM v_transactions_flat; DROP TABLE transactions", "only a single statement is allowed"],
    ["DELETE FROM transactions", "only SELECT or WITH queries are allowed"],
    ["UPDATE transactions SET approved = true", "only SELECT or WITH queries are allowed"],
    ["WITH x AS (DELETE FROM transactions RETURNING *) SELECT * FROM x", "keyword DELETE is not allowed"],
    ["SELECT * INTO newtable FROM v_transactions_flat", "keyword INTO is not allowed"],
    ["SELECT pg_sleep(10)", "system catalogs and pg_* functions are not allowed"],
    ["SELECT set_config('role', 'postgres', false)", "function set_config() is not allowed"],
    ["SELECT current_setting('is_superuser')", "function current_setting() is not allowed"],
    ["SELECT * FROM dblink('host=x', 'select 1') AS t(a int)", "function dblink() is not allowed"],
    ["COPY transactions TO '/tmp/x'", "only SELECT or WITH queries are allowed"],
    ["SELECT * FROM transactions", "relation transactions is not one of the reporting views"],
    ["SELECT * FROM v_transactions_flat t, users u", "relation users is not one of the reporting views"],
    ["SELECT * FROM v_transactions_flat JOIN connections c ON true", "relation connections is not one of the reporting views"],
    ["SELECT * FROM information_schema.tables", "system catalogs and pg_* functions are not allowed"],
    ["SELECT * FROM pg_catalog.pg_user", "system catalogs and pg_* functions are not allowed"],
    ["SELECT * FROM v_transactions_flat FOR UPDATE", "keyword UPDATE is not allowed"],
    ["SELECT $$x$$", "dollar-quoted strings and parameters are not allowed"],
    ["SELECT 'unterminated", "unterminated string literal"],
    ["SELECT lo_import('/etc/passwd')", "function lo_import() is not allowed"],
    ["SELECT * FROM secret.v_transactions_flat", "schema secret is not allowed"],
    ["  ", "empty query"],
    // Security review bypasses: quoted function names, U& escapes, output amplifiers.
    [`SELECT "set_config"('role', 'postgres', false)`, "function set_config() is not allowed"],
    [`SELECT "query_to_xml"('select * from users', true, false, '')`, "function query_to_xml() is not allowed"],
    [`SELECT "current_setting"('is_superuser')`, "function current_setting() is not allowed"],
    [`SELECT "Set_Config"('role', 'x', false)`, "function set_config() is not allowed"],
    [String.raw`WITH u AS (SELECT 1) SELECT rolname FROM u&"\0070g_roles"`, "Unicode escape (U&) strings and identifiers are not allowed"],
    [String.raw`SELECT U&'\0070g_roles' FROM v_transactions_flat`, "Unicode escape (U&) strings and identifiers are not allowed"],
    ["SELECT repeat('x',400000000) FROM generate_series(1,600)", "function repeat() is not allowed"],
    ["SELECT lpad('x', 400000000) FROM v_transactions_flat", "function lpad() is not allowed"],
    ["SELECT rpad('x', 400000000) FROM v_transactions_flat", "function rpad() is not allowed"],
    ["SELECT format('%400000000s', 'x') FROM v_transactions_flat", "function format() is not allowed"],
    ["SELECT array_fill(1, ARRAY[400000000])", "function array_fill() is not allowed"],
    ["SELECT query_to_xml('select 1', true, false, '')", "function query_to_xml() is not allowed"],
    ["SELECT query_to_xml_and_xmlschema('select 1', true, false, '')", "function query_to_xml_and_xmlschema() is not allowed"],
    ["SELECT * FROM ts_stat('select vector from secrets')", "function ts_stat() is not allowed"],
    [`SELECT "lower"(payee_name) FROM v_transactions_flat`, "quoted function names are not allowed"],
  ])("%s", (sql, reason) => {
    expect(rejected(sql)).toBe(reason);
  });

  it("still accepts ordinary quoted identifiers and the bitwise & operator", () => {
    ok(`SELECT payee_name AS "Payee" FROM v_transactions_flat`);
    ok("SELECT u & 1 FROM (SELECT 3 AS u) s");
  });
});

describe("sql_query result redaction (by value, not column name)", () => {
  const exec = (rows: Record<string, unknown>[], columnTypes?: number[]): ReadOnlySqlExecutor => ({
    async runReadOnly() {
      return { columns: Object.keys(rows[0] ?? {}), rows, ...(columnTypes ? { columnTypes } : {}) };
    },
  });

  it("masks 4+ digit runs in an aliased memo (SELECT memo AS m), keeps numbers, dates and uuids", async () => {
    const id = "0192f3a0-0000-7000-8000-00000000a001";
    const r = await runGuardedSql(
      // text, numeric, int8, date, uuid, json — the OIDs the real executor reports
      exec([{ m: "ACH 123456789 ref 4421 x12", a: "-1234567.000", c: 12345n, d: "2026-10-01", id, j: { note: "acct 99887766", n: 12345 } }], [25, 1700, 20, 1082, 2950, 3802]),
      "SELECT memo AS m, amount AS a, count(*) AS c, date AS d, transaction_id AS id, j FROM v_transactions_flat GROUP BY 1, 2, 4, 5, 6",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]).toEqual({ m: "ACH •••• ref •••• x12", a: "-1234567.000", c: "12345", d: "2026-10-01", id, j: { note: "acct ••••", n: 12345 } });
  });

  it("without type info, still masks every string (dates/uuids excepted) and leaves numbers alone", async () => {
    const r = await runGuardedSql(exec([{ m: "card 4111111111111111", y: "2026-10", n: 1234 }]), "SELECT memo AS m FROM v_transactions_flat");
    expect(r.ok && r.rows[0]).toEqual({ m: "card ••••", y: "2026-10", n: 1234 });
  });

  it("reports byte truncation from the executor", async () => {
    const e: ReadOnlySqlExecutor = { async runReadOnly() { return { columns: ["n"], rows: [{ n: 1 }], truncatedBytes: true }; } };
    const r = await runGuardedSql(e, "SELECT 1 AS n FROM v_transactions_flat");
    expect(r.ok && r.truncated).toBe(true);
  });
});

describe("read-only execution contract", () => {
  it("documents BEGIN READ ONLY + 5s timeout + ROLLBACK", () => {
    expect(readOnlySqlStatements("SELECT 1")).toEqual(["BEGIN TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '5000ms'", "SELECT 1", "ROLLBACK"]);
  });

  it("runs only validated SQL via the injected executor as homebase_ro, truncating at 500", async () => {
    const seen: { sql: string; role: string; timeoutMs: number }[] = [];
    const exec: ReadOnlySqlExecutor = {
      async runReadOnly(sql, o) {
        seen.push({ sql, ...o });
        return { columns: ["n"], rows: Array.from({ length: 501 }, (_, n) => ({ n })) };
      },
    };
    const r = await runGuardedSql(exec, "SELECT n FROM v_transactions_flat");
    expect(r.ok && r.rowCount).toBe(500);
    expect(r.ok && r.truncated).toBe(true);
    expect(seen[0]).toMatchObject({ role: "homebase_ro", timeoutMs: 5000 });
    const bad = await runGuardedSql(exec, "DROP TABLE x");
    expect(bad.ok).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
