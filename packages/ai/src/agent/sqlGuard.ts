/**
 * Guard for the agent's `sql_query` tool (spec §4.6, §11.3).
 *
 * Defence in depth — the static check here is the first layer only:
 *   1. this validator: a single SELECT/WITH statement, no DML/DDL/utility keywords, no dangerous
 *      functions, only the §5.5 reporting views (or CTE names) as relations, LIMIT 500 enforced;
 *   2. the injected executor MUST run the wrapped SQL as the `homebase_ro` role (SELECT on the
 *      reporting views only) inside `BEGIN READ ONLY` with `statement_timeout = 5s`, then ROLLBACK.
 *      `readOnlySqlStatements()` gives the exact statement sequence.
 */

import { redactDigits } from "../redact";

export const SQL_ROW_LIMIT = 500;
export const SQL_STATEMENT_TIMEOUT_MS = 5_000;
export const SQL_READONLY_ROLE = "homebase_ro";
export const SQL_MAX_LENGTH = 8_000;
/** Executor caps (the web process must never buffer an attacker-sized result). */
export const SQL_MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const SQL_MAX_CELL_CHARS = 4_096;
export const SQL_MAX_COLUMNS = 64;

/** §5.5 reporting views — the only relations the AI may read. */
export const REPORTING_VIEWS = [
  "v_transactions_flat",
  "v_month_category",
  "v_net_worth_daily",
  "v_holdings_latest",
  "v_cashflow_monthly",
  "v_payee_spend_monthly",
] as const;

/** Set-returning functions allowed in FROM. */
const ALLOWED_FROM_FUNCTIONS = new Set(["generate_series", "unnest", "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_each", "jsonb_each_text"]);

const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "merge", "upsert", "drop", "create", "alter", "truncate", "grant", "revoke",
  "copy", "vacuum", "analyze", "analyse", "call", "do", "execute", "prepare", "deallocate", "listen", "notify",
  "unlisten", "lock", "set", "reset", "begin", "commit", "rollback", "savepoint", "refresh", "cluster", "reindex",
  "import", "discard", "checkpoint", "into", "returning", "declare", "reassign",
];

/**
 * Applied to every function-call name AND every quoted identifier (`"set_config"(…)` is the same
 * function to Postgres).
 */
const FORBIDDEN_FUNCTION_PATTERNS = [
  /^pg_/, // pg_sleep, pg_read_file, pg_terminate_backend, pg_advisory_lock, pg_notify, ...
  /^dblink/,
  /^lo_/,
  /^set_config$/,
  /^current_setting$/,
  // These run a SQL string server-side, which would skip the relation allowlist entirely.
  /^query_to_xml/, // query_to_xml, query_to_xml_and_xmlschema, query_to_xmlschema
  /^table_to_xml/,
  /^cursor_to_xml/,
  /^schema_to_xml/,
  /^database_to_xml/,
  /^ts_stat$/,
  /^ts_rewrite$/,
  /^crosstab/, // tablefunc, if ever installed
  /^connectby$/,
  // Output amplifiers: one call can build a multi-hundred-MB value (memory DoS on Postgres and on
  // the web process that receives it). The executor also caps cell and result size.
  /^repeat$/,
  /^lpad$/,
  /^rpad$/,
  /^format$/, // width specifiers: format('%400000000s', 'x')
  /^array_fill$/,
  /^txid_/,
  /^nextval$/,
  /^setval$/,
  /^currval$/,
  /^lastval$/,
  /^inet_(server|client)_/,
  /^version$/,
  /^xpath/,
  /^file_/,
];

export type SqlCheck =
  | { ok: true; /** comments stripped, trailing semicolon removed */ sql: string; /** with LIMIT enforcement */ wrapped: string }
  | { ok: false; reason: string };

interface Scan {
  /** SQL with comments removed and literals intact. */
  clean: string;
  /** Lower-cased SQL with string literals and quoted identifiers blanked, for keyword scanning. */
  code: string;
  quotedIdentifiers: string[];
}

function scan(sql: string): Scan | { error: string } {
  let clean = "";
  let code = "";
  const quotedIdentifiers: string[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      clean += " ";
      code += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") (depth++, (i += 2));
        else if (sql[i] === "*" && sql[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
      if (depth > 0) return { error: "unterminated comment" };
      clean += " ";
      code += " ";
      continue;
    }
    if (c === "'") {
      const escapeMode = /[eE]/.test(sql[i - 1] ?? "") && !/[\w]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      for (;;) {
        if (j >= n) return { error: "unterminated string literal" };
        if (escapeMode && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      clean += sql.slice(i, j + 1);
      code += "''";
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let ident = "";
      for (;;) {
        if (j >= n) return { error: "unterminated quoted identifier" };
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            ident += '"';
            j += 2;
            continue;
          }
          break;
        }
        ident += sql[j];
        j++;
      }
      quotedIdentifiers.push(ident.toLowerCase());
      clean += sql.slice(i, j + 1);
      code += " qident ";
      i = j + 1;
      continue;
    }
    if (c === "$") {
      // Dollar quoting ($$...$$, $tag$...$tag$) and positional params ($1) are not allowed.
      return { error: "dollar-quoted strings and parameters are not allowed" };
    }
    if (c === "\\") return { error: "backslash outside a string literal" };
    clean += c;
    code += c.toLowerCase();
    i++;
  }
  return { clean, code, quotedIdentifiers };
}

function collectCteNames(code: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-z_][a-z0-9_]*)\s*(?:\([^)]*\)\s*)?as\s*(?:not\s+)?(?:materialized\s+)?\(/g;
  for (const m of code.matchAll(re)) if (m[1]) names.add(m[1]);
  return names;
}

/** Positions of statement-level FROM/JOIN keywords (skips EXTRACT(x FROM y), IS DISTINCT FROM, ...). */
function statementFromPositions(code: string): { index: number; length: number }[] {
  const out: { index: number; length: number }[] = [];
  const stack: number[] = [];
  const re = /[()]|\b(from|join)\b/g;
  for (const m of code.matchAll(re)) {
    const idx = m.index ?? 0;
    if (m[0] === "(") {
      stack.push(idx);
      continue;
    }
    if (m[0] === ")") {
      stack.pop();
      continue;
    }
    if (m[1] === "from" && /\bdistinct\s*$/.test(code.slice(0, idx))) continue;
    const open = stack[stack.length - 1];
    if (open !== undefined) {
      // Inside parentheses: only a subquery's own FROM counts. Strip nested parens first.
      let seg = code.slice(open + 1, idx);
      let prev = "";
      while (prev !== seg) {
        prev = seg;
        seg = seg.replace(/\([^()]*\)/g, " ");
      }
      if (!/\bselect\b/.test(seg)) continue;
    }
    out.push({ index: idx, length: m[0].length });
  }
  return out;
}

function checkRelations(code: string, allowed: Set<string>): string | null {
  const ctes = collectCteNames(code);
  for (const f of statementFromPositions(code)) {
    let pos = f.index + f.length;
    const lateral = /^\s+lateral\b/.exec(code.slice(pos));
    if (lateral) pos += lateral[0].length;
    for (;;) {
      const rest = code.slice(pos);
      if (/^\s*\(/.test(rest)) break; // subquery
      const rel = /^\s*([a-z_][a-z0-9_]*)(\s*\.\s*([a-z_][a-z0-9_]*))?(\s*\()?/.exec(rest);
      if (!rel) {
        if (/^\s*qident/.test(rest)) return "quoted relation names are not allowed";
        break;
      }
      const schema = rel[3] ? rel[1] : null;
      const name = (rel[3] ?? rel[1])!;
      if (rel[4]) {
        if (!ALLOWED_FROM_FUNCTIONS.has(name)) return `function ${name}() is not allowed in FROM`;
      } else {
        if (schema && schema !== "public") return `schema ${schema} is not allowed`;
        if (!allowed.has(name) && !ctes.has(name)) return `relation ${name} is not one of the reporting views`;
      }
      // Skip an optional alias (and a function's argument list); continue on a comma (FROM a x, b y).
      let after = code.slice(pos + rel[0].length);
      let consumed = rel[0].length;
      if (rel[4]) {
        let depth = 1;
        let k = 0;
        while (k < after.length && depth > 0) {
          if (after[k] === "(") depth++;
          else if (after[k] === ")") depth--;
          k++;
        }
        after = after.slice(k);
        consumed += k;
      }
      const tail = /^\s*(?:as\s+)?([a-z_][a-z0-9_]*)?\s*(?:\([^)]*\))?\s*(,)?/.exec(after);
      const aliasIsKeyword = tail?.[1] !== undefined && /^(on|where|group|order|limit|offset|join|left|right|inner|full|cross|natural|union|intersect|except|having|window|using)$/.test(tail[1]);
      if (tail && tail[2] && !aliasIsKeyword) {
        pos += consumed + tail[0].length;
        continue;
      }
      break;
    }
  }
  return null;
}

/** Validate an AI-written query. Returns the cleaned SQL and a LIMIT-enforcing wrapper. */
export function validateSelectSql(sql: string, opts: { allowedRelations?: readonly string[]; rowLimit?: number } = {}): SqlCheck {
  if (typeof sql !== "string" || sql.trim() === "") return { ok: false, reason: "empty query" };
  if (sql.length > SQL_MAX_LENGTH) return { ok: false, reason: "query too long" };
  const s = scan(sql);
  if ("error" in s) return { ok: false, reason: s.error };
  let { clean, code } = s;

  // Single statement: at most one trailing semicolon.
  const trimmedCode = code.trim();
  const semi = trimmedCode.indexOf(";");
  if (semi !== -1 && semi !== trimmedCode.length - 1) return { ok: false, reason: "only a single statement is allowed" };
  if (semi !== -1) {
    code = trimmedCode.slice(0, -1);
    clean = clean.trim().replace(/;\s*$/, "");
  }
  code = code.trim();
  clean = clean.trim();

  const first = /^\(*\s*([a-z]+)/.exec(code)?.[1];
  if (first !== "select" && first !== "with") return { ok: false, reason: "only SELECT or WITH queries are allowed" };

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(code)) return { ok: false, reason: `keyword ${kw.toUpperCase()} is not allowed` };
  }
  if (/\bfor\s+(update|share|no\s+key|key)\b/.test(code)) return { ok: false, reason: "locking clauses are not allowed" };
  // U&'…' / U&"…" (Unicode-escape literals and identifiers) can spell any name, e.g. U&"\0070g_roles"
  // is pg_roles, past every name check here. Nothing legitimate needs them.
  if (/(^|[^a-z0-9_$])u&\s*(''|qident\b)/.test(code)) return { ok: false, reason: "Unicode escape (U&) strings and identifiers are not allowed" };
  if (/\b(information_schema|pg_catalog)\b/.test(code) || /\bpg_[a-z0-9_]+/.test(code)) {
    return { ok: false, reason: "system catalogs and pg_* functions are not allowed" };
  }
  for (const m of code.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/g)) {
    const fn = m[1]!;
    if (FORBIDDEN_FUNCTION_PATTERNS.some((p) => p.test(fn))) return { ok: false, reason: `function ${fn}() is not allowed` };
  }
  for (const q of s.quotedIdentifiers) {
    if (q.startsWith("pg_") || q === "information_schema" || q === "pg_catalog") return { ok: false, reason: "system catalogs are not allowed" };
    if (FORBIDDEN_FUNCTION_PATTERNS.some((p) => p.test(q))) return { ok: false, reason: `function ${q}() is not allowed` };
  }
  // A quoted name used as a function ("lower"(x)) has no legitimate use and hides the name from the
  // call scan above; refuse it outright rather than trust the denylist to be complete.
  if (/\bqident\s*\(/.test(code)) return { ok: false, reason: "quoted function names are not allowed" };
  const allowed = new Set((opts.allowedRelations ?? REPORTING_VIEWS).map((r) => r.toLowerCase()));
  const relErr = checkRelations(code, allowed);
  if (relErr) return { ok: false, reason: relErr };

  const limit = opts.rowLimit ?? SQL_ROW_LIMIT;
  // Fetch one extra row so the executor result can report truncation.
  const wrapped = `SELECT * FROM (\n${clean}\n) AS homebase_ai_q LIMIT ${limit + 1}`;
  return { ok: true, sql: clean, wrapped };
}

/**
 * The exact statement sequence the db-layer executor must run on a connection authenticated as
 * `homebase_ro`. ROLLBACK (not COMMIT) so nothing can persist even if a check were bypassed.
 */
export function readOnlySqlStatements(wrappedSql: string, timeoutMs = SQL_STATEMENT_TIMEOUT_MS): string[] {
  return ["BEGIN TRANSACTION READ ONLY", `SET LOCAL statement_timeout = '${Math.max(1, Math.floor(timeoutMs))}ms'`, wrappedSql, "ROLLBACK"];
}

export interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Postgres type OID per column (same order as `columns`), when the executor knows it. */
  columnTypes?: number[];
  /** True when the executor stopped early at SQL_MAX_RESULT_BYTES. */
  truncatedBytes?: boolean;
}

/**
 * Injected executor for validated SQL. Implementations MUST:
 *  - connect as role `homebase_ro` (SELECT on §5.5 views only, role-level statement_timeout=5s),
 *  - run `readOnlySqlStatements(sql)` (BEGIN READ ONLY … ROLLBACK),
 *  - never run SQL that did not come from `validateSelectSql().wrapped`,
 *  - bound what it buffers: cells at SQL_MAX_CELL_CHARS (server-side, before transfer) and the whole
 *    result at about SQL_MAX_RESULT_BYTES (setting `truncatedBytes`).
 */
export interface ReadOnlySqlExecutor {
  runReadOnly(wrappedSql: string, opts: { timeoutMs: number; role: typeof SQL_READONLY_ROLE }): Promise<SqlResult>;
}

export async function runGuardedSql(
  executor: ReadOnlySqlExecutor,
  sql: string,
  opts: { rowLimit?: number } = {},
): Promise<{ ok: true; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; rowCount: number } | { ok: false; reason: string }> {
  const check = validateSelectSql(sql, opts);
  if (!check.ok) return check;
  const limit = opts.rowLimit ?? SQL_ROW_LIMIT;
  const res = await executor.runReadOnly(check.wrapped, { timeoutMs: SQL_STATEMENT_TIMEOUT_MS, role: SQL_READONLY_ROLE });
  const truncated = res.rows.length > limit || res.truncatedBytes === true;
  const nonText = new Set(res.columns.filter((_, i) => isNonTextOid(res.columnTypes?.[i])));
  // Text values are redacted by VALUE, not column name: `SELECT memo AS m` must not slip an account
  // number past REDACT_KEY_PATTERN (spec §9.3). Numbers stay numbers. int8 values (counts, *_milli
  // sums) come back as bigint; keep them as plain integer strings so the model JSON serializer
  // doesn't mistake a count for a money amount.
  const rows = (res.rows.length > limit ? res.rows.slice(0, limit) : res.rows).map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = typeof v === "bigint" ? v.toString() : nonText.has(k) ? v : redactSqlValue(v);
    return o;
  });
  return { ok: true, columns: res.columns, rows, truncated, rowCount: rows.length };
}

/**
 * Postgres types whose values are numbers, dates, times, uuids or booleans — never free text — and
 * so are passed through unredacted: int2/4/8, oid, float4/8, numeric, money, bool, date, time(tz),
 * timestamp(tz), interval, uuid.
 */
const NON_TEXT_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700, 790, 16, 1082, 1083, 1266, 1114, 1184, 1186, 2950]);
function isNonTextOid(oid: number | undefined): boolean {
  return oid !== undefined && NON_TEXT_OIDS.has(oid);
}

const ISO_DATEISH = /^\d{4}-\d{2}(-\d{2}([T ][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)?)?)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mask every run of 4+ digits in every string (deeply, for json/array values). A string that is
 * entirely an ISO date/month/timestamp (e.g. a `to_char` month) or a uuid is left alone.
 */
export function redactSqlValue(v: unknown): unknown {
  if (typeof v === "string") return ISO_DATEISH.test(v) || UUID_RE.test(v) ? v : redactDigits(v);
  if (Array.isArray(v)) return v.map(redactSqlValue);
  if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = redactSqlValue(x);
    return o;
  }
  return v;
}
