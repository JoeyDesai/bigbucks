/**
 * Persistence/query interfaces the agent depends on. The db layer implements these against
 * @homebase/db; tests use in-memory fakes. All money is bigint milliunits; the agent formats it
 * as dollars before anything reaches the model.
 */
import type { AccountKind, AutoAssignMode, CategoryKind, ISODate, Milli, Month } from "@homebase/shared";
import type { MerchantProfile } from "../types";
import type { ReadOnlySqlExecutor } from "./sqlGuard";
import type { ChartSpec } from "./chart";
import type { WriteToolInput, WriteToolName } from "./schemas";

// ---------- read-side data shapes ----------

export interface OverviewData {
  month: Month;
  readyToAssign: Milli;
  overspent: { categoryId: string; category: string; available: Milli }[];
  unapprovedCount: number;
  uncategorizedCount: number;
  netWorth: Milli;
  lastSync: { account: string; at: string | null; status: string }[];
}

export interface BudgetMonthCategory {
  categoryId: string;
  group: string;
  category: string;
  assigned: Milli;
  activity: Milli;
  available: Milli;
  target: { type: string; amount: Milli | null; needed: Milli; underfunded: Milli; summary: string } | null;
}

export interface BudgetMonthData {
  month: Month;
  readyToAssign: Milli;
  categories: BudgetMonthCategory[];
}

export interface TransactionFilters {
  startDate?: ISODate;
  endDate?: ISODate;
  categoryIds?: string[];
  payeeIds?: string[];
  payeeText?: string;
  accountIds?: string[];
  direction?: "outflow" | "inflow" | "any";
  /** Inclusive bounds on |amount|. */
  minAbsAmount?: Milli;
  maxAbsAmount?: Milli;
  text?: string;
  approved?: boolean;
  uncleared?: boolean;
  uncategorized?: boolean;
  limit: number;
}

export interface TransactionRow {
  id: string;
  date: ISODate;
  account: string;
  payee: string | null;
  category: string | null;
  categoryId: string | null;
  amount: Milli;
  memo: string | null;
  approved: boolean;
  cleared: string;
  isSplit: boolean;
  isTransfer: boolean;
}

export interface TransactionQueryResult {
  rows: TransactionRow[];
  totalCount: number;
  totals: { inflow: Milli; outflow: Milli; net: Milli };
}

export interface SpendingSummaryArgs {
  groupBy: "category" | "group" | "payee" | "month" | "account";
  startDate: ISODate;
  endDate: ISODate;
  categoryIds?: string[];
  accountIds?: string[];
  payeeIds?: string[];
  limit?: number;
}

export interface SpendingSummaryResult {
  startDate: ISODate;
  endDate: ISODate;
  groupBy: SpendingSummaryArgs["groupBy"];
  rows: { key: string; label: string; outflow: Milli; inflow: Milli; net: Milli; count: number }[];
  total: { outflow: Milli; inflow: Milli; net: Milli };
}

export interface NetWorthResult {
  points: { date: ISODate; assets: Milli; liabilities: Milli; netWorth: Milli }[];
}

export interface HoldingsResult {
  asOf: ISODate | null;
  holdings: { account: string; symbol: string; name: string; quantity: string; marketValue: Milli; costBasis: Milli | null }[];
  total: Milli;
}

export interface CategoryRef {
  id: string;
  name: string;
  group: string;
  kind: CategoryKind;
  hidden?: boolean;
}

export interface AccountRef {
  id: string;
  name: string;
  kind: AccountKind;
  onBudget: boolean;
  entity: string;
  closed?: boolean;
}

export interface TxnSummary {
  id: string;
  date: ISODate;
  payee: string | null;
  amount: Milli;
  categoryId: string | null;
  isSplit: boolean;
  approved: boolean;
}

/** Query functions the read tools call. */
export interface AiToolContext {
  getOverview(): Promise<OverviewData>;
  getBudgetMonth(month: Month): Promise<BudgetMonthData>;
  queryTransactions(filters: TransactionFilters): Promise<TransactionQueryResult>;
  spendingSummary(args: SpendingSummaryArgs): Promise<SpendingSummaryResult>;
  netWorth(args: { startDate: ISODate; endDate: ISODate; granularity: "day" | "week" | "month" }): Promise<NetWorthResult>;
  holdings(args: { accountId?: string }): Promise<HoldingsResult>;
  /** Runs validated SQL as homebase_ro inside BEGIN READ ONLY with a 5 s timeout. */
  sql: ReadOnlySqlExecutor;
  getMerchantProfile(name: string): Promise<MerchantProfile | null>;
  saveMerchantProfile(name: string, profile: MerchantProfile): Promise<void>;
  saveReport(name: string, spec: ChartSpec): Promise<{ id: string }>;
  /** Lookups used to build human-readable pending-action diffs. */
  getTransactionsByIds(ids: string[]): Promise<TxnSummary[]>;
  getCategories(): Promise<CategoryRef[]>;
  /** Optional previews for richer diffs. */
  previewRule?(rule: WriteToolInput<"create_rule">): Promise<{ matchCount: number }>;
  previewAutoAssign?(month: Month, mode: AutoAssignMode, categoryIds?: string[]): Promise<{ total: Milli; categoryCount: number }>;
}

// ---------- write-side: pending actions, executor, audit ----------

export type PendingActionStatus = "awaiting_confirmation" | "executing" | "confirmed" | "rejected" | "failed";

export interface PendingAction<K extends WriteToolName = WriteToolName> {
  id: string;
  tool: K;
  /** Validated, JSON-safe input (amounts are dollar strings, as the model sent them). */
  input: WriteToolInput<K>;
  humanDiff: string;
  status: PendingActionStatus;
  createdAt: string;
  conversationId?: string;
  requestedBy?: string;
  toolUseId?: string;
}

/** ai_tool_calls rows with status awaiting_confirmation/confirmed/rejected. */
export interface PendingActionStore {
  save(action: PendingAction): Promise<void>;
  get(id: string): Promise<PendingAction | null>;
  /** Compare-and-set; returns false if the action was not in `from` (prevents double execution). */
  transition(id: string, from: PendingActionStatus, to: PendingActionStatus, patch?: { confirmedBy?: string; error?: string }): Promise<boolean>;
}

export interface ExecutedWrite {
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Short text for the UI, e.g. "Moved 14 transactions". */
  summary?: string;
}

/** Applies a confirmed write. Implemented by the web app on top of the engine/db. */
export type ActionExecutor = { [K in WriteToolName]: (input: WriteToolInput<K>, meta: { actionId: string; confirmedBy: string }) => Promise<ExecutedWrite> };

export interface AuditEntry {
  at: string;
  userId: string | null;
  actor: "user" | "ai" | "system";
  confirmedBy: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

/** Persist every message and tool call (ai_messages / ai_tool_calls). Optional. */
export interface AgentRecorder {
  onMessage?(m: { role: "user" | "assistant"; content: unknown; model?: string; inputTokens?: number; outputTokens?: number; costMicroUsd?: bigint }): Promise<void> | void;
  onToolCall?(c: { toolUseId: string; name: string; input: unknown; outputSummary: string; status: "auto" | "awaiting_confirmation" | "error" }): Promise<void> | void;
}
