/** View models for the Ask thread, shared by the server (history loader) and the client (SSE reducer). */
import type { ChartSpec, PendingActionStatus } from "@homebase/ai";

export interface ActionVM {
  id: string;
  tool: string;
  humanDiff: string;
  status: PendingActionStatus;
  /** Validated write-tool input (amounts are dollar strings), for the Edit form. */
  input: Record<string, unknown>;
  error?: string;
  /** Short result text after confirming ("Moved 14 transactions"). */
  result?: string;
}

export type AskPart =
  | { type: "text"; text: string }
  | { type: "chart"; id: string; spec: ChartSpec }
  | { type: "action"; action: ActionVM }
  | { type: "tool"; id: string; name: string; summary?: string; isError?: boolean; done: boolean };

export interface AskTurnVM {
  id: string;
  role: "user" | "assistant";
  parts: AskPart[];
  /** Spoken summary of an assistant reply (speechSynthesis). */
  speech?: string;
  error?: string;
  streaming?: boolean;
}

export interface ConversationListItem {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
}

export interface AskStatusVM {
  configured: boolean;
  /** "Add an Anthropic API key…" etc. when chat can't run. */
  blockedReason: string | null;
  spentMicroUsd: string;
  capMicroUsd: string;
  state: "ok" | "warning" | "exceeded";
  isAdmin: boolean;
  autoSendVoice: boolean;
  chatModel: string;
  deepModel: string;
}

/** The §11.4 example prompts, shown when a thread is empty. */
export const SUGGESTED_PROMPTS = [
  "How much did we spend eating out this year vs last year?",
  "Where did all our money go in September?",
  "Categorize everything from Lowe's this month as House Projects and make a rule.",
  "Are we on track for the Emergency Fund target?",
  "What's our net worth trend since we bought the house?",
  "How much is in our 401ks and how much did they grow last month?",
  "Which subscriptions went up in price?",
  "If we put $500/mo extra on the mortgage, when is it paid off?",
  "Fund all underfunded categories with what's left to assign.",
] as const;

export const TOOL_LABELS: Record<string, string> = {
  get_overview: "Checked the overview",
  get_budget_month: "Read the budget",
  query_transactions: "Searched transactions",
  spending_summary: "Summed spending",
  net_worth: "Read net worth",
  holdings: "Read holdings",
  sql_query: "Ran a read-only query",
  lookup_merchant: "Looked up a merchant",
  render_chart: "Drew a chart",
  save_report: "Saved a report",
};

/** Mirrors WRITE_TOOL_NAMES in @homebase/ai (kept here so client bundles don't pull the SDK). */
export const WRITE_TOOL_SET: ReadonlySet<string> = new Set(["recategorize", "split_transaction", "approve", "create_rule", "assign", "move_money", "auto_assign", "create_category", "update_target", "remember"]);
