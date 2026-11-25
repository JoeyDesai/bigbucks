-- Hand-written migration: trigram search, split-sum integrity, and the §5.5 reporting views.
-- Objects here are invisible to drizzle-kit's snapshot; change them only through new custom migrations
-- (drizzle-kit generate --custom), and drop/recreate dependent views when altering their columns.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payees_name_trgm_idx ON payees USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transactions_raw_description_trgm_idx ON transactions USING gin (raw_description gin_trgm_ops);
--> statement-breakpoint

-- Split lines must sum to the parent amount; a non-split parent has no lines. Checked at commit
-- (DEFERRABLE INITIALLY DEFERRED) so a parent and its lines can be written in any order.
CREATE OR REPLACE FUNCTION check_transaction_split_sum() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ids uuid[];
  tid uuid;
  parent record;
  line_count int;
  line_sum bigint;
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'DELETE' THEN
    ids := ARRAY[OLD.transaction_id];
  ELSIF TG_OP = 'UPDATE' THEN
    ids := ARRAY[NEW.transaction_id, OLD.transaction_id];
  ELSE
    ids := ARRAY[NEW.transaction_id];
  END IF;
  FOREACH tid IN ARRAY ids LOOP
    SELECT amount_milli, is_split, deleted_at INTO parent FROM transactions WHERE id = tid;
    CONTINUE WHEN NOT FOUND OR parent.deleted_at IS NOT NULL;
    SELECT count(*), coalesce(sum(amount_milli), 0) INTO line_count, line_sum FROM transaction_splits WHERE transaction_id = tid;
    IF parent.is_split AND (line_count = 0 OR line_sum <> parent.amount_milli) THEN
      RAISE EXCEPTION 'split lines of transaction % sum to % but the transaction amount is %', tid, line_sum, parent.amount_milli
        USING ERRCODE = 'check_violation';
    ELSIF NOT parent.is_split AND line_count > 0 THEN
      RAISE EXCEPTION 'transaction % has % split lines but is_split is false', tid, line_count
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transaction_splits_sum_check
  AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transaction_split_sum();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transactions_split_sum_insert_check
  AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.is_split)
  EXECUTE FUNCTION check_transaction_split_sum();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transactions_split_sum_update_check
  AFTER UPDATE OF amount_milli, is_split, deleted_at ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.is_split OR OLD.is_split)
  EXECUTE FUNCTION check_transaction_split_sum();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION check_scheduled_split_sum() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ids uuid[];
  sid uuid;
  parent record;
  line_count int;
  line_sum bigint;
BEGIN
  IF TG_TABLE_NAME = 'scheduled_transactions' THEN
    ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'DELETE' THEN
    ids := ARRAY[OLD.scheduled_transaction_id];
  ELSIF TG_OP = 'UPDATE' THEN
    ids := ARRAY[NEW.scheduled_transaction_id, OLD.scheduled_transaction_id];
  ELSE
    ids := ARRAY[NEW.scheduled_transaction_id];
  END IF;
  FOREACH sid IN ARRAY ids LOOP
    SELECT amount_milli, is_split, deleted_at INTO parent FROM scheduled_transactions WHERE id = sid;
    CONTINUE WHEN NOT FOUND OR parent.deleted_at IS NOT NULL;
    SELECT count(*), coalesce(sum(amount_milli), 0) INTO line_count, line_sum FROM scheduled_transaction_splits WHERE scheduled_transaction_id = sid;
    IF parent.is_split AND (line_count = 0 OR line_sum <> parent.amount_milli) THEN
      RAISE EXCEPTION 'split lines of scheduled transaction % sum to % but the amount is %', sid, line_sum, parent.amount_milli
        USING ERRCODE = 'check_violation';
    ELSIF NOT parent.is_split AND line_count > 0 THEN
      RAISE EXCEPTION 'scheduled transaction % has % split lines but is_split is false', sid, line_count
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER scheduled_transaction_splits_sum_check
  AFTER INSERT OR UPDATE OR DELETE ON scheduled_transaction_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_scheduled_split_sum();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER scheduled_transactions_split_sum_insert_check
  AFTER INSERT ON scheduled_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.is_split)
  EXECUTE FUNCTION check_scheduled_split_sum();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER scheduled_transactions_split_sum_update_check
  AFTER UPDATE OF amount_milli, is_split, deleted_at ON scheduled_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.is_split OR OLD.is_split)
  EXECUTE FUNCTION check_scheduled_split_sum();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Reporting views (§5.5). The AI's SQL tool (role homebase_ro) can read only v_* views.
-- They expose names and amounts, never raw bank descriptions, external ids or credentials.
-- ---------------------------------------------------------------------------

-- One row per transaction, or per split line for split transactions.
CREATE VIEW v_transactions_flat AS
SELECT
  t.id AS transaction_id,
  s.id AS split_id,
  t.date,
  date_trunc('month', t.date)::date AS month,
  a.id AS account_id,
  a.name AS account_name,
  a.kind AS account_kind,
  a.on_budget,
  e.id AS entity_id,
  e.name AS entity_name,
  coalesce(s.amount_milli, t.amount_milli) AS amount_milli,
  p.id AS payee_id,
  p.name AS payee_name,
  c.id AS category_id,
  c.name AS category_name,
  c.kind AS category_kind,
  g.id AS group_id,
  g.name AS group_name,
  coalesce(s.memo, t.memo) AS memo,
  ta.id AS transfer_account_id,
  ta.name AS transfer_account_name,
  (ta.id IS NOT NULL) AS is_transfer,
  t.is_split,
  t.is_starting_balance,
  (a.on_budget AND NOT t.is_starting_balance AND (c.kind = 'uncategorized' OR (c.id IS NULL AND ta.id IS NULL))) AS is_uncategorized,
  t.cleared,
  t.approved,
  t.flag,
  t.catz ->> 'method' AS catz_method
FROM transactions t
JOIN accounts a ON a.id = t.account_id
JOIN entities e ON e.id = a.entity_id
LEFT JOIN transaction_splits s ON t.is_split AND s.transaction_id = t.id
LEFT JOIN payees p ON p.id = coalesce(s.payee_id, t.payee_id)
LEFT JOIN categories c ON c.id = CASE WHEN t.is_split THEN s.category_id ELSE t.category_id END
LEFT JOIN category_groups g ON g.id = c.group_id
LEFT JOIN accounts ta ON ta.id = CASE WHEN t.is_split THEN s.transfer_account_id ELSE t.transfer_account_id END
WHERE t.deleted_at IS NULL;
--> statement-breakpoint

-- Engine output for the latest engine_version, with the target in effect that month.
CREATE VIEW v_month_category AS
SELECT
  m.engine_version,
  m.month,
  m.category_id,
  c.name AS category_name,
  c.kind AS category_kind,
  c.hidden,
  g.id AS group_id,
  g.name AS group_name,
  m.assigned_milli,
  m.activity_milli,
  m.available_milli,
  m.carry_in_milli,
  m.cash_overspend_milli,
  m.credit_overspend_milli,
  m.needed_milli,
  m.underfunded_milli,
  tg.type AS target_type,
  tg.amount_milli AS target_amount_milli,
  tg.cadence AS target_cadence
FROM budget_month_cache m
JOIN categories c ON c.id = m.category_id
JOIN category_groups g ON g.id = c.group_id
LEFT JOIN LATERAL (
  SELECT t.type, t.amount_milli, t.cadence, t.removed
  FROM targets t
  WHERE t.category_id = m.category_id AND t.effective_from <= m.month
  ORDER BY t.effective_from DESC
  LIMIT 1
) tg ON NOT tg.removed
WHERE m.engine_version = (SELECT max(engine_version) FROM budget_month_cache);
--> statement-breakpoint

CREATE VIEW v_month_summary AS
SELECT engine_version, month, rta_milli, assigned_future_milli, cost_to_be_me_milli, age_of_money
FROM budget_month_summary
WHERE engine_version = (SELECT max(engine_version) FROM budget_month_summary);
--> statement-breakpoint

-- Every account on every day between the first and last balance snapshot, carrying the last known balance forward.
CREATE VIEW v_balances_daily AS
WITH bounds AS (
  SELECT min(as_of) AS lo, max(as_of) AS hi FROM balances
), days AS (
  SELECT generate_series(lo::timestamp, hi::timestamp, interval '1 day')::date AS date
  FROM bounds
  WHERE lo IS NOT NULL
)
SELECT
  d.date,
  a.id AS account_id,
  a.name AS account_name,
  a.kind AS account_kind,
  a.on_budget,
  a.closed,
  e.id AS entity_id,
  e.name AS entity_name,
  b.current_milli AS balance_milli,
  b.as_of AS balance_as_of
FROM days d
CROSS JOIN accounts a
JOIN entities e ON e.id = a.entity_id
JOIN LATERAL (
  SELECT bb.current_milli, bb.as_of
  FROM balances bb
  WHERE bb.account_id = a.id AND bb.as_of <= d.date
  ORDER BY bb.as_of DESC
  LIMIT 1
) b ON true
WHERE a.deleted_at IS NULL;
--> statement-breakpoint

-- Net worth per entity per day. Liabilities are negative balances.
CREATE VIEW v_net_worth_daily AS
SELECT
  date,
  entity_id,
  entity_name,
  coalesce(sum(balance_milli) FILTER (WHERE account_kind IN ('checking', 'savings', 'cash')), 0)::bigint AS cash_milli,
  coalesce(sum(balance_milli) FILTER (WHERE account_kind IN ('credit_card', 'line_of_credit')), 0)::bigint AS credit_milli,
  coalesce(sum(balance_milli) FILTER (WHERE account_kind IN ('brokerage', 'retirement', 'hsa')), 0)::bigint AS investments_milli,
  coalesce(sum(balance_milli) FILTER (WHERE account_kind = 'crypto'), 0)::bigint AS crypto_milli,
  coalesce(sum(balance_milli) FILTER (WHERE account_kind = 'property'), 0)::bigint AS property_milli,
  coalesce(sum(balance_milli) FILTER (WHERE account_kind IN ('mortgage', 'loan')), 0)::bigint AS loans_milli,
  coalesce(sum(balance_milli) FILTER (WHERE account_kind = 'other'), 0)::bigint AS other_milli,
  coalesce(sum(greatest(balance_milli, 0)), 0)::bigint AS assets_milli,
  coalesce(sum(least(balance_milli, 0)), 0)::bigint AS liabilities_milli,
  coalesce(sum(balance_milli), 0)::bigint AS net_worth_milli
FROM v_balances_daily
GROUP BY date, entity_id, entity_name;
--> statement-breakpoint

-- Latest snapshot per account, lots summed per symbol.
CREATE VIEW v_holdings_latest AS
WITH latest AS (
  SELECT account_id, max(as_of) AS as_of FROM holdings GROUP BY account_id
)
SELECT
  h.account_id,
  a.name AS account_name,
  a.kind AS account_kind,
  e.name AS entity_name,
  h.as_of,
  h.symbol,
  max(h.name) AS name,
  sum(h.quantity) AS quantity,
  max(h.price) AS price,
  sum(h.market_value_milli)::bigint AS market_value_milli,
  sum(h.cost_basis_milli)::bigint AS cost_basis_milli,
  count(*)::int AS lots
FROM holdings h
JOIN latest l ON l.account_id = h.account_id AND l.as_of = h.as_of
JOIN accounts a ON a.id = h.account_id
JOIN entities e ON e.id = a.entity_id
WHERE a.deleted_at IS NULL
GROUP BY h.account_id, a.name, a.kind, e.name, h.as_of, h.symbol;
--> statement-breakpoint

-- Budget cash flow (on-budget accounts): income = inflows to Ready to Assign; expense = everything categorized
-- elsewhere (net of refunds), uncategorized spending, and categorized transfers to tracking accounts.
CREATE VIEW v_cashflow_monthly AS
WITH m AS (
  SELECT
    month,
    coalesce(sum(amount_milli) FILTER (WHERE category_kind = 'internal_rta'), 0)::bigint AS income_milli,
    coalesce(-sum(amount_milli) FILTER (
      WHERE category_kind IS DISTINCT FROM 'internal_rta' AND NOT (is_transfer AND category_id IS NULL)
    ), 0)::bigint AS expense_milli
  FROM v_transactions_flat
  WHERE on_budget AND NOT is_starting_balance AND cleared <> 'pending'
  GROUP BY month
)
SELECT
  month,
  income_milli,
  expense_milli,
  income_milli - expense_milli AS net_milli,
  CASE WHEN income_milli > 0 THEN round((income_milli - expense_milli)::numeric / income_milli, 4) END AS savings_rate
FROM m;
--> statement-breakpoint

-- Spending per payee per month (on-budget, excluding transfers and income).
CREATE VIEW v_payee_spend_monthly AS
SELECT
  month,
  payee_id,
  payee_name,
  coalesce(-sum(amount_milli) FILTER (WHERE amount_milli < 0), 0)::bigint AS outflow_milli,
  coalesce(sum(amount_milli) FILTER (WHERE amount_milli > 0), 0)::bigint AS inflow_milli,
  (-sum(amount_milli))::bigint AS spend_milli,
  count(DISTINCT transaction_id)::int AS txn_count
FROM v_transactions_flat
WHERE on_budget
  AND NOT is_transfer
  AND NOT is_starting_balance
  AND payee_id IS NOT NULL
  AND cleared <> 'pending'
  AND category_kind IS DISTINCT FROM 'internal_rta'
GROUP BY month, payee_id, payee_name;
