/** Enum values shared by db schema, engine, connectors and UI. Keep in sync with packages/db/src/schema.ts. */
export const ACCOUNT_KINDS = ["checking", "savings", "cash", "credit_card", "line_of_credit", "brokerage", "retirement", "hsa", "crypto", "mortgage", "loan", "property", "other"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const ON_BUDGET_KINDS: readonly AccountKind[] = ["checking", "savings", "cash", "credit_card"];
export const LIABILITY_KINDS: readonly AccountKind[] = ["credit_card", "line_of_credit", "mortgage", "loan"];
/** Investment accounts: their transactions only move the Investments totals, never the Transactions list or the categorizer. */
export const INVESTMENT_KINDS: readonly AccountKind[] = ["brokerage", "retirement", "hsa", "crypto"];

export const ACCOUNT_SOURCES = ["simplefin", "mercury", "coinbase", "river_csv", "xpub", "rentcast", "amortization", "manual", "ynab_import", "csv"] as const;
export type AccountSource = (typeof ACCOUNT_SOURCES)[number];

export const CATEGORY_KINDS = ["normal", "cc_payment", "internal_rta", "uncategorized"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const CLEARED = ["pending", "uncleared", "cleared", "reconciled"] as const;
export type Cleared = (typeof CLEARED)[number];

export const FLAGS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type Flag = (typeof FLAGS)[number];

export const TARGET_TYPES = ["need_refill", "need_set_aside", "balance", "balance_by_date", "monthly_builder", "debt", "percent_of_income"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const CADENCES = ["none", "weekly", "monthly", "yearly", "every_n_months"] as const;
export type Cadence = (typeof CADENCES)[number];

export const FREQUENCIES = ["once", "daily", "weekly", "biweekly", "twice_monthly", "every_4_weeks", "monthly", "every_other_month", "every_3_months", "every_4_months", "twice_yearly", "yearly", "every_other_year"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const CATZ_METHODS = ["rule", "history", "ai", "ai_web", "user", "ynab", "transfer"] as const;
export type CatzMethod = (typeof CATZ_METHODS)[number];

export interface Catz {
  method: CatzMethod;
  confidence: number;
  model?: string;
  rule_id?: string;
  explanation?: string;
  suggestions?: { category_id: string; confidence: number }[];
  at: string;
}

export const AUTO_ASSIGN_MODES = ["underfunded", "assigned_last_month", "spent_last_month", "average_assigned", "average_spent", "reduce_overfunding", "reset_available", "reset_assigned"] as const;
export type AutoAssignMode = (typeof AUTO_ASSIGN_MODES)[number];
