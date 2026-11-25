/**
 * View models consumed by the component kit. Pages build these from engine/db output
 * (second pass) — components never query anything themselves.
 * All money is bigint milliunits.
 */
import type { AccountKind, CatzMethod, Cleared, Month, TargetType, CategoryKind } from "@homebase/shared";

export type Milli = bigint;

/** Semantic state of a category's Available amount (spec §12.1). */
export type AvailableState =
  | "funded" // > 0, green
  | "zero" // 0, gray
  | "credit_overspent" // < 0 from card spending, yellow
  | "cash_overspent" // < 0 from cash (or mixed), red
  | "upcoming"; // underfunded with an upcoming scheduled transaction, yellow

/** Editable target fields (mirrors core's TargetInputSchema). */
export interface TargetFields {
  type: TargetType;
  amount: Milli;
  cadence: "none" | "weekly" | "monthly" | "yearly" | "every_n_months";
  cadenceEvery: number;
  day: number | null;
  targetDate: string | null;
  percent: string | null;
}

export interface TargetVM {
  type: TargetType;
  /** Raw fields for the target editor. */
  fields?: TargetFields;
  /** Human sentence, e.g. "Set aside another $450.00 each month". */
  description: string;
  /** Target amount X. */
  amount: Milli;
  /** needed(M) for the month, before subtracting Assigned. */
  needed: Milli;
  underfunded: Milli;
  /** Due date label for "more needed by …" (e.g. "Oct 31"). */
  dueLabel?: string;
  snoozed?: boolean;
}

export interface CategoryVM {
  id: string;
  groupId: string;
  name: string; // may still carry YNAB emoji (user data); show it through categoryLabel()
  /** lucide icon key (kebab-case), null = suggested from the name. */
  icon?: string | null;
  kind: CategoryKind;
  assigned: Milli;
  activity: Milli;
  available: Milli;
  /** Breakdown for the category sheet. */
  carryIn?: Milli;
  cashSpending?: Milli;
  creditSpending?: Milli;
  /** Portion of a negative Available that came from cash (drives red vs yellow). */
  cashOverspend?: Milli;
  creditOverspend?: Milli;
  upcoming?: Milli;
  target: TargetVM | null;
  note?: string;
  hidden?: boolean;
  /** Engine pill color (authoritative for cash vs credit overspending). */
  pill?: "green" | "yellow" | "red" | "gray";
  /** Engine status label, used when there is no target. */
  statusLabel?: string;
  /** Card payment categories: the linked card and the suggested payment (§6.4). */
  linkedAccountId?: string | null;
  suggestedPayment?: Milli;
}

export interface GroupVM {
  id: string;
  name: string;
  categories: CategoryVM[];
  /** Credit Card Payments is pinned to the top. */
  pinned?: boolean;
}

export interface MonthSummaryVM {
  month: Month;
  readyToAssign: Milli;
  leftOverFromLastMonth: Milli;
  assignedThisMonth: Milli;
  activity: Milli;
  available: Milli;
  costToBeMe: Milli;
  assignedInFutureMonths: Milli;
  ageOfMoneyDays: number | null;
  note?: string;
  /** Ready to Assign carried from last month. */
  rtaLeftOver?: Milli;
  income?: Milli;
  /** The Uncategorized system category, when it has a balance. */
  uncategorized?: { id: string; activity: Milli; available: Milli } | null;
}

export type ConnectionStatus = "ok" | "needs_attention" | "error" | "disabled" | "manual";
export type WealthSection = "cash" | "credit" | "investments" | "retirement" | "crypto" | "home" | "mortgage" | "business";

export interface AccountVM {
  id: string;
  name: string;
  institution: string;
  kind: AccountKind;
  onBudget: boolean;
  entity: "household" | "business";
  section: WealthSection;
  balance: Milli;
  clearedBalance?: Milli;
  /** ISO timestamp (or date) of the last successful sync / balance; null = never. */
  updatedAt: string | null;
  /** Unapproved transactions in this account. */
  unapprovedCount?: number;
  status: ConnectionStatus;
  statusNote?: string;
  /** Closed accounts only appear in the sidebar's CLOSED section. */
  closed?: boolean;
  unclearedBalance?: Milli;
}

export interface SuggestionVM {
  categoryId: string;
  categoryName: string;
  confidence: number; // 0..1
  method: CatzMethod;
  explanation: string;
}

export interface SplitLineVM {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  amount: Milli;
  memo?: string;
}

export interface TransactionVM {
  id: string;
  date: string; // YYYY-MM-DD
  payee: string;
  rawDescription: string;
  amount: Milli; // − outflow, + inflow
  accountId: string;
  accountName: string;
  categoryId: string | null;
  categoryName: string | null;
  /** Group of the category (register shows "Group: Category"), when known. */
  categoryGroup?: string | null;
  categoryIcon?: string | null;
  memo?: string;
  cleared: Cleared;
  approved: boolean;
  splits?: SplitLineVM[];
  transferAccountName?: string;
  suggestion?: SuggestionVM;
  alternatives?: SuggestionVM[];
  runningBalance?: Milli;
  payeeId?: string | null;
  flag?: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | null;
}

export interface CategoryOption {
  id: string;
  name: string;
  groupName: string;
  icon?: string | null;
  available?: Milli;
}

export interface ChartDatum {
  label: string;
  value: Milli;
  color?: string;
}

export interface HoldingVM {
  symbol: string;
  name: string;
  quantity: string; // numeric string, display only
  price: Milli;
  marketValue: Milli;
  costBasis: Milli | null;
  assetClass: string;
}

export interface ConversationVM {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
}

export type AskBlockVM =
  | { type: "donut"; title: string; data: ChartDatum[] }
  | { type: "table"; title: string; rows: { label: string; value: Milli }[] }
  | {
      type: "action";
      tool: string;
      summary: string;
      diff: { label: string; before?: string; after: string }[];
      notes?: string[];
    };

export interface AskMessageVM {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Date range the answer used (spec §11.2: always state it). */
  range?: string;
  blocks?: AskBlockVM[];
}
