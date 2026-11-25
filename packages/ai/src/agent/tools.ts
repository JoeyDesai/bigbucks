/**
 * Tool definitions (§11.3) and the read-tool runners. Tool order is fixed so the tools prefix
 * stays byte-identical across requests (prompt caching); the last tool carries a cache breakpoint.
 */
import { z } from "zod";
import { formatMilli, formatMonth, parseMilli } from "@homebase/shared";
import type { AiClient, BetaTool } from "../client";
import { lookupMerchant } from "../merchantLookup";
import { toModelJson } from "../json";
import type { WebQueryPolicy } from "../redact";
import type { AiToolContext, TransactionFilters } from "./context";
import type { ChartSpec } from "./chart";
import { runGuardedSql } from "./sqlGuard";
import { ToolInputError } from "./actions";
import {
  READ_TOOL_NAMES,
  READ_TOOL_SCHEMAS,
  TOOL_DESCRIPTIONS,
  WRITE_TOOL_NAMES,
  WRITE_TOOL_SCHEMAS,
  normalizeMonth,
  type ReadToolInput,
  type ReadToolName,
  type ToolName,
} from "./schemas";

export function toolInputJsonSchema(schema: z.ZodType): BetaTool["input_schema"] {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== "object") throw new Error("tool input schema must be an object");
  return js as BetaTool["input_schema"];
}

/** All tool definitions in a deterministic order: read tools, then write tools. */
export function buildToolDefinitions(): BetaTool[] {
  const names: ToolName[] = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES];
  const tools: BetaTool[] = names.map((name) => {
    const schema = (READ_TOOL_SCHEMAS as Record<string, z.ZodType>)[name] ?? (WRITE_TOOL_SCHEMAS as Record<string, z.ZodType>)[name]!;
    return {
      name,
      description: TOOL_DESCRIPTIONS[name],
      input_schema: toolInputJsonSchema(schema),
      // Streaming loop: let large inputs stream; we validate every input with Zod before use.
      eager_input_streaming: true,
    };
  });
  const last = tools[tools.length - 1]!;
  tools[tools.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
  return tools;
}

let cachedTools: BetaTool[] | null = null;
export function toolDefinitions(): BetaTool[] {
  cachedTools ??= buildToolDefinitions();
  return cachedTools;
}

export interface ReadToolEnv {
  ctx: AiToolContext;
  ai: AiClient;
  webQueryPolicy?: WebQueryPolicy;
}

export interface ReadToolOutput {
  /** JSON (redacted, dollars formatted) for the model. */
  content: string;
  /** One-line summary for the UI / ai_tool_calls.output_summary. */
  summary: string;
  chart?: ChartSpec;
}

const optMilli = (s: string | undefined) => (s === undefined ? undefined : parseMilli(s));

function toFilters(i: ReadToolInput<"query_transactions">): TransactionFilters {
  const f: TransactionFilters = { limit: i.limit ?? 50 };
  if (i.start_date) f.startDate = i.start_date;
  if (i.end_date) f.endDate = i.end_date;
  if (i.category_ids) f.categoryIds = i.category_ids;
  if (i.payee_ids) f.payeeIds = i.payee_ids;
  if (i.payee_text) f.payeeText = i.payee_text;
  if (i.account_ids) f.accountIds = i.account_ids;
  if (i.direction) f.direction = i.direction;
  const min = optMilli(i.min_abs_amount);
  const max = optMilli(i.max_abs_amount);
  if (min !== undefined) f.minAbsAmount = min;
  if (max !== undefined) f.maxAbsAmount = max;
  if (i.text) f.text = i.text;
  if (i.approved !== undefined) f.approved = i.approved;
  if (i.uncleared !== undefined) f.uncleared = i.uncleared;
  if (i.uncategorized !== undefined) f.uncategorized = i.uncategorized;
  return f;
}

type Runner<K extends ReadToolName> = (input: ReadToolInput<K>, env: ReadToolEnv) => Promise<ReadToolOutput>;

const RUNNERS: { [K in ReadToolName]: Runner<K> } = {
  async get_overview(_i, { ctx }) {
    const o = await ctx.getOverview();
    return {
      content: toModelJson(o),
      summary: `Ready to Assign ${formatMilli(o.readyToAssign)}, ${o.overspent.length} overspent, ${o.unapprovedCount} unapproved`,
    };
  },
  async get_budget_month(i, { ctx }) {
    const month = normalizeMonth(i.month);
    const b = await ctx.getBudgetMonth(month);
    return { content: toModelJson(b), summary: `${b.categories.length} categories for ${formatMonth(month)}` };
  },
  async query_transactions(i, { ctx }) {
    if (i.start_date && i.end_date && i.start_date > i.end_date) throw new ToolInputError("start_date is after end_date");
    const r = await ctx.queryTransactions(toFilters(i));
    return {
      content: toModelJson({ ...r, rows: r.rows.slice(0, 200), dateRange: { start: i.start_date ?? null, end: i.end_date ?? null } }),
      summary: `${Math.min(r.rows.length, 200)} of ${r.totalCount} transactions, net ${formatMilli(r.totals.net)}`,
    };
  },
  async spending_summary(i, { ctx }) {
    if (i.start_date > i.end_date) throw new ToolInputError("start_date is after end_date");
    const r = await ctx.spendingSummary({
      groupBy: i.group_by,
      startDate: i.start_date,
      endDate: i.end_date,
      ...(i.category_ids ? { categoryIds: i.category_ids } : {}),
      ...(i.account_ids ? { accountIds: i.account_ids } : {}),
      ...(i.payee_ids ? { payeeIds: i.payee_ids } : {}),
      ...(i.limit ? { limit: i.limit } : {}),
    });
    return { content: toModelJson(r), summary: `${r.rows.length} ${i.group_by} rows, outflow ${formatMilli(r.total.outflow)} (${i.start_date} to ${i.end_date})` };
  },
  async net_worth(i, { ctx }) {
    const r = await ctx.netWorth({ startDate: i.start_date, endDate: i.end_date, granularity: i.granularity });
    const last = r.points[r.points.length - 1];
    return { content: toModelJson(r), summary: `${r.points.length} points${last ? `, latest ${formatMilli(last.netWorth)} on ${last.date}` : ""}` };
  },
  async holdings(i, { ctx }) {
    const r = await ctx.holdings(i.account_id ? { accountId: i.account_id } : {});
    return { content: toModelJson(r), summary: `${r.holdings.length} holdings, total ${formatMilli(r.total)}` };
  },
  async sql_query(i, { ctx }) {
    const r = await runGuardedSql(ctx.sql, i.sql);
    if (!r.ok) throw new ToolInputError(`Query rejected: ${r.reason}`);
    return {
      content: toModelJson({ columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated }),
      summary: `${r.rowCount} rows${r.truncated ? " (truncated at 500)" : ""}`,
    };
  },
  async lookup_merchant(i, { ctx, ai, webQueryPolicy }) {
    const cached = await ctx.getMerchantProfile(i.name);
    if (cached) return { content: toModelJson({ cached: true, profile: cached }), summary: `${i.name}: ${cached.type} (cached)` };
    const r = await lookupMerchant(ai, { merchant: i.name, city: i.city ?? null }, webQueryPolicy ?? {});
    if (r.status === "found" || r.status === "not_found") {
      await ctx.saveMerchantProfile(i.name, r.profile);
      return { content: toModelJson({ cached: false, status: r.status, profile: r.profile }), summary: `${i.name}: ${r.status === "found" ? r.profile.type : "not identified"}` };
    }
    if (r.status === "unavailable") throw new ToolInputError("Merchant lookup is unavailable (AI monthly cap reached or disabled)");
    throw new ToolInputError(`Merchant lookup failed: ${"reason" in r ? r.reason : "unknown error"}`);
  },
  async render_chart(i) {
    return { content: "The chart is now shown to the user. Do not repeat its data as a table.", summary: `${i.spec.type} chart: ${i.spec.title}`, chart: i.spec };
  },
  async save_report(i, { ctx }) {
    const r = await ctx.saveReport(i.name, i.spec);
    return { content: toModelJson({ saved: true, id: r.id, name: i.name }), summary: `Saved report ${i.name}` };
  },
};

export async function runReadTool<K extends ReadToolName>(name: K, input: ReadToolInput<K>, env: ReadToolEnv): Promise<ReadToolOutput> {
  return (RUNNERS[name] as Runner<K>)(input, env);
}
