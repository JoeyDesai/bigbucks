/**
 * Homebase database schema (spec §5). Money is bigint milliunits in `*_milli` columns,
 * calendar dates are `date` columns read as "YYYY-MM-DD" strings, months are first-of-month dates.
 * IDs are uuid v7 generated app-side (`newId()`), so the schema works on PG16 and PG18 alike.
 *
 * Reporting views, trigram indexes and the split-sum trigger live in the hand-written
 * migration `migrations/0001_reporting.sql`; the view column shapes are mirrored at the bottom of this file.
 */
import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ACCOUNT_KINDS,
  ACCOUNT_SOURCES,
  CADENCES,
  CATEGORY_KINDS,
  CATZ_METHODS,
  CLEARED,
  FLAGS,
  FREQUENCIES,
  TARGET_TYPES,
  newId,
  type Catz,
} from "@homebase/shared";

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

const id = () => uuid("id").primaryKey().$defaultFn(newId);
const milli = (name: string) => bigint(name, { mode: "bigint" });
const day = (name: string) => date(name, { mode: "string" });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const usd = (name: string) => numeric(name, { precision: 12, scale: 6 });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

const timestamps = {
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------
// Enums. Values shared with other packages come from @homebase/shared/types.ts.
// ---------------------------------------------------------------------------

export const USER_ROLES = ["admin", "member"] as const;
export const BALANCE_SIGNS = ["normal", "inverted"] as const;
/** Account sources plus rows the app itself creates. */
export const TRANSACTION_SOURCES = [...ACCOUNT_SOURCES, "scheduled", "reconciliation"] as const;
export const PAYEE_MATCH_KINDS = ["exact", "prefix", "regex"] as const;
export const BUDGET_OPERATION_KINDS = ["assign", "move", "auto_assign", "reset", "target_edit", "category_edit", "group_edit", "note_edit"] as const;
export const TARGET_INCOME_BASES = ["rta_inflows", "gross_pay"] as const;
export const RULE_SOURCES = ["user", "learned", "ai_suggested"] as const;
export const ASSET_KINDS = ["home"] as const;
export const VALUATION_SOURCES = ["rentcast", "manual"] as const;
export const LOAN_EVENT_KINDS = ["extra_principal", "recast", "rate_change", "statement_balance"] as const;
export const CONNECTION_PROVIDERS = ["simplefin", "mercury", "coinbase", "river", "xpub", "rentcast", "gusto", "ynab", "anthropic", "openai"] as const;
export const CONNECTION_STATUSES = ["ok", "needs_attention", "error", "disabled"] as const;
export const SYNC_STATUSES = ["running", "ok", "partial", "error"] as const;
export const AI_ROLES = ["user", "assistant"] as const;
export const AI_TOOL_CALL_STATUSES = ["auto", "awaiting_confirmation", "confirmed", "rejected"] as const;
export const AI_PURPOSES = ["chat", "categorize", "batch_categorize", "merchant_lookup", "digest", "report"] as const;
export const AUDIT_ACTORS = ["user", "ai", "system"] as const;

export const userRole = pgEnum("user_role", USER_ROLES);
export const accountKind = pgEnum("account_kind", ACCOUNT_KINDS);
export const accountSource = pgEnum("account_source", ACCOUNT_SOURCES);
export const balanceSign = pgEnum("balance_sign", BALANCE_SIGNS);
export const categoryKind = pgEnum("category_kind", CATEGORY_KINDS);
export const targetType = pgEnum("target_type", TARGET_TYPES);
export const cadence = pgEnum("cadence", CADENCES);
export const targetIncomeBasis = pgEnum("target_income_basis", TARGET_INCOME_BASES);
export const payeeMatch = pgEnum("payee_match", PAYEE_MATCH_KINDS);
export const cleared = pgEnum("cleared", CLEARED);
export const flag = pgEnum("flag", FLAGS);
export const transactionSource = pgEnum("transaction_source", TRANSACTION_SOURCES);
export const frequency = pgEnum("frequency", FREQUENCIES);
export const budgetOperationKind = pgEnum("budget_operation_kind", BUDGET_OPERATION_KINDS);
export const ruleSource = pgEnum("rule_source", RULE_SOURCES);
export const catzMethod = pgEnum("catz_method", CATZ_METHODS);
export const assetKind = pgEnum("asset_kind", ASSET_KINDS);
export const valuationSource = pgEnum("valuation_source", VALUATION_SOURCES);
export const loanEventKind = pgEnum("loan_event_kind", LOAN_EVENT_KINDS);
export const connectionProvider = pgEnum("connection_provider", CONNECTION_PROVIDERS);
export const connectionStatus = pgEnum("connection_status", CONNECTION_STATUSES);
export const syncStatus = pgEnum("sync_status", SYNC_STATUSES);
export const aiRole = pgEnum("ai_role", AI_ROLES);
export const aiToolCallStatus = pgEnum("ai_tool_call_status", AI_TOOL_CALL_STATUSES);
export const aiPurpose = pgEnum("ai_purpose", AI_PURPOSES);
export const auditActor = pgEnum("audit_actor", AUDIT_ACTORS);

// ---------------------------------------------------------------------------
// Users and auth (§2)
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: id(),
  tailscaleLogin: text("tailscale_login").unique(),
  /** Sign-in email for Cloudflare Access (on the public hostname); matched case-insensitively. */
  email: text("email").unique(),
  displayName: text("display_name").notNull(),
  role: userRole("role").notNull().default("member"),
  /** Sign-in name for the password login (on the public hostname), matched case-insensitively. */
  username: text("username").unique(),
  /** argon2id hash of the password (the column kept its old PIN name). */
  passwordHash: text("pin_hash"),
  /** Named UI accent (USER_ACCENTS in @homebase/shared); null = default blue. */
  accent: text("accent"),
  ...timestamps,
});

/** PIN-login sessions (30-day cookie). Only the sha256 of the cookie token is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: tstz("expires_at").notNull(),
    lastSeenAt: tstz("last_seen_at"),
    revokedAt: tstz("revoked_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** One row per PIN attempt; lockout = 5 failures for a user in 15 minutes, plus per-IP rate limiting. */
export const pinAttempts = pgTable(
  "pin_attempts",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    ip: text("ip").notNull(),
    success: boolean("success").notNull(),
    ...timestamps,
  },
  (t) => [index("pin_attempts_user_idx").on(t.userId, t.createdAt), index("pin_attempts_ip_idx").on(t.ip, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Core budgeting (§5.1)
// ---------------------------------------------------------------------------

export const entities = pgTable("entities", {
  id: id(),
  name: text("name").notNull().unique(),
  sort: integer("sort").notNull().default(0),
  ...timestamps,
});

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id),
    name: text("name").notNull(),
    nickname: text("nickname"),
    institution: text("institution"),
    kind: accountKind("kind").notNull(),
    onBudget: boolean("on_budget").notNull(),
    closed: boolean("closed").notNull().default(false),
    source: accountSource("source").notNull().default("manual"),
    connectionId: uuid("connection_id").references((): AnyPgColumn => connections.id, { onDelete: "set null" }),
    externalId: text("external_id"),
    ynabId: text("ynab_id").unique(),
    balanceSign: balanceSign("balance_sign").notNull().default("normal"),
    sort: integer("sort").notNull().default(0),
    note: text("note"),
    /** Cards: day of month the statement payment is due. */
    statementDueDay: integer("statement_due_day"),
    /** Retirement: known monthly contribution, used to split growth from contributions (§7.5). */
    monthlyContributionMilli: milli("monthly_contribution_milli"),
    deletedAt: tstz("deleted_at"),
    ...timestamps,
  },
  (t) => [unique("accounts_connection_external_uq").on(t.connectionId, t.externalId), index("accounts_entity_idx").on(t.entityId)],
);

/** One row per account per day (upsert). Liabilities are stored negative. */
export const balances = pgTable(
  "balances",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    asOf: day("as_of").notNull(),
    currentMilli: milli("current_milli").notNull(),
    availableMilli: milli("available_milli"),
    source: accountSource("source").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.accountId, t.asOf] }), index("balances_as_of_idx").on(t.asOf)],
);

export const categoryGroups = pgTable("category_groups", {
  id: id(),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  hidden: boolean("hidden").notNull().default(false),
  /** System groups ("Credit Card Payments", the internal group holding RTA/Uncategorized) can't be edited or deleted. */
  isSystem: boolean("is_system").notNull().default(false),
  ynabId: text("ynab_id").unique(),
  deletedAt: tstz("deleted_at"),
  ...timestamps,
});

export const categories = pgTable(
  "categories",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => categoryGroups.id),
    /** Imported names are stored with leading/trailing emoji stripped; the icon replaces them. */
    name: text("name").notNull(),
    /** lucide-react icon key in kebab-case ("house", "piggy-bank"); null = UI default. */
    icon: text("icon"),
    sort: integer("sort").notNull().default(0),
    hidden: boolean("hidden").notNull().default(false),
    note: text("note"),
    kind: categoryKind("kind").notNull().default("normal"),
    /** cc_payment categories: the card they belong to. */
    linkedAccountId: uuid("linked_account_id").references(() => accounts.id),
    /** §9.4: never auto-approve transactions landing here. */
    alwaysReview: boolean("always_review").notNull().default(false),
    /**
     * Buckets: overflow (rollover). When on, money left in the bucket at the end of a month raises the
     * next month's budget by that much (never negative). `rollover_from` is the first month it counts
     * (kept when turned off); `rollover_opening_milli` is carried into that first month (already saved).
     */
    rollover: boolean("rollover").notNull().default(false),
    rolloverFrom: day("rollover_from"),
    rolloverOpeningMilli: milli("rollover_opening_milli").notNull().default(sql`0`),
    /**
     * Buckets: savings buckets. 'spending' (default) = a monthly spend-down bucket; 'savings' = money is
     * added as it comes in (month_assignments are the contributions) and the balance carries month to month.
     * Savings buckets reuse `rollover_from` (start month) and `rollover_opening_milli` (starting balance).
     */
    bucketKind: text("bucket_kind", { enum: ["spending", "savings"] }).notNull().default("spending"),
    /** Savings buckets: optional target total (e.g. $15,000); null = no target. */
    savingsTargetMilli: milli("savings_target_milli"),
    ynabId: text("ynab_id").unique(),
    deletedAt: tstz("deleted_at"),
    ...timestamps,
  },
  (t) => [
    index("categories_group_idx").on(t.groupId),
    uniqueIndex("categories_linked_account_uq").on(t.linkedAccountId).where(sql`${t.kind} = 'cc_payment'`),
    uniqueIndex("categories_singleton_kind_uq").on(t.kind).where(sql`${t.kind} in ('internal_rta', 'uncategorized')`),
  ],
);

/**
 * Targets with history (§6.5): a row applies from `effective_from` until the next row for the same category.
 * A row with `removed = true` ends the target from that month on.
 */
export const targets = pgTable(
  "targets",
  {
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    effectiveFrom: day("effective_from").notNull(),
    type: targetType("type").notNull(),
    amountMilli: milli("amount_milli").notNull().default(sql`0`),
    cadence: cadence("cadence").notNull().default("monthly"),
    cadenceEvery: integer("cadence_every").notNull().default(1),
    /** Weekly: weekday 0=Sun…6=Sat. Monthly: day of month (null = end of month). */
    day: integer("day"),
    targetDate: day("target_date"),
    /** percent_of_income only, as a percentage (10 = 10%). */
    percent: numeric("percent", { precision: 7, scale: 4 }),
    incomeBasis: targetIncomeBasis("income_basis"),
    snoozedMonth: day("snoozed_month"),
    createdMonth: day("created_month").notNull(),
    removed: boolean("removed").notNull().default(false),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.effectiveFrom] })],
);

export const monthAssignments = pgTable(
  "month_assignments",
  {
    month: day("month").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    assignedMilli: milli("assigned_milli").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.month, t.categoryId] }), index("month_assignments_category_idx").on(t.categoryId, t.month)],
);

/** category_id null = note for the whole month. */
export const monthNotes = pgTable(
  "month_notes",
  {
    id: id(),
    month: day("month").notNull(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    note: text("note").notNull(),
    ...timestamps,
  },
  (t) => [unique("month_notes_month_category_uq").on(t.month, t.categoryId).nullsNotDistinct()],
);

export interface MerchantProfile {
  website?: string;
  type?: string;
  location?: string;
  description?: string;
  confidence?: number;
  looked_up_at?: string;
}

export const payees = pgTable(
  "payees",
  {
    id: id(),
    name: text("name").notNull(),
    normalizedKey: text("normalized_key").notNull().unique(),
    defaultCategoryId: uuid("default_category_id").references(() => categories.id, { onDelete: "set null" }),
    /** Set for YNAB-style "Transfer : <account>" payees. */
    transferAccountId: uuid("transfer_account_id").references(() => accounts.id),
    merchant: jsonb("merchant").$type<MerchantProfile>(),
    ynabId: text("ynab_id").unique(),
    deletedAt: tstz("deleted_at"),
    ...timestamps,
  },
  (t) => [index("payees_transfer_account_idx").on(t.transferAccountId)],
);

export const payeeAliases = pgTable(
  "payee_aliases",
  {
    id: id(),
    pattern: text("pattern").notNull(),
    match: payeeMatch("match").notNull(),
    payeeId: uuid("payee_id")
      .notNull()
      .references(() => payees.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [unique("payee_aliases_match_pattern_uq").on(t.match, t.pattern), index("payee_aliases_payee_idx").on(t.payeeId)],
);

export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    date: day("date").notNull(),
    postedAt: tstz("posted_at"),
    /** − outflow, + inflow */
    amountMilli: milli("amount_milli").notNull(),
    payeeId: uuid("payee_id").references(() => payees.id),
    rawDescription: text("raw_description"),
    memo: text("memo"),
    /** null when split, a transfer between on-budget accounts, or uncategorized. */
    categoryId: uuid("category_id").references(() => categories.id),
    isSplit: boolean("is_split").notNull().default(false),
    transferAccountId: uuid("transfer_account_id").references(() => accounts.id),
    transferPairId: uuid("transfer_pair_id").references((): AnyPgColumn => transactions.id, { onDelete: "set null" }),
    /** The opening-balance row of an account (§6.1): cash → RTA; card debt → uncategorized but not overspending. */
    isStartingBalance: boolean("is_starting_balance").notNull().default(false),
    cleared: cleared("cleared").notNull().default("uncleared"),
    approved: boolean("approved").notNull().default(false),
    flag: flag("flag"),
    source: transactionSource("source").notNull(),
    externalId: text("external_id"),
    importHash: text("import_hash"),
    /** Tie-break within a date: YNAB's order for imported rows, else insertion order (§6.4). */
    importOrder: integer("import_order"),
    /** Set on rows imported from YNAB. */
    ynabId: text("ynab_id"),
    /** Set on synced rows matched to a YNAB-imported row during the parallel run (§8.4). */
    matchedYnabId: text("matched_ynab_id"),
    scheduledTransactionId: uuid("scheduled_transaction_id").references((): AnyPgColumn => scheduledTransactions.id, { onDelete: "set null" }),
    catz: jsonb("catz").$type<Catz>(),
    deletedAt: tstz("deleted_at"),
    ...timestamps,
  },
  (t) => [
    index("transactions_account_date_idx").on(t.accountId, t.date),
    index("transactions_category_date_idx").on(t.categoryId, t.date),
    index("transactions_date_idx").on(t.date),
    index("transactions_payee_idx").on(t.payeeId),
    index("transactions_import_hash_idx").on(t.importHash),
    index("transactions_transfer_pair_idx").on(t.transferPairId),
    index("transactions_unapproved_idx").on(t.date).where(sql`${t.approved} = false and ${t.deletedAt} is null`),
    unique("transactions_account_external_uq").on(t.accountId, t.externalId),
    unique("transactions_ynab_uq").on(t.ynabId),
  ],
);

/** Split lines; the deferred trigger `check_transaction_split_sum` enforces Σ amount = parent amount. */
export const transactionSplits = pgTable(
  "transaction_splits",
  {
    id: id(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    amountMilli: milli("amount_milli").notNull(),
    categoryId: uuid("category_id").references(() => categories.id),
    payeeId: uuid("payee_id").references(() => payees.id),
    memo: text("memo"),
    transferAccountId: uuid("transfer_account_id").references(() => accounts.id),
    transferPairId: uuid("transfer_pair_id").references(() => transactions.id, { onDelete: "set null" }),
    sort: integer("sort").notNull().default(0),
    ynabId: text("ynab_id").unique(),
    ...timestamps,
  },
  (t) => [index("transaction_splits_transaction_idx").on(t.transactionId), index("transaction_splits_category_idx").on(t.categoryId)],
);

export const scheduledTransactions = pgTable(
  "scheduled_transactions",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    payeeId: uuid("payee_id").references(() => payees.id),
    categoryId: uuid("category_id").references(() => categories.id),
    transferAccountId: uuid("transfer_account_id").references(() => accounts.id),
    isSplit: boolean("is_split").notNull().default(false),
    amountMilli: milli("amount_milli").notNull(),
    frequency: frequency("frequency").notNull(),
    firstDate: day("first_date").notNull(),
    nextDate: day("next_date").notNull(),
    endDate: day("end_date"),
    memo: text("memo"),
    flag: flag("flag"),
    ynabId: text("ynab_id").unique(),
    deletedAt: tstz("deleted_at"),
    ...timestamps,
  },
  (t) => [index("scheduled_transactions_next_date_idx").on(t.nextDate)],
);

export const scheduledTransactionSplits = pgTable(
  "scheduled_transaction_splits",
  {
    id: id(),
    scheduledTransactionId: uuid("scheduled_transaction_id")
      .notNull()
      .references(() => scheduledTransactions.id, { onDelete: "cascade" }),
    amountMilli: milli("amount_milli").notNull(),
    categoryId: uuid("category_id").references(() => categories.id),
    payeeId: uuid("payee_id").references(() => payees.id),
    memo: text("memo"),
    transferAccountId: uuid("transfer_account_id").references(() => accounts.id),
    sort: integer("sort").notNull().default(0),
    ynabId: text("ynab_id").unique(),
    ...timestamps,
  },
  (t) => [index("scheduled_transaction_splits_parent_idx").on(t.scheduledTransactionId)],
);

export const reconciliations = pgTable(
  "reconciliations",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    at: tstz("at").notNull().defaultNow(),
    statementDate: day("statement_date"),
    statementBalanceMilli: milli("statement_balance_milli").notNull(),
    clearedBalanceMilli: milli("cleared_balance_milli").notNull(),
    adjustmentTxId: uuid("adjustment_tx_id").references(() => transactions.id),
    userId: uuid("user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [index("reconciliations_account_idx").on(t.accountId, t.at)],
);

/** Undo/redo stack and the "Recent Moves" list. */
export const budgetOperations = pgTable(
  "budget_operations",
  {
    id: id(),
    at: tstz("at").notNull().defaultNow(),
    userId: uuid("user_id").references(() => users.id),
    kind: budgetOperationKind("kind").notNull(),
    month: day("month"),
    payload: jsonb("payload").notNull(),
    inverse: jsonb("inverse").notNull(),
    undoneAt: tstz("undone_at"),
    ...timestamps,
  },
  (t) => [index("budget_operations_at_idx").on(t.at)],
);

/** Engine output cache, keyed by engine version so engine changes invalidate it (§6). */
export const budgetMonthCache = pgTable(
  "budget_month_cache",
  {
    engineVersion: integer("engine_version").notNull(),
    month: day("month").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    assignedMilli: milli("assigned_milli").notNull(),
    activityMilli: milli("activity_milli").notNull(),
    availableMilli: milli("available_milli").notNull(),
    carryInMilli: milli("carry_in_milli").notNull(),
    cashOverspendMilli: milli("cash_overspend_milli").notNull().default(sql`0`),
    creditOverspendMilli: milli("credit_overspend_milli").notNull().default(sql`0`),
    neededMilli: milli("needed_milli").notNull().default(sql`0`),
    underfundedMilli: milli("underfunded_milli").notNull().default(sql`0`),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.engineVersion, t.month, t.categoryId] })],
);

export const budgetMonthSummary = pgTable(
  "budget_month_summary",
  {
    engineVersion: integer("engine_version").notNull(),
    month: day("month").notNull(),
    rtaMilli: milli("rta_milli").notNull(),
    assignedFutureMilli: milli("assigned_future_milli").notNull().default(sql`0`),
    costToBeMeMilli: milli("cost_to_be_me_milli").notNull().default(sql`0`),
    /** days; null until there are 10 outflows */
    ageOfMoney: integer("age_of_money"),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.engineVersion, t.month] })],
);

// ---------------------------------------------------------------------------
// Categorization (§5.2)
// ---------------------------------------------------------------------------

export const rules = pgTable(
  "rules",
  {
    id: id(),
    name: text("name"),
    priority: integer("priority").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    source: ruleSource("source").notNull(),
    conditions: jsonb("conditions").notNull(),
    actions: jsonb("actions").notNull(),
    hitCount: integer("hit_count").notNull().default(0),
    lastHitAt: tstz("last_hit_at"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (t) => [index("rules_priority_idx").on(t.enabled, t.priority)],
);

export const categorizationEvents = pgTable(
  "categorization_events",
  {
    id: id(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    suggestedCategoryId: uuid("suggested_category_id").references(() => categories.id, { onDelete: "set null" }),
    finalCategoryId: uuid("final_category_id").references(() => categories.id, { onDelete: "set null" }),
    method: catzMethod("method").notNull(),
    confidence: real("confidence"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: usd("cost_usd"),
    /** null until the user has acted on the suggestion */
    accepted: boolean("accepted"),
    /** Parallel-run shadow mode: suggestion recorded but not applied (§10). */
    shadow: boolean("shadow").notNull().default(false),
    userId: uuid("user_id").references(() => users.id),
    at: tstz("at").notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("categorization_events_transaction_idx").on(t.transactionId), index("categorization_events_at_idx").on(t.at)],
);

// ---------------------------------------------------------------------------
// Wealth (§5.3)
// ---------------------------------------------------------------------------

/** Daily snapshot, one row per lot; views sum lots per symbol. */
export const holdings = pgTable(
  "holdings",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    asOf: day("as_of").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name"),
    quantity: numeric("quantity", { precision: 28, scale: 10 }).notNull(),
    price: numeric("price", { precision: 28, scale: 10 }),
    marketValueMilli: milli("market_value_milli").notNull(),
    costBasisMilli: milli("cost_basis_milli"),
    lotKey: text("lot_key"),
    ...timestamps,
  },
  (t) => [unique("holdings_account_day_symbol_lot_uq").on(t.accountId, t.asOf, t.symbol, t.lotKey).nullsNotDistinct(), index("holdings_as_of_idx").on(t.asOf)],
);

export const assets = pgTable("assets", {
  id: id(),
  kind: assetKind("kind").notNull(),
  name: text("name").notNull(),
  address: text("address"),
  purchasePriceMilli: milli("purchase_price_milli"),
  purchaseDate: day("purchase_date"),
  /** The property tracking account whose balance mirrors the latest valuation. */
  accountId: uuid("account_id").references(() => accounts.id),
  ...timestamps,
});

export const assetValuations = pgTable(
  "asset_valuations",
  {
    id: id(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    asOf: day("as_of").notNull(),
    valueMilli: milli("value_milli").notNull(),
    lowMilli: milli("low_milli"),
    highMilli: milli("high_milli"),
    source: valuationSource("source").notNull(),
    /** RentCast comparables, kept for the detail view. */
    comps: jsonb("comps"),
    ...timestamps,
  },
  (t) => [unique("asset_valuations_asset_day_source_uq").on(t.assetId, t.asOf, t.source)],
);

export const loans = pgTable("loans", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  servicer: text("servicer"),
  originalPrincipalMilli: milli("original_principal_milli").notNull(),
  /** Decimal fraction: 0.065 = 6.5% APR. */
  annualRate: numeric("annual_rate", { precision: 9, scale: 6 }).notNull(),
  termMonths: integer("term_months").notNull(),
  firstPaymentDate: day("first_payment_date").notNull(),
  piPaymentMilli: milli("pi_payment_milli").notNull(),
  escrowMilli: milli("escrow_milli").notNull().default(sql`0`),
  ...timestamps,
});

export const loanEvents = pgTable(
  "loan_events",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => loans.accountId, { onDelete: "cascade" }),
    date: day("date").notNull(),
    kind: loanEventKind("kind").notNull(),
    amountMilli: milli("amount_milli"),
    newPaymentMilli: milli("new_payment_milli"),
    newRate: numeric("new_rate", { precision: 9, scale: 6 }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [index("loan_events_account_date_idx").on(t.accountId, t.date)],
);

export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: id(),
    externalId: text("external_id").unique(),
    checkDate: day("check_date").notNull(),
    grossMilli: milli("gross_milli").notNull(),
    employeeTaxesMilli: milli("employee_taxes_milli").notNull(),
    employerTaxesMilli: milli("employer_taxes_milli").notNull(),
    /** e.g. { "401k": "739200", "hsa": "150000" } — milli as strings */
    deductions: jsonb("deductions").$type<Record<string, string>>(),
    netMilli: milli("net_milli").notNull(),
    matchedTransactionId: uuid("matched_transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("payroll_runs_check_date_idx").on(t.checkDate)],
);

// ---------------------------------------------------------------------------
// Ops and AI (§5.4)
// ---------------------------------------------------------------------------

export const connections = pgTable("connections", {
  id: id(),
  provider: connectionProvider("provider").notNull(),
  label: text("label").notNull(),
  /** encryptSecret() output; never selected into API responses. */
  encCredentials: bytea("enc_credentials"),
  credentialsLast4: text("credentials_last4"),
  status: connectionStatus("status").notNull().default("ok"),
  lastSuccessAt: tstz("last_success_at"),
  lastError: text("last_error"),
  meta: jsonb("meta"),
  ...timestamps,
});

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: id(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    startedAt: tstz("started_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    status: syncStatus("status").notNull().default("running"),
    requestsUsed: integer("requests_used").notNull().default(0),
    accountsSeen: integer("accounts_seen").notNull().default(0),
    txAdded: integer("tx_added").notNull().default(0),
    txUpdated: integer("tx_updated").notNull().default(0),
    errors: jsonb("errors"),
    ...timestamps,
  },
  (t) => [index("sync_runs_connection_started_idx").on(t.connectionId, t.startedAt)],
);

/** Purged after 14 days. */
export const rawPayloads = pgTable(
  "raw_payloads",
  {
    id: id(),
    syncRunId: uuid("sync_run_id").references(() => syncRuns.id, { onDelete: "cascade" }),
    provider: connectionProvider("provider").notNull(),
    fetchedAt: tstz("fetched_at").notNull().defaultNow(),
    body: jsonb("body").notNull(),
    ...timestamps,
  },
  (t) => [index("raw_payloads_fetched_at_idx").on(t.fetchedAt)],
);

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id),
    title: text("title"),
    archivedAt: tstz("archived_at"),
    ...timestamps,
  },
  (t) => [index("ai_conversations_user_idx").on(t.userId, t.updatedAt)],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    role: aiRole("role").notNull(),
    /** Anthropic content blocks */
    content: jsonb("content").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: usd("cost_usd"),
    ...timestamps,
  },
  (t) => [index("ai_messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const aiToolCalls = pgTable(
  "ai_tool_calls",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => aiMessages.id, { onDelete: "cascade" }),
    toolUseId: text("tool_use_id"),
    name: text("name").notNull(),
    input: jsonb("input").notNull(),
    outputSummary: text("output_summary"),
    status: aiToolCallStatus("status").notNull(),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmedAt: tstz("confirmed_at"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [index("ai_tool_calls_conversation_idx").on(t.conversationId), index("ai_tool_calls_status_idx").on(t.status)],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: id(),
    at: tstz("at").notNull().defaultNow(),
    purpose: aiPurpose("purpose").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    webSearches: integer("web_searches").notNull().default(0),
    costUsd: usd("cost_usd").notNull(),
    userId: uuid("user_id").references(() => users.id),
    conversationId: uuid("conversation_id").references(() => aiConversations.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("ai_usage_at_idx").on(t.at)],
);

export const householdMemory = pgTable("household_memory", {
  id: id(),
  text: text("text").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  ...timestamps,
});

export const savedReports = pgTable("saved_reports", {
  id: id(),
  name: text("name").notNull(),
  spec: jsonb("spec").notNull(),
  pinned: boolean("pinned").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id),
  ...timestamps,
});

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    keys: jsonb("keys").$type<{ p256dh: string; auth: string }>().notNull(),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    at: tstz("at").notNull().defaultNow(),
    userId: uuid("user_id").references(() => users.id),
    actor: auditActor("actor").notNull(),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ...timestamps,
  },
  (t) => [index("audit_log_at_idx").on(t.at), index("audit_log_entity_idx").on(t.entity, t.entityId)],
);

/** Key/value settings. Secret values (VAPID private key, API keys) go in enc_value via encryptSecret(). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  encValue: bytea("enc_value"),
  updatedBy: uuid("updated_by").references(() => users.id),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// Relations (for db.query.*)
// ---------------------------------------------------------------------------

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  entity: one(entities, { fields: [accounts.entityId], references: [entities.id] }),
  transactions: many(transactions, { relationName: "account" }),
  balances: many(balances),
  holdings: many(holdings),
  loan: one(loans, { fields: [accounts.id], references: [loans.accountId] }),
}));
export const entitiesRelations = relations(entities, ({ many }) => ({ accounts: many(accounts) }));
export const balancesRelations = relations(balances, ({ one }) => ({
  account: one(accounts, { fields: [balances.accountId], references: [accounts.id] }),
}));
export const holdingsRelations = relations(holdings, ({ one }) => ({
  account: one(accounts, { fields: [holdings.accountId], references: [accounts.id] }),
}));
export const categoryGroupsRelations = relations(categoryGroups, ({ many }) => ({ categories: many(categories) }));
export const categoriesRelations = relations(categories, ({ one, many }) => ({
  group: one(categoryGroups, { fields: [categories.groupId], references: [categoryGroups.id] }),
  linkedAccount: one(accounts, { fields: [categories.linkedAccountId], references: [accounts.id] }),
  targets: many(targets),
  assignments: many(monthAssignments),
}));
export const targetsRelations = relations(targets, ({ one }) => ({
  category: one(categories, { fields: [targets.categoryId], references: [categories.id] }),
}));
export const monthAssignmentsRelations = relations(monthAssignments, ({ one }) => ({
  category: one(categories, { fields: [monthAssignments.categoryId], references: [categories.id] }),
}));
export const payeesRelations = relations(payees, ({ one, many }) => ({
  defaultCategory: one(categories, { fields: [payees.defaultCategoryId], references: [categories.id] }),
  aliases: many(payeeAliases),
}));
export const payeeAliasesRelations = relations(payeeAliases, ({ one }) => ({
  payee: one(payees, { fields: [payeeAliases.payeeId], references: [payees.id] }),
}));
export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  account: one(accounts, { fields: [transactions.accountId], references: [accounts.id], relationName: "account" }),
  payee: one(payees, { fields: [transactions.payeeId], references: [payees.id] }),
  category: one(categories, { fields: [transactions.categoryId], references: [categories.id] }),
  splits: many(transactionSplits, { relationName: "splits" }),
}));
export const transactionSplitsRelations = relations(transactionSplits, ({ one }) => ({
  transaction: one(transactions, { fields: [transactionSplits.transactionId], references: [transactions.id], relationName: "splits" }),
  category: one(categories, { fields: [transactionSplits.categoryId], references: [categories.id] }),
  payee: one(payees, { fields: [transactionSplits.payeeId], references: [payees.id] }),
}));
export const scheduledTransactionsRelations = relations(scheduledTransactions, ({ one, many }) => ({
  account: one(accounts, { fields: [scheduledTransactions.accountId], references: [accounts.id] }),
  payee: one(payees, { fields: [scheduledTransactions.payeeId], references: [payees.id] }),
  category: one(categories, { fields: [scheduledTransactions.categoryId], references: [categories.id] }),
  splits: many(scheduledTransactionSplits),
}));
export const scheduledTransactionSplitsRelations = relations(scheduledTransactionSplits, ({ one }) => ({
  scheduledTransaction: one(scheduledTransactions, {
    fields: [scheduledTransactionSplits.scheduledTransactionId],
    references: [scheduledTransactions.id],
  }),
}));
export const assetsRelations = relations(assets, ({ one, many }) => ({
  account: one(accounts, { fields: [assets.accountId], references: [accounts.id] }),
  valuations: many(assetValuations),
}));
export const assetValuationsRelations = relations(assetValuations, ({ one }) => ({
  asset: one(assets, { fields: [assetValuations.assetId], references: [assets.id] }),
}));
export const loansRelations = relations(loans, ({ one, many }) => ({
  account: one(accounts, { fields: [loans.accountId], references: [accounts.id] }),
  events: many(loanEvents),
}));
export const loanEventsRelations = relations(loanEvents, ({ one }) => ({
  loan: one(loans, { fields: [loanEvents.accountId], references: [loans.accountId] }),
}));
export const aiConversationsRelations = relations(aiConversations, ({ many }) => ({
  messages: many(aiMessages),
  toolCalls: many(aiToolCalls),
}));
export const aiMessagesRelations = relations(aiMessages, ({ one }) => ({
  conversation: one(aiConversations, { fields: [aiMessages.conversationId], references: [aiConversations.id] }),
}));
export const aiToolCallsRelations = relations(aiToolCalls, ({ one }) => ({
  conversation: one(aiConversations, { fields: [aiToolCalls.conversationId], references: [aiConversations.id] }),
}));

// ---------------------------------------------------------------------------
// Reporting views (§5.5). Defined in migrations/0001_reporting.sql; declared here for typed reads.
// ---------------------------------------------------------------------------

export const vTransactionsFlat = pgView("v_transactions_flat", {
  transactionId: uuid("transaction_id").notNull(),
  splitId: uuid("split_id"),
  date: day("date").notNull(),
  month: day("month").notNull(),
  accountId: uuid("account_id").notNull(),
  accountName: text("account_name").notNull(),
  accountKind: accountKind("account_kind").notNull(),
  onBudget: boolean("on_budget").notNull(),
  entityId: uuid("entity_id").notNull(),
  entityName: text("entity_name").notNull(),
  amountMilli: milli("amount_milli").notNull(),
  payeeId: uuid("payee_id"),
  payeeName: text("payee_name"),
  categoryId: uuid("category_id"),
  categoryName: text("category_name"),
  categoryKind: categoryKind("category_kind"),
  groupId: uuid("group_id"),
  groupName: text("group_name"),
  memo: text("memo"),
  transferAccountId: uuid("transfer_account_id"),
  transferAccountName: text("transfer_account_name"),
  isTransfer: boolean("is_transfer").notNull(),
  isSplit: boolean("is_split").notNull(),
  isStartingBalance: boolean("is_starting_balance").notNull(),
  isUncategorized: boolean("is_uncategorized").notNull(),
  cleared: cleared("cleared").notNull(),
  approved: boolean("approved").notNull(),
  flag: flag("flag"),
  catzMethod: text("catz_method"),
}).existing();

export const vMonthCategory = pgView("v_month_category", {
  engineVersion: integer("engine_version").notNull(),
  month: day("month").notNull(),
  categoryId: uuid("category_id").notNull(),
  categoryName: text("category_name").notNull(),
  categoryKind: categoryKind("category_kind").notNull(),
  hidden: boolean("hidden").notNull(),
  groupId: uuid("group_id").notNull(),
  groupName: text("group_name").notNull(),
  assignedMilli: milli("assigned_milli").notNull(),
  activityMilli: milli("activity_milli").notNull(),
  availableMilli: milli("available_milli").notNull(),
  carryInMilli: milli("carry_in_milli").notNull(),
  cashOverspendMilli: milli("cash_overspend_milli").notNull(),
  creditOverspendMilli: milli("credit_overspend_milli").notNull(),
  neededMilli: milli("needed_milli").notNull(),
  underfundedMilli: milli("underfunded_milli").notNull(),
  targetType: targetType("target_type"),
  targetAmountMilli: milli("target_amount_milli"),
  targetCadence: cadence("target_cadence"),
}).existing();

export const vMonthSummary = pgView("v_month_summary", {
  engineVersion: integer("engine_version").notNull(),
  month: day("month").notNull(),
  rtaMilli: milli("rta_milli").notNull(),
  assignedFutureMilli: milli("assigned_future_milli").notNull(),
  costToBeMeMilli: milli("cost_to_be_me_milli").notNull(),
  ageOfMoney: integer("age_of_money"),
}).existing();

export const vBalancesDaily = pgView("v_balances_daily", {
  date: day("date").notNull(),
  accountId: uuid("account_id").notNull(),
  accountName: text("account_name").notNull(),
  accountKind: accountKind("account_kind").notNull(),
  onBudget: boolean("on_budget").notNull(),
  closed: boolean("closed").notNull(),
  entityId: uuid("entity_id").notNull(),
  entityName: text("entity_name").notNull(),
  balanceMilli: milli("balance_milli").notNull(),
  balanceAsOf: day("balance_as_of").notNull(),
}).existing();

export const vNetWorthDaily = pgView("v_net_worth_daily", {
  date: day("date").notNull(),
  entityId: uuid("entity_id").notNull(),
  entityName: text("entity_name").notNull(),
  cashMilli: milli("cash_milli").notNull(),
  creditMilli: milli("credit_milli").notNull(),
  investmentsMilli: milli("investments_milli").notNull(),
  cryptoMilli: milli("crypto_milli").notNull(),
  propertyMilli: milli("property_milli").notNull(),
  loansMilli: milli("loans_milli").notNull(),
  otherMilli: milli("other_milli").notNull(),
  assetsMilli: milli("assets_milli").notNull(),
  liabilitiesMilli: milli("liabilities_milli").notNull(),
  netWorthMilli: milli("net_worth_milli").notNull(),
}).existing();

export const vHoldingsLatest = pgView("v_holdings_latest", {
  accountId: uuid("account_id").notNull(),
  accountName: text("account_name").notNull(),
  accountKind: accountKind("account_kind").notNull(),
  entityName: text("entity_name").notNull(),
  asOf: day("as_of").notNull(),
  symbol: text("symbol").notNull(),
  name: text("name"),
  quantity: numeric("quantity").notNull(),
  price: numeric("price"),
  marketValueMilli: milli("market_value_milli").notNull(),
  costBasisMilli: milli("cost_basis_milli"),
  lots: integer("lots").notNull(),
}).existing();

export const vCashflowMonthly = pgView("v_cashflow_monthly", {
  month: day("month").notNull(),
  incomeMilli: milli("income_milli").notNull(),
  expenseMilli: milli("expense_milli").notNull(),
  netMilli: milli("net_milli").notNull(),
  savingsRate: numeric("savings_rate"),
}).existing();

export const vPayeeSpendMonthly = pgView("v_payee_spend_monthly", {
  month: day("month").notNull(),
  payeeId: uuid("payee_id").notNull(),
  payeeName: text("payee_name").notNull(),
  outflowMilli: milli("outflow_milli").notNull(),
  inflowMilli: milli("inflow_milli").notNull(),
  spendMilli: milli("spend_milli").notNull(),
  txnCount: integer("txn_count").notNull(),
}).existing();
