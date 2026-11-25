import pg from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/client";
import { configureReadOnlyRole, runMigrations, RO_ROLE } from "../src/migrate";
import * as s from "../src/schema";
import { allTableNames, buildDemoData, DEMO_FIRST_MONTH, DEMO_TODAY, seedDemo } from "../src/seed/demo";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_test";
const RO_PASSWORD = "homebase-ro-test";

let db: Db;
let pool: pg.Pool;

async function count(query: string): Promise<number> {
  const { rows } = await pool.query<{ n: bigint }>(query);
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  const dbName = new URL(TEST_URL).pathname.slice(1);
  if (!dbName.endsWith("_test")) throw new Error(`refusing to reset ${dbName}: test database names must end in _test`);
  const admin = new pg.Client({ connectionString: TEST_URL });
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.end();

  await runMigrations(TEST_URL, { roPassword: RO_PASSWORD });
  ({ db, pool } = createDb(TEST_URL, { max: 4 }));
  await seedDemo(db);
});

afterAll(async () => {
  if (!pool) return;
  await configureReadOnlyRole(pool, null);
  await pool.end();
});

describe("migrations", () => {
  it("creates every schema table and the reporting views", async () => {
    const { rows } = await pool.query<{ table_name: string; table_type: string }>(
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tables = rows.filter((r) => r.table_type === "BASE TABLE").map((r) => r.table_name).sort();
    const views = rows.filter((r) => r.table_type === "VIEW").map((r) => r.table_name).sort();
    expect(tables).toEqual(allTableNames().sort());
    expect(tables).toHaveLength(41);
    expect(views).toEqual([
      "v_balances_daily",
      "v_cashflow_monthly",
      "v_holdings_latest",
      "v_month_category",
      "v_month_summary",
      "v_net_worth_daily",
      "v_payee_spend_monthly",
      "v_transactions_flat",
    ]);
  });

  it("is idempotent", async () => {
    await expect(runMigrations(TEST_URL, { roPassword: RO_PASSWORD })).resolves.toBeUndefined();
  });

  it("adds the bucket rollover columns (0003_rollover), off by default", async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'categories' AND column_name LIKE 'rollover%' ORDER BY column_name",
    );
    expect(rows.map((r) => [r.column_name, r.data_type, r.is_nullable])).toEqual([
      ["rollover", "boolean", "NO"],
      ["rollover_from", "date", "YES"],
      ["rollover_opening_milli", "bigint", "NO"],
    ]);
    expect(await count("SELECT count(*) AS n FROM categories WHERE rollover OR rollover_from IS NOT NULL OR rollover_opening_milli <> 0")).toBe(0);
    const [c] = await db.select().from(s.categories).limit(1);
    expect(c).toMatchObject({ rollover: false, rolloverFrom: null, rolloverOpeningMilli: 0n });
  });

  it("adds the savings bucket columns (0004_savings_buckets): spending by default, no target", async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'categories' AND column_name IN ('bucket_kind', 'savings_target_milli') ORDER BY column_name",
    );
    expect(rows.map((r) => [r.column_name, r.data_type, r.is_nullable])).toEqual([
      ["bucket_kind", "text", "NO"],
      ["savings_target_milli", "bigint", "YES"],
    ]);
    expect(rows[0]?.column_default).toBe("'spending'::text");
    expect(await count("SELECT count(*) AS n FROM categories WHERE bucket_kind <> 'spending' OR savings_target_milli IS NOT NULL")).toBe(0);
    const [c] = await db.select().from(s.categories).limit(1);
    expect(c).toMatchObject({ bucketKind: "spending", savingsTargetMilli: null });
  });

  it("installs pg_trgm and the trigram indexes", async () => {
    expect(await count("SELECT count(*) AS n FROM pg_extension WHERE extname = 'pg_trgm'")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM pg_indexes WHERE indexname IN ('payees_name_trgm_idx', 'transactions_raw_description_trgm_idx')")).toBe(2);
    const { rows } = await pool.query<{ name: string }>("SELECT name FROM payees WHERE similarity(name, 'Krogr') > 0.3 ORDER BY similarity(name, 'Krogr') DESC LIMIT 1");
    expect(rows[0]?.name).toBe("Kroger");
  });
});

describe("pg type parsing", () => {
  it("returns int8 as bigint and dates as strings from raw queries", async () => {
    const { rows } = await pool.query("SELECT 9007199254740993::int8 AS big, '2026-10-22'::date AS day, ARRAY[1, 2]::int8[] AS arr");
    expect(rows[0].big).toBe(9007199254740993n);
    expect(rows[0].day).toBe("2026-10-22");
    expect(rows[0].arr).toEqual([1n, 2n]);
  });

  it("returns money as bigint and dates as strings through drizzle", async () => {
    const [t] = await db.select().from(s.transactions).limit(1);
    expect(typeof t!.amountMilli).toBe("bigint");
    expect(t!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const raw = await db.execute<{ total: bigint }>(sql`SELECT sum(amount_milli)::bigint AS total FROM transactions`);
    expect(typeof raw.rows[0]!.total).toBe("bigint");
  });
});

describe("demo seed", () => {
  it("inserts what buildDemoData produced", async () => {
    const data = buildDemoData();
    expect(await count("SELECT count(*) AS n FROM users")).toBe(2);
    expect(await count("SELECT count(*) AS n FROM entities")).toBe(2);
    expect(await count("SELECT count(*) AS n FROM accounts")).toBe(12);
    expect(await count("SELECT count(*) AS n FROM accounts WHERE on_budget")).toBe(4);
    expect(await count("SELECT count(*) AS n FROM transactions")).toBe(data.transactions.length);
    expect(await count("SELECT count(*) AS n FROM transaction_splits")).toBe(data.transactionSplits.length);
    expect(await count("SELECT count(*) AS n FROM holdings")).toBe(data.holdings.length);
    expect(data.transactions.length).toBeGreaterThan(1000);
  });

  it("covers 18 months up to the fixed today", async () => {
    const { rows } = await pool.query("SELECT min(date) AS lo, max(date) AS hi, count(DISTINCT date_trunc('month', date)) AS months FROM transactions");
    expect(rows[0]).toEqual({ lo: DEMO_FIRST_MONTH, hi: DEMO_TODAY, months: 18n });
    expect(await count("SELECT count(DISTINCT month) AS n FROM month_assignments WHERE month <= '2026-10-01'")).toBe(18);
    expect(await count("SELECT count(DISTINCT as_of) AS n FROM balances")).toBe(540);
  });

  it("has the Appendix A category tree and system categories", async () => {
    const { rows } = await pool.query<{ kind: string; n: bigint }>("SELECT kind, count(*) AS n FROM categories GROUP BY kind ORDER BY kind");
    expect(Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]))).toEqual({ normal: 35, cc_payment: 2, internal_rta: 1, uncategorized: 1 });
    expect(await count("SELECT count(*) AS n FROM categories c JOIN accounts a ON a.id = c.linked_account_id WHERE c.kind = 'cc_payment' AND a.kind = 'credit_card'")).toBe(2);
    expect(await count("SELECT count(*) AS n FROM categories WHERE name IN ('Giving', 'Mortgage', 'Misc', 'YNAB subscription')")).toBe(4);
  });

  it("stores category names without emoji, with lucide icons, and user accents", async () => {
    const { rows } = await pool.query<{ name: string; icon: string | null; kind: string }>("SELECT name, icon, kind FROM categories ORDER BY name");
    // No stored name starts or ends with an emoji (the seed writes them YNAB-style and strips them).
    for (const r of rows) expect(r.name).toMatch(/^[\p{L}\p{N}]/u);
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("Mortgage")?.icon).toBe("house");
    expect(byName.get("Savings")?.icon).toBe("landmark");
    expect(byName.get("Alex's Retirement")?.icon).toBe("piggy-bank");
    expect(byName.get("Cash Back Card")?.icon).toBe("credit-card");
    expect(byName.get("Giving")?.icon).toBe("hand-heart");
    expect(byName.get("Inflow: Ready to Assign")?.icon).toBeNull();
    expect(rows.filter((r) => r.kind === "normal" && !r.icon)).toEqual([]);
    const users = await pool.query<{ display_name: string; accent: string }>("SELECT display_name, accent FROM users ORDER BY display_name");
    expect(users.rows).toEqual([
      { display_name: "Alex", accent: "blue" },
      { display_name: "Sam", accent: "pink" },
    ]);
  });

  it("keeps target history for Giving", async () => {
    const { rows } = await pool.query(
      "SELECT t.effective_from, t.amount_milli FROM targets t JOIN categories c ON c.id = t.category_id WHERE c.name = 'Giving' ORDER BY 1",
    );
    expect(rows).toEqual([
      { effective_from: "2025-05-01", amount_milli: 450_000n },
      { effective_from: "2026-01-01", amount_milli: 500_000n },
    ]);
  });

  it("every split sums to its parent", async () => {
    expect(await count("SELECT count(*) AS n FROM transactions WHERE is_split")).toBeGreaterThan(20);
    expect(
      await count(`SELECT count(*) AS n FROM transactions t
        LEFT JOIN (SELECT transaction_id, sum(amount_milli) AS total FROM transaction_splits GROUP BY 1) sp ON sp.transaction_id = t.id
        WHERE (t.is_split AND sp.total IS DISTINCT FROM t.amount_milli) OR (NOT t.is_split AND sp.total IS NOT NULL)`),
    ).toBe(0);
    expect(
      await count(`SELECT count(*) AS n FROM scheduled_transactions t
        LEFT JOIN (SELECT scheduled_transaction_id, sum(amount_milli) AS total FROM scheduled_transaction_splits GROUP BY 1) sp ON sp.scheduled_transaction_id = t.id
        WHERE (t.is_split AND sp.total IS DISTINCT FROM t.amount_milli) OR (NOT t.is_split AND sp.total IS NOT NULL)`),
    ).toBe(0);
  });

  it("pairs every transfer both ways with opposite amounts", async () => {
    expect(await count("SELECT count(*) AS n FROM transactions WHERE transfer_account_id IS NOT NULL")).toBeGreaterThan(100);
    expect(
      await count(`SELECT count(*) AS n FROM transactions a LEFT JOIN transactions b ON b.id = a.transfer_pair_id
        WHERE a.transfer_account_id IS NOT NULL
          AND (b.id IS NULL OR b.transfer_pair_id <> a.id OR b.amount_milli <> -a.amount_milli OR b.account_id <> a.transfer_account_id)`),
    ).toBe(0);
  });

  it("has the October 2026 review queue and uncategorized activity", async () => {
    expect(await count("SELECT count(*) AS n FROM transactions WHERE NOT approved AND date > '2026-10-12'")).toBeGreaterThanOrEqual(8);
    expect(await count("SELECT count(*) AS n FROM transactions WHERE NOT approved AND date <= '2026-10-12'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM transactions WHERE NOT approved AND catz IS NULL")).toBe(0);
    const { rows } = await pool.query(
      "SELECT sum(amount_milli)::bigint AS total FROM v_transactions_flat WHERE is_uncategorized AND month = '2026-10-01'",
    );
    expect(rows[0].total).toBe(-426_500n);
  });

  it("leaves Misc and Eating Out overspent on credit in October 2026, everything else covered", async () => {
    // No overspending was ever left uncovered before October, so available = Σ assigned + Σ activity.
    const { rows } = await pool.query<{ name: string; available: bigint }>(`
      WITH a AS (SELECT category_id, sum(assigned_milli) AS s FROM month_assignments WHERE month <= '2026-10-01' GROUP BY 1),
           t AS (SELECT category_id, sum(amount_milli) AS s FROM v_transactions_flat
                 WHERE on_budget AND month <= '2026-10-01' AND cleared <> 'pending' GROUP BY 1)
      SELECT c.name, (coalesce(a.s, 0) + coalesce(t.s, 0))::bigint AS available
      FROM categories c LEFT JOIN a ON a.category_id = c.id LEFT JOIN t ON t.category_id = c.id
      WHERE c.kind = 'normal' AND coalesce(a.s, 0) + coalesce(t.s, 0) < 0 ORDER BY 1`);
    expect(rows).toEqual([
      { name: "Eating Out", available: -64_180n },
      { name: "Misc", available: -137_420n },
    ]);
    const cash = await count(`SELECT count(*) AS n FROM v_transactions_flat
      WHERE month = '2026-10-01' AND category_name IN ('Misc', 'Eating Out') AND account_kind <> 'credit_card'`);
    expect(cash).toBe(0);
  });

  it("feeds the reporting views", async () => {
    expect(await count("SELECT count(*) AS n FROM v_net_worth_daily WHERE date = '2026-10-22'")).toBe(2);
    const { rows } = await pool.query("SELECT net_worth_milli FROM v_net_worth_daily WHERE date = '2026-10-22' AND entity_name = 'Household'");
    expect(rows[0].net_worth_milli).toBeGreaterThan(300_000_000n);
    expect(await count("SELECT count(*) AS n FROM v_holdings_latest WHERE account_name = 'Litware 401k (Alex)' AND lots = 2")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM v_cashflow_monthly")).toBe(18);
    expect(await count("SELECT count(*) AS n FROM v_payee_spend_monthly WHERE payee_name = 'Netflix'")).toBe(18);
    expect(await count("SELECT count(*) AS n FROM v_month_category")).toBe(0); // filled by the engine, not the seed
  });

  it("is idempotent and deterministic", async () => {
    const snapshot = () => pool.query("SELECT id, amount_milli, category_id, approved FROM transactions ORDER BY id").then((r) => r.rows);
    const before = await snapshot();
    await seedDemo(db);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses to wipe a database holding non-demo data unless forced", async () => {
    await pool.query("DELETE FROM settings WHERE key = 'demo_seed'");
    await expect(seedDemo(db)).rejects.toThrow(/Refusing to seed/);
    await seedDemo(db, { force: true });
    expect(await count("SELECT count(*) AS n FROM settings WHERE key = 'demo_seed'")).toBe(1);
  });
});

describe("split-sum constraint trigger", () => {
  it("rejects split lines that don't add up, at commit", async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query("SELECT id, amount_milli FROM transactions WHERE is_split LIMIT 1");
      const { id } = rows[0];
      await client.query("BEGIN");
      await client.query("UPDATE transaction_splits SET amount_milli = amount_milli - 10 WHERE id = (SELECT id FROM transaction_splits WHERE transaction_id = $1 LIMIT 1)", [id]);
      await expect(client.query("COMMIT")).rejects.toThrow(/split lines of transaction .* sum to/);
    } finally {
      client.release();
    }
  });

  it("allows a parent and its lines to be written in either order within a transaction", async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query("SELECT id FROM accounts WHERE name = 'Checking'");
      await client.query("BEGIN");
      const tx = await client.query(
        "INSERT INTO transactions (id, account_id, date, amount_milli, is_split, source) VALUES (gen_random_uuid(), $1, '2026-10-21', -30000, true, 'manual') RETURNING id",
        [rows[0].id],
      );
      await client.query("INSERT INTO transaction_splits (id, transaction_id, amount_milli) VALUES (gen_random_uuid(), $1, -10000), (gen_random_uuid(), $1, -20000)", [tx.rows[0].id]);
      await client.query("UPDATE transactions SET amount_milli = -35000 WHERE id = $1", [tx.rows[0].id]);
      await client.query("INSERT INTO transaction_splits (id, transaction_id, amount_milli) VALUES (gen_random_uuid(), $1, -5000)", [tx.rows[0].id]);
      await expect(client.query("COMMIT")).resolves.toBeDefined();
      await client.query("DELETE FROM transactions WHERE id = $1", [tx.rows[0].id]);
    } finally {
      client.release();
    }
  });

  it("rejects split lines on a non-split transaction", async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query("SELECT id FROM transactions WHERE NOT is_split LIMIT 1");
      await client.query("BEGIN");
      await client.query("INSERT INTO transaction_splits (id, transaction_id, amount_milli) VALUES (gen_random_uuid(), $1, -1000)", [rows[0].id]);
      await expect(client.query("COMMIT")).rejects.toThrow(/is_split is false/);
    } finally {
      client.release();
    }
  });
});

describe("homebase_ro role", () => {
  let ro: pg.Client;
  beforeAll(async () => {
    const url = new URL(TEST_URL);
    url.username = RO_ROLE;
    url.password = RO_PASSWORD;
    ro = new pg.Client({ connectionString: url.toString() });
    await ro.connect();
  });
  afterAll(async () => {
    await ro?.end();
  });

  it("can read the reporting views", async () => {
    const { rows } = await ro.query("SELECT count(*) AS n FROM v_transactions_flat");
    expect(rows[0].n).toBeGreaterThan(1000n);
  });

  it("cannot read base tables", async () => {
    await expect(ro.query("SELECT * FROM transactions LIMIT 1")).rejects.toThrow(/permission denied/);
    await expect(ro.query("SELECT * FROM connections LIMIT 1")).rejects.toThrow(/permission denied/);
  });

  it("runs read-only with a 5 s statement timeout", async () => {
    expect((await ro.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("5s");
    expect((await ro.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only).toBe("on");
    await expect(ro.query("CREATE TEMP TABLE x (a int)")).rejects.toThrow(/read-only transaction/);
  });
});
