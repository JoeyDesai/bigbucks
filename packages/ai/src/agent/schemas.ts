/**
 * Zod input schemas for every §11.3 tool. Amounts from the model are dollar strings
 * ("612.40") so no float ever touches money; they are converted with parseMilli.
 */
import { z } from "zod";
import { AUTO_ASSIGN_MODES, CADENCES, TARGET_TYPES } from "@homebase/shared";
import { ChartSpecSchema } from "./chart";

const Id = z.string().min(1).max(64);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const MonthStr = z
  .string()
  .regex(/^\d{4}-\d{2}(-01)?$/, "YYYY-MM")
  .describe("Month as YYYY-MM");
/** Non-negative dollars as a decimal string. */
const Dollars = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, 'dollars as a decimal string like "612.40"')
  .describe('Dollars as a decimal string, e.g. "612.40"');

// ---------------- read tools ----------------

export const READ_TOOL_SCHEMAS = {
  get_overview: z.object({}),
  get_budget_month: z.object({ month: MonthStr }),
  query_transactions: z.object({
    start_date: IsoDate.optional(),
    end_date: IsoDate.optional(),
    category_ids: z.array(Id).max(50).optional(),
    payee_ids: z.array(Id).max(50).optional(),
    payee_text: z.string().max(80).optional().describe("Case-insensitive payee name match"),
    account_ids: z.array(Id).max(20).optional(),
    direction: z.enum(["outflow", "inflow", "any"]).optional(),
    min_abs_amount: Dollars.optional(),
    max_abs_amount: Dollars.optional(),
    text: z.string().max(80).optional().describe("Search payee, memo and description"),
    approved: z.boolean().optional(),
    uncleared: z.boolean().optional(),
    uncategorized: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  spending_summary: z.object({
    group_by: z.enum(["category", "group", "payee", "month", "account"]),
    start_date: IsoDate,
    end_date: IsoDate,
    category_ids: z.array(Id).max(50).optional(),
    account_ids: z.array(Id).max(20).optional(),
    payee_ids: z.array(Id).max(50).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  net_worth: z.object({ start_date: IsoDate, end_date: IsoDate, granularity: z.enum(["day", "week", "month"]) }),
  holdings: z.object({ account_id: Id.optional() }),
  sql_query: z.object({ sql: z.string().min(1).max(8000).describe("A single SELECT or WITH query over the reporting views") }),
  lookup_merchant: z.object({ name: z.string().min(1).max(80), city: z.string().max(60).optional() }),
  render_chart: z.object({ spec: ChartSpecSchema }),
  save_report: z.object({ name: z.string().min(1).max(80), spec: ChartSpecSchema }),
} as const;

// ---------------- write tools ----------------

const RTA = "ready_to_assign";

export const WRITE_TOOL_SCHEMAS = {
  recategorize: z.object({ transaction_ids: z.array(Id).min(1).max(500), category_id: Id }),
  split_transaction: z.object({
    transaction_id: Id,
    lines: z
      .array(z.object({ category_id: Id, amount: Dollars.describe("Line amount in dollars (magnitude; sign follows the transaction)"), memo: z.string().max(120).optional() }))
      .min(2)
      .max(20),
  }),
  approve: z.object({ transaction_ids: z.array(Id).min(1).max(500) }),
  create_rule: z
    .object({
      payee_equals: z.string().max(80).optional(),
      payee_contains: z.string().max(80).optional(),
      description_contains: z.string().max(80).optional(),
      min_abs_amount: Dollars.optional(),
      max_abs_amount: Dollars.optional(),
      account_ids: z.array(Id).max(20).optional(),
      category_id: Id.optional(),
      set_payee_name: z.string().max(80).optional(),
      auto_approve: z.boolean().optional(),
      apply_to_existing: z.boolean(),
    })
    .refine((r) => Boolean(r.payee_equals || r.payee_contains || r.description_contains || r.min_abs_amount || r.max_abs_amount || r.account_ids?.length), {
      message: "a rule needs at least one condition",
    })
    .refine((r) => Boolean(r.category_id || r.set_payee_name || r.auto_approve), { message: "a rule needs at least one action" }),
  assign: z.object({
    month: MonthStr,
    category_id: Id,
    amount: Dollars,
    mode: z.enum(["set", "add"]).describe("set = make Assigned equal amount; add = add amount to Assigned"),
  }),
  move_money: z.object({
    month: MonthStr,
    from_category_id: Id.describe(`Category id, or "${RTA}"`),
    to_category_id: Id.describe(`Category id, or "${RTA}"`),
    amount: Dollars,
  }),
  auto_assign: z.object({ month: MonthStr, mode: z.enum(AUTO_ASSIGN_MODES), category_ids: z.array(Id).max(100).optional() }),
  create_category: z.object({ group: z.string().min(1).max(60), name: z.string().min(1).max(60) }),
  update_target: z.object({
    category_id: Id,
    target: z.object({
      type: z.enum(TARGET_TYPES),
      amount: Dollars.optional(),
      cadence: z.enum(CADENCES).optional(),
      cadence_every: z.number().int().min(1).max(60).optional(),
      day: z.number().int().min(1).max(31).optional(),
      target_date: IsoDate.optional(),
      percent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional().describe('Percent of income as a decimal string, e.g. "10"'),
    }),
  }),
  remember: z.object({ fact: z.string().min(3).max(300) }),
} as const;

export const READY_TO_ASSIGN_ID = RTA;

export type ReadToolName = keyof typeof READ_TOOL_SCHEMAS;
export type WriteToolName = keyof typeof WRITE_TOOL_SCHEMAS;
export type ToolName = ReadToolName | WriteToolName;
export type ReadToolInput<K extends ReadToolName> = z.infer<(typeof READ_TOOL_SCHEMAS)[K]>;
export type WriteToolInput<K extends WriteToolName> = z.infer<(typeof WRITE_TOOL_SCHEMAS)[K]>;

export const READ_TOOL_NAMES = Object.keys(READ_TOOL_SCHEMAS) as ReadToolName[];
export const WRITE_TOOL_NAMES = Object.keys(WRITE_TOOL_SCHEMAS) as WriteToolName[];

export function isWriteTool(name: string): name is WriteToolName {
  return Object.prototype.hasOwnProperty.call(WRITE_TOOL_SCHEMAS, name);
}
export function isReadTool(name: string): name is ReadToolName {
  return Object.prototype.hasOwnProperty.call(READ_TOOL_SCHEMAS, name);
}

/** "2026-10" or "2026-10-01" → "2026-10-01". */
export function normalizeMonth(m: string): string {
  return m.length === 7 ? `${m}-01` : m;
}

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_overview: "Ready to Assign, overspent categories, unapproved/uncategorized counts, net worth, and last sync per account.",
  get_budget_month: "Every category's assigned, activity, available and target state for one month.",
  query_transactions:
    "Search transactions by date range, categories, payees, accounts, amount range (absolute dollars), text, approved/uncleared. Returns up to 200 rows plus totals for all matches.",
  spending_summary: "Totals grouped by category, group, payee, month or account over a date range. Prefer this for 'how much did we spend' questions.",
  net_worth: "Net worth (assets, liabilities) over a date range at day/week/month granularity.",
  holdings: "Latest investment holdings, optionally for one account.",
  sql_query:
    "Read-only SQL for questions the other tools cannot answer. One SELECT/WITH statement over these views only: v_transactions_flat, v_month_category, v_net_worth_daily, v_holdings_latest, v_cashflow_monthly, v_payee_spend_monthly. Max 500 rows, 5 second timeout. Amount columns are milliunits (divide by 1000 for dollars).",
  lookup_merchant: "Identify an unfamiliar merchant via web search (result cached on the payee). Send only the merchant name and city.",
  render_chart: "Show a chart or table inline. Use numbers you already got from tools. Values in dollars for currency charts.",
  save_report: "Save a chart spec as a named report the household can reopen.",
  recategorize: "Propose moving transactions to a category. Creates a confirmation card; nothing changes until the user confirms.",
  split_transaction: "Propose splitting one transaction into category lines that add up to its amount. Needs confirmation.",
  approve: "Propose approving transactions. Needs confirmation.",
  create_rule: "Propose a categorization rule (conditions → actions), optionally applied to existing matching transactions. Needs confirmation.",
  assign: "Propose assigning money to a category for a month. Needs confirmation.",
  move_money: `Propose moving available money between categories (or to/from "${RTA}") in a month. Needs confirmation.`,
  auto_assign: "Propose a YNAB-style auto-assign (e.g. underfunded) for a month, optionally limited to categories. Needs confirmation.",
  create_category: "Propose creating a category in a group. Needs confirmation.",
  update_target: "Propose setting or changing a category target. Needs confirmation.",
  remember: "Propose saving a household fact to memory (e.g. 'Paychecks land on the 25th'). Needs confirmation.",
};
