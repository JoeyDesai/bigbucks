CREATE TYPE "public"."account_kind" AS ENUM('checking', 'savings', 'cash', 'credit_card', 'line_of_credit', 'brokerage', 'retirement', 'hsa', 'crypto', 'mortgage', 'loan', 'property', 'other');--> statement-breakpoint
CREATE TYPE "public"."account_source" AS ENUM('simplefin', 'mercury', 'coinbase', 'river_csv', 'xpub', 'rentcast', 'amortization', 'manual', 'ynab_import', 'csv');--> statement-breakpoint
CREATE TYPE "public"."ai_purpose" AS ENUM('chat', 'categorize', 'batch_categorize', 'merchant_lookup', 'digest', 'report');--> statement-breakpoint
CREATE TYPE "public"."ai_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."ai_tool_call_status" AS ENUM('auto', 'awaiting_confirmation', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('home');--> statement-breakpoint
CREATE TYPE "public"."audit_actor" AS ENUM('user', 'ai', 'system');--> statement-breakpoint
CREATE TYPE "public"."balance_sign" AS ENUM('normal', 'inverted');--> statement-breakpoint
CREATE TYPE "public"."budget_operation_kind" AS ENUM('assign', 'move', 'auto_assign', 'reset', 'target_edit', 'category_edit', 'group_edit', 'note_edit');--> statement-breakpoint
CREATE TYPE "public"."cadence" AS ENUM('none', 'weekly', 'monthly', 'yearly', 'every_n_months');--> statement-breakpoint
CREATE TYPE "public"."category_kind" AS ENUM('normal', 'cc_payment', 'internal_rta', 'uncategorized');--> statement-breakpoint
CREATE TYPE "public"."catz_method" AS ENUM('rule', 'history', 'ai', 'ai_web', 'user', 'ynab', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."cleared" AS ENUM('pending', 'uncleared', 'cleared', 'reconciled');--> statement-breakpoint
CREATE TYPE "public"."connection_provider" AS ENUM('simplefin', 'mercury', 'coinbase', 'river', 'xpub', 'rentcast', 'gusto', 'ynab', 'anthropic', 'openai');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('ok', 'needs_attention', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."flag" AS ENUM('red', 'orange', 'yellow', 'green', 'blue', 'purple');--> statement-breakpoint
CREATE TYPE "public"."frequency" AS ENUM('once', 'daily', 'weekly', 'biweekly', 'twice_monthly', 'every_4_weeks', 'monthly', 'every_other_month', 'every_3_months', 'every_4_months', 'twice_yearly', 'yearly', 'every_other_year');--> statement-breakpoint
CREATE TYPE "public"."loan_event_kind" AS ENUM('extra_principal', 'recast', 'rate_change', 'statement_balance');--> statement-breakpoint
CREATE TYPE "public"."payee_match" AS ENUM('exact', 'prefix', 'regex');--> statement-breakpoint
CREATE TYPE "public"."rule_source" AS ENUM('user', 'learned', 'ai_suggested');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'ok', 'partial', 'error');--> statement-breakpoint
CREATE TYPE "public"."target_income_basis" AS ENUM('rta_inflows', 'gross_pay');--> statement-breakpoint
CREATE TYPE "public"."target_type" AS ENUM('need_refill', 'need_set_aside', 'balance', 'balance_by_date', 'monthly_builder', 'debt', 'percent_of_income');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('simplefin', 'mercury', 'coinbase', 'river_csv', 'xpub', 'rentcast', 'amortization', 'manual', 'ynab_import', 'csv', 'scheduled', 'reconciliation');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."valuation_source" AS ENUM('rentcast', 'manual');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"nickname" text,
	"institution" text,
	"kind" "account_kind" NOT NULL,
	"on_budget" boolean NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"source" "account_source" DEFAULT 'manual' NOT NULL,
	"connection_id" uuid,
	"external_id" text,
	"ynab_id" text,
	"balance_sign" "balance_sign" DEFAULT 'normal' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"note" text,
	"statement_due_day" integer,
	"monthly_contribution_milli" bigint,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_ynab_id_unique" UNIQUE("ynab_id"),
	CONSTRAINT "accounts_connection_external_uq" UNIQUE("connection_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"title" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "ai_role" NOT NULL,
	"content" jsonb NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"tool_use_id" text,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"output_summary" text,
	"status" "ai_tool_call_status" NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" "ai_purpose" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"user_id" uuid,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_valuations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"value_milli" bigint NOT NULL,
	"low_milli" bigint,
	"high_milli" bigint,
	"source" "valuation_source" NOT NULL,
	"comps" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_valuations_asset_day_source_uq" UNIQUE("asset_id","as_of","source")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"purchase_price_milli" bigint,
	"purchase_date" date,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"actor" "audit_actor" NOT NULL,
	"confirmed_by" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"account_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"current_milli" bigint NOT NULL,
	"available_milli" bigint,
	"source" "account_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balances_account_id_as_of_pk" PRIMARY KEY("account_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "budget_month_cache" (
	"engine_version" integer NOT NULL,
	"month" date NOT NULL,
	"category_id" uuid NOT NULL,
	"assigned_milli" bigint NOT NULL,
	"activity_milli" bigint NOT NULL,
	"available_milli" bigint NOT NULL,
	"carry_in_milli" bigint NOT NULL,
	"cash_overspend_milli" bigint DEFAULT 0 NOT NULL,
	"credit_overspend_milli" bigint DEFAULT 0 NOT NULL,
	"needed_milli" bigint DEFAULT 0 NOT NULL,
	"underfunded_milli" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_month_cache_engine_version_month_category_id_pk" PRIMARY KEY("engine_version","month","category_id")
);
--> statement-breakpoint
CREATE TABLE "budget_month_summary" (
	"engine_version" integer NOT NULL,
	"month" date NOT NULL,
	"rta_milli" bigint NOT NULL,
	"assigned_future_milli" bigint DEFAULT 0 NOT NULL,
	"cost_to_be_me_milli" bigint DEFAULT 0 NOT NULL,
	"age_of_money" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_month_summary_engine_version_month_pk" PRIMARY KEY("engine_version","month")
);
--> statement-breakpoint
CREATE TABLE "budget_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"kind" "budget_operation_kind" NOT NULL,
	"month" date,
	"payload" jsonb NOT NULL,
	"inverse" jsonb NOT NULL,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"note" text,
	"kind" "category_kind" DEFAULT 'normal' NOT NULL,
	"linked_account_id" uuid,
	"always_review" boolean DEFAULT false NOT NULL,
	"ynab_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_ynab_id_unique" UNIQUE("ynab_id")
);
--> statement-breakpoint
CREATE TABLE "categorization_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"suggested_category_id" uuid,
	"final_category_id" uuid,
	"method" "catz_method" NOT NULL,
	"confidence" real,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"accepted" boolean,
	"shadow" boolean DEFAULT false NOT NULL,
	"user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"ynab_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_groups_ynab_id_unique" UNIQUE("ynab_id")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" "connection_provider" NOT NULL,
	"label" text NOT NULL,
	"enc_credentials" "bytea",
	"credentials_last4" text,
	"status" "connection_status" DEFAULT 'ok' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"symbol" text NOT NULL,
	"name" text,
	"quantity" numeric(28, 10) NOT NULL,
	"price" numeric(28, 10),
	"market_value_milli" bigint NOT NULL,
	"cost_basis_milli" bigint,
	"lot_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holdings_account_day_symbol_lot_uq" UNIQUE NULLS NOT DISTINCT("account_id","as_of","symbol","lot_key")
);
--> statement-breakpoint
CREATE TABLE "household_memory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" "loan_event_kind" NOT NULL,
	"amount_milli" bigint,
	"new_payment_milli" bigint,
	"new_rate" numeric(9, 6),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"servicer" text,
	"original_principal_milli" bigint NOT NULL,
	"annual_rate" numeric(9, 6) NOT NULL,
	"term_months" integer NOT NULL,
	"first_payment_date" date NOT NULL,
	"pi_payment_milli" bigint NOT NULL,
	"escrow_milli" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "month_assignments" (
	"month" date NOT NULL,
	"category_id" uuid NOT NULL,
	"assigned_milli" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_assignments_month_category_id_pk" PRIMARY KEY("month","category_id")
);
--> statement-breakpoint
CREATE TABLE "month_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"month" date NOT NULL,
	"category_id" uuid,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_notes_month_category_uq" UNIQUE NULLS NOT DISTINCT("month","category_id")
);
--> statement-breakpoint
CREATE TABLE "payee_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"match" "payee_match" NOT NULL,
	"payee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payee_aliases_match_pattern_uq" UNIQUE("match","pattern")
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"normalized_key" text NOT NULL,
	"default_category_id" uuid,
	"transfer_account_id" uuid,
	"merchant" jsonb,
	"ynab_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payees_normalized_key_unique" UNIQUE("normalized_key"),
	CONSTRAINT "payees_ynab_id_unique" UNIQUE("ynab_id")
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_id" text,
	"check_date" date NOT NULL,
	"gross_milli" bigint NOT NULL,
	"employee_taxes_milli" bigint NOT NULL,
	"employer_taxes_milli" bigint NOT NULL,
	"deductions" jsonb,
	"net_milli" bigint NOT NULL,
	"matched_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "pin_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"ip" text NOT NULL,
	"success" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sync_run_id" uuid,
	"provider" "connection_provider" NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"statement_date" date,
	"statement_balance_milli" bigint NOT NULL,
	"cleared_balance_milli" bigint NOT NULL,
	"adjustment_tx_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" "rule_source" NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_transaction_splits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scheduled_transaction_id" uuid NOT NULL,
	"amount_milli" bigint NOT NULL,
	"category_id" uuid,
	"payee_id" uuid,
	"memo" text,
	"transfer_account_id" uuid,
	"sort" integer DEFAULT 0 NOT NULL,
	"ynab_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_transaction_splits_ynab_id_unique" UNIQUE("ynab_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"payee_id" uuid,
	"category_id" uuid,
	"transfer_account_id" uuid,
	"is_split" boolean DEFAULT false NOT NULL,
	"amount_milli" bigint NOT NULL,
	"frequency" "frequency" NOT NULL,
	"first_date" date NOT NULL,
	"next_date" date NOT NULL,
	"end_date" date,
	"memo" text,
	"flag" "flag",
	"ynab_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_transactions_ynab_id_unique" UNIQUE("ynab_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"enc_value" "bytea",
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"accounts_seen" integer DEFAULT 0 NOT NULL,
	"tx_added" integer DEFAULT 0 NOT NULL,
	"tx_updated" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"category_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"type" "target_type" NOT NULL,
	"amount_milli" bigint DEFAULT 0 NOT NULL,
	"cadence" "cadence" DEFAULT 'monthly' NOT NULL,
	"cadence_every" integer DEFAULT 1 NOT NULL,
	"day" integer,
	"target_date" date,
	"percent" numeric(7, 4),
	"income_basis" "target_income_basis",
	"snoozed_month" date,
	"created_month" date NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "targets_category_id_effective_from_pk" PRIMARY KEY("category_id","effective_from")
);
--> statement-breakpoint
CREATE TABLE "transaction_splits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transaction_id" uuid NOT NULL,
	"amount_milli" bigint NOT NULL,
	"category_id" uuid,
	"payee_id" uuid,
	"memo" text,
	"transfer_account_id" uuid,
	"transfer_pair_id" uuid,
	"sort" integer DEFAULT 0 NOT NULL,
	"ynab_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_splits_ynab_id_unique" UNIQUE("ynab_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"posted_at" timestamp with time zone,
	"amount_milli" bigint NOT NULL,
	"payee_id" uuid,
	"raw_description" text,
	"memo" text,
	"category_id" uuid,
	"is_split" boolean DEFAULT false NOT NULL,
	"transfer_account_id" uuid,
	"transfer_pair_id" uuid,
	"is_starting_balance" boolean DEFAULT false NOT NULL,
	"cleared" "cleared" DEFAULT 'uncleared' NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"flag" "flag",
	"source" "transaction_source" NOT NULL,
	"external_id" text,
	"import_hash" text,
	"import_order" integer,
	"ynab_id" text,
	"matched_ynab_id" text,
	"scheduled_transaction_id" uuid,
	"catz" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_account_external_uq" UNIQUE("account_id","external_id"),
	CONSTRAINT "transactions_ynab_uq" UNIQUE("ynab_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tailscale_login" text,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"pin_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tailscale_login_unique" UNIQUE("tailscale_login")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_message_id_ai_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_month_cache" ADD CONSTRAINT "budget_month_cache_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_operations" ADD CONSTRAINT "budget_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_group_id_category_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."category_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_linked_account_id_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_events" ADD CONSTRAINT "categorization_events_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_events" ADD CONSTRAINT "categorization_events_suggested_category_id_categories_id_fk" FOREIGN KEY ("suggested_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_events" ADD CONSTRAINT "categorization_events_final_category_id_categories_id_fk" FOREIGN KEY ("final_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_events" ADD CONSTRAINT "categorization_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_memory" ADD CONSTRAINT "household_memory_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_account_id_loans_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."loans"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_assignments" ADD CONSTRAINT "month_assignments_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_notes" ADD CONSTRAINT "month_notes_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_aliases" ADD CONSTRAINT "payee_aliases_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_default_category_id_categories_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_transfer_account_id_accounts_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_matched_transaction_id_transactions_id_fk" FOREIGN KEY ("matched_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_attempts" ADD CONSTRAINT "pin_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_payloads" ADD CONSTRAINT "raw_payloads_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_adjustment_tx_id_transactions_id_fk" FOREIGN KEY ("adjustment_tx_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transaction_splits" ADD CONSTRAINT "scheduled_transaction_splits_scheduled_transaction_id_scheduled_transactions_id_fk" FOREIGN KEY ("scheduled_transaction_id") REFERENCES "public"."scheduled_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transaction_splits" ADD CONSTRAINT "scheduled_transaction_splits_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transaction_splits" ADD CONSTRAINT "scheduled_transaction_splits_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transaction_splits" ADD CONSTRAINT "scheduled_transaction_splits_transfer_account_id_accounts_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transactions" ADD CONSTRAINT "scheduled_transactions_transfer_account_id_accounts_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transfer_account_id_accounts_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transfer_pair_id_transactions_id_fk" FOREIGN KEY ("transfer_pair_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_account_id_accounts_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_pair_id_transactions_id_fk" FOREIGN KEY ("transfer_pair_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_scheduled_transaction_id_scheduled_transactions_id_fk" FOREIGN KEY ("scheduled_transaction_id") REFERENCES "public"."scheduled_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_entity_idx" ON "accounts" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "ai_conversations_user_idx" ON "ai_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_conversation_idx" ON "ai_tool_calls" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_status_idx" ON "ai_tool_calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_usage_at_idx" ON "ai_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "balances_as_of_idx" ON "balances" USING btree ("as_of");--> statement-breakpoint
CREATE INDEX "budget_operations_at_idx" ON "budget_operations" USING btree ("at");--> statement-breakpoint
CREATE INDEX "categories_group_idx" ON "categories" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_linked_account_uq" ON "categories" USING btree ("linked_account_id") WHERE "categories"."kind" = 'cc_payment';--> statement-breakpoint
CREATE UNIQUE INDEX "categories_singleton_kind_uq" ON "categories" USING btree ("kind") WHERE "categories"."kind" in ('internal_rta', 'uncategorized');--> statement-breakpoint
CREATE INDEX "categorization_events_transaction_idx" ON "categorization_events" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "categorization_events_at_idx" ON "categorization_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "holdings_as_of_idx" ON "holdings" USING btree ("as_of");--> statement-breakpoint
CREATE INDEX "loan_events_account_date_idx" ON "loan_events" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "month_assignments_category_idx" ON "month_assignments" USING btree ("category_id","month");--> statement-breakpoint
CREATE INDEX "payee_aliases_payee_idx" ON "payee_aliases" USING btree ("payee_id");--> statement-breakpoint
CREATE INDEX "payees_transfer_account_idx" ON "payees" USING btree ("transfer_account_id");--> statement-breakpoint
CREATE INDEX "payroll_runs_check_date_idx" ON "payroll_runs" USING btree ("check_date");--> statement-breakpoint
CREATE INDEX "pin_attempts_user_idx" ON "pin_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "pin_attempts_ip_idx" ON "pin_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "raw_payloads_fetched_at_idx" ON "raw_payloads" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "reconciliations_account_idx" ON "reconciliations" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "rules_priority_idx" ON "rules" USING btree ("enabled","priority");--> statement-breakpoint
CREATE INDEX "scheduled_transaction_splits_parent_idx" ON "scheduled_transaction_splits" USING btree ("scheduled_transaction_id");--> statement-breakpoint
CREATE INDEX "scheduled_transactions_next_date_idx" ON "scheduled_transactions" USING btree ("next_date");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_runs_connection_started_idx" ON "sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "transaction_splits_transaction_idx" ON "transaction_splits" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_splits_category_idx" ON "transaction_splits" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "transactions_account_date_idx" ON "transactions" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "transactions_category_date_idx" ON "transactions" USING btree ("category_id","date");--> statement-breakpoint
CREATE INDEX "transactions_date_idx" ON "transactions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "transactions_payee_idx" ON "transactions" USING btree ("payee_id");--> statement-breakpoint
CREATE INDEX "transactions_import_hash_idx" ON "transactions" USING btree ("import_hash");--> statement-breakpoint
CREATE INDEX "transactions_transfer_pair_idx" ON "transactions" USING btree ("transfer_pair_id");--> statement-breakpoint
CREATE INDEX "transactions_unapproved_idx" ON "transactions" USING btree ("date") WHERE "transactions"."approved" = false and "transactions"."deleted_at" is null;