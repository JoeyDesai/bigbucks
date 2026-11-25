import "server-only";
/**
 * AiToolContext (the Ask agent's read tools) on top of @homebase/core, plus the default
 * ActionExecutor wiring. Money stays bigint milliunits; the ai package formats and redacts it
 * before anything reaches the model.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import * as core from "@homebase/core";
import { DbReadOnlySqlExecutor, resolveReadOnlyDatabaseUrl } from "@homebase/ai/db";
import {
  MerchantProfileSchema,
  type AccountRef,
  type AiToolContext,
  type BudgetMonthData,
  type CategoryRef,
  type ChartSpec,
  type HoldingsResult,
  type MerchantProfile,
  type OverviewData,
  type ReadOnlySqlExecutor,
  type SpendingSummaryArgs,
  type SpendingSummaryResult,
  type TransactionFilters,
  type TransactionQueryResult,
} from "@homebase/ai";
import { normalizedKey, testRuleAgainstHistory } from "@homebase/categorizer";
import { payees, transactions, type Db } from "@homebase/db";
import type { ISODate, Milli } from "@homebase/shared";
import { aiRuleToCanonical } from "./rules";
import { createActionExecutor, type ExecutorDeps } from "./executor";
import { insertRule, loadRuleSubjects } from "../settings/rules";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (ids: string[] | undefined) => {
  if (!ids?.length) return undefined;
  const bad = ids.filter((i) => !UUID.test(i));
  if (bad.length) throw new Error(`Unknown id(s): ${bad.slice(0, 3).join(", ")}. Use ids from the lists or earlier tool results.`);
  return ids;
};

// One read-only pool per process (homebase_ro). Created lazily: dev databases often have the role as NOLOGIN.
const G = globalThis as unknown as { __homebaseRoSql?: DbReadOnlySqlExecutor };
function readOnlySql(): ReadOnlySqlExecutor {
  return {
    async runReadOnly(wrappedSql, opts) {
      if (!G.__homebaseRoSql) {
        let url: string;
        try {
          url = resolveReadOnlyDatabaseUrl();
        } catch (e) {
          throw new Error(`The read-only SQL role isn't configured (${(e as Error).message})`);
        }
        G.__homebaseRoSql = new DbReadOnlySqlExecutor(url, { max: 2 });
      }
      return G.__homebaseRoSql.runReadOnly(wrappedSql, opts);
    },
  };
}

export interface ToolContextOptions {
  today?: ISODate;
  userId: string | null;
  /** Settings → AI "web lookup" switch; when off, lookup_merchant answers from the cache only. */
  webLookupEnabled: boolean;
  sql?: ReadOnlySqlExecutor;
}

async function spendingSummary(db: Db, a: SpendingSummaryArgs): Promise<SpendingSummaryResult> {
  // Same inclusion rules as core.spendingSummary / v_cashflow_monthly, but with outflows and refunds separated.
  const conds = [
    sql`v.on_budget`,
    sql`NOT v.is_starting_balance`,
    sql`v.cleared <> 'pending'`,
    sql`v.category_kind IS DISTINCT FROM 'internal_rta'`,
    sql`NOT (v.is_transfer AND v.category_id IS NULL)`,
    sql`v.date >= ${a.startDate}`,
    sql`v.date <= ${a.endDate}`,
  ];
  const hh = await core.householdEntityId(db);
  if (hh) conds.push(sql`v.entity_id = ${hh}`);
  if (uuids(a.accountIds)) conds.push(sql`v.account_id IN ${a.accountIds}`);
  if (uuids(a.categoryIds)) conds.push(sql`v.category_id IN ${a.categoryIds}`);
  if (uuids(a.payeeIds)) conds.push(sql`v.payee_id IN ${a.payeeIds}`);
  const [key, label] = {
    category: [sql`v.category_id::text`, sql`coalesce(v.category_name, 'Uncategorized')`],
    group: [sql`v.group_id::text`, sql`coalesce(v.group_name, 'Uncategorized')`],
    payee: [sql`v.payee_id::text`, sql`coalesce(v.payee_name, '(no payee)')`],
    month: [sql`v.month::text`, sql`to_char(v.month, 'Mon YYYY')`],
    account: [sql`v.account_id::text`, sql`v.account_name`],
  }[a.groupBy];
  const res = await db.execute<{ key: string | null; label: string; outflow: bigint; inflow: bigint; n: bigint }>(sql`
    SELECT ${key} AS key, ${label} AS label,
      coalesce(sum(v.amount_milli) FILTER (WHERE v.amount_milli < 0), 0)::bigint AS outflow,
      coalesce(sum(v.amount_milli) FILTER (WHERE v.amount_milli > 0), 0)::bigint AS inflow,
      count(*)::bigint AS n
    FROM v_transactions_flat v
    WHERE ${sql.join(conds, sql` AND `)}
    GROUP BY 1, 2
    ORDER BY ${a.groupBy === "month" ? sql`1 ASC` : sql`(coalesce(sum(v.amount_milli), 0)) ASC`}`);
  let rows = res.rows.map((r) => {
    const outflow = BigInt(r.outflow);
    const inflow = BigInt(r.inflow);
    return { key: r.key ?? "none", label: r.label, outflow, inflow, net: outflow + inflow, count: Number(r.n) };
  });
  const total = rows.reduce((t, r) => ({ outflow: t.outflow + r.outflow, inflow: t.inflow + r.inflow, net: t.net + r.net }), { outflow: 0n, inflow: 0n, net: 0n });
  if (a.limit) rows = rows.slice(0, a.limit);
  return { startDate: a.startDate, endDate: a.endDate, groupBy: a.groupBy, rows, total };
}

export function createAiToolContext(db: Db, o: ToolContextOptions): AiToolContext {
  const today = o.today;
  const ctx: AiToolContext = {
    async getOverview(): Promise<OverviewData> {
      const ov = await core.getOverview(db, today ? { today } : {});
      return {
        month: ov.month,
        readyToAssign: ov.readyToAssign,
        overspent: ov.overspent.map((c) => ({ categoryId: c.categoryId, category: c.name, available: c.available })),
        unapprovedCount: ov.unapprovedCount,
        uncategorizedCount: ov.uncategorizedCount,
        netWorth: ov.netWorth,
        lastSync: ov.accounts.map((a) => ({ account: a.name, at: a.lastSyncAt ? new Date(a.lastSyncAt as Date | string).toISOString() : null, status: a.statusColor })),
      };
    },

    async getBudgetMonth(month): Promise<BudgetMonthData> {
      const v = await core.getBudgetMonth(db, month, today ? { today } : {});
      const categories = v.groups.flatMap((g) =>
        g.categories.map((c) => ({
          categoryId: c.id,
          group: g.name,
          category: c.name,
          assigned: c.assigned,
          activity: c.activity,
          available: c.available,
          target: c.target ? { type: c.target.type, amount: c.target.amount, needed: c.needed, underfunded: c.underfunded, summary: `${c.target.label}. ${c.statusLabel}` } : null,
        })),
      );
      if (v.uncategorized) {
        const u = v.uncategorized;
        categories.push({ categoryId: u.id, group: "Uncategorized", category: u.name, assigned: u.assigned, activity: u.activity, available: u.available, target: null });
      }
      return { month: v.month, readyToAssign: v.summary.readyToAssign, categories };
    },

    async queryTransactions(f: TransactionFilters): Promise<TransactionQueryResult> {
      const filters: core.TransactionFilters = {
        ...(f.startDate ? { dateFrom: f.startDate } : {}),
        ...(f.endDate ? { dateTo: f.endDate } : {}),
        ...(uuids(f.categoryIds) ? { categoryIds: f.categoryIds } : {}),
        ...(uuids(f.payeeIds) ? { payeeIds: f.payeeIds } : {}),
        ...(uuids(f.accountIds) ? { accountIds: f.accountIds } : {}),
        ...(f.text || f.payeeText ? { text: (f.text ?? f.payeeText)! } : {}),
        ...(f.direction === "outflow" ? { maxAmount: -1n } : f.direction === "inflow" ? { minAmount: 1n } : {}),
        ...(f.minAbsAmount !== undefined ? { minAbsAmount: f.minAbsAmount } : {}),
        ...(f.maxAbsAmount !== undefined ? { maxAbsAmount: f.maxAbsAmount } : {}),
        ...(f.approved !== undefined ? { approved: f.approved } : {}),
        ...(f.uncleared ? { cleared: ["uncleared" as const] } : {}),
        ...(f.uncategorized !== undefined ? { uncategorized: f.uncategorized } : {}),
      };
      const page = await core.listTransactions(db, filters, { limit: Math.min(f.limit, 200), totals: true });
      let rows = page.rows;
      // text and payeeText both given: text went to SQL, narrow by payee here.
      if (f.text && f.payeeText) rows = rows.filter((r) => (r.payeeName ?? "").toLowerCase().includes(f.payeeText!.toLowerCase()));
      return {
        rows: rows.map((r) => ({
          id: r.id,
          date: r.date,
          account: r.accountName,
          payee: r.payeeName,
          category: r.isSplit ? `Split (${r.splits.map((s) => s.categoryName ?? "Uncategorized").join(", ")})` : r.categoryName,
          categoryId: r.categoryId,
          amount: r.amount,
          memo: r.memo,
          approved: r.approved,
          cleared: r.cleared,
          isSplit: r.isSplit,
          isTransfer: r.transferAccountId !== null,
        })),
        totalCount: page.totals?.count ?? rows.length,
        totals: page.totals ? { inflow: page.totals.inflow, outflow: page.totals.outflow, net: page.totals.net } : { inflow: 0n, outflow: 0n, net: 0n },
      };
    },

    spendingSummary: (a) => spendingSummary(db, a),

    async netWorth(a) {
      const r = await core.netWorth(db, { period: { from: a.startDate, to: a.endDate }, granularity: a.granularity, ...(today ? { today } : {}) });
      return { points: r.series.map((p) => ({ date: p.date, assets: p.assets, liabilities: p.liabilities, netWorth: p.netWorth })) };
    },

    async holdings(a): Promise<HoldingsResult> {
      if (a.accountId) uuids([a.accountId]);
      const r = await core.holdings(db, a.accountId ? { accountId: a.accountId } : {});
      return {
        asOf: r.asOf,
        total: r.total,
        holdings: r.positions.map((p) => ({
          account: p.accounts.map((x) => x.accountName).join(", "),
          symbol: p.symbol,
          name: p.name ?? p.symbol,
          quantity: p.quantity,
          marketValue: p.marketValue,
          costBasis: p.costBasis,
        })),
      };
    },

    sql: o.sql ?? readOnlySql(),

    async getMerchantProfile(name: string): Promise<MerchantProfile | null> {
      const key = normalizedKey(name);
      const [p] = key
        ? await db
            .select({ merchant: payees.merchant })
            .from(payees)
            .where(sql`${payees.normalizedKey} = ${key} OR regexp_replace(lower(${payees.normalizedKey}), '[^a-z0-9]', '', 'g') = ${key}`)
            .limit(1)
        : [];
      const parsed = p?.merchant ? MerchantProfileSchema.safeParse(p.merchant) : null;
      if (parsed?.success) return parsed.data;
      if (!o.webLookupEnabled) {
        // Short-circuits the web search without caching anything (the switch can be turned back on).
        return { website: null, type: "unknown", location: null, description: "Web lookup is turned off in Settings → AI.", confidence: 0, looked_up_at: new Date().toISOString(), found: false };
      }
      return null;
    },

    async saveMerchantProfile(name: string, profile: MerchantProfile): Promise<void> {
      const key = normalizedKey(name);
      if (!key) return;
      await db
        .update(payees)
        .set({ merchant: profile as never, updatedAt: new Date() })
        .where(sql`${payees.normalizedKey} = ${key} OR regexp_replace(lower(${payees.normalizedKey}), '[^a-z0-9]', '', 'g') = ${key}`);
    },

    async saveReport(name: string, spec: ChartSpec) {
      // render_chart/save_report from the model is a read-side tool (spec §11.3); it runs as the user.
      const r = await core.saveReport(core.userCtx(db, o.userId, today), { name, spec: { kind: "ai_chart", chart: spec } });
      return { id: r.id };
    },

    async getTransactionsByIds(ids: string[]) {
      const valid = ids.filter((i) => UUID.test(i));
      if (!valid.length) return [];
      const rows = await db
        .select({ id: transactions.id, date: transactions.date, payee: payees.name, amount: transactions.amountMilli, categoryId: transactions.categoryId, isSplit: transactions.isSplit, approved: transactions.approved })
        .from(transactions)
        .leftJoin(payees, eq(payees.id, transactions.payeeId))
        .where(and(inArray(transactions.id, valid), isNull(transactions.deletedAt)));
      return rows.map((r) => ({ ...r, payee: r.payee ?? null }));
    },

    async getCategories(): Promise<CategoryRef[]> {
      return listCategoryRefs(db);
    },

    async previewRule(rule) {
      const r = testRuleAgainstHistory(aiRuleToCanonical(rule), await loadRuleSubjects(db));
      return { matchCount: r.matchCount };
    },
  };
  return ctx;
}

export async function listCategoryRefs(db: Db): Promise<CategoryRef[]> {
  const groups = await core.listCategories(db, { includeHidden: true });
  return groups.flatMap((g) => g.categories.map((c) => ({ id: c.id, name: c.name, group: g.name, kind: c.kind, hidden: c.hidden || g.hidden })));
}

export async function listAccountRefs(db: Db): Promise<AccountRef[]> {
  const accts = await core.listAccounts(db, { includeClosed: false });
  return accts.map((a) => ({ id: a.id, name: a.displayName, kind: a.kind, onBudget: a.onBudget, entity: a.entityName, closed: a.closed }));
}

/** Production executor deps: real core services plus the web's rule helpers. */
export const DEFAULT_EXECUTOR_DEPS: ExecutorDeps = {
  recategorize: (ctx, ids, categoryId) => core.recategorize(ctx, ids, categoryId),
  splitTransaction: (ctx, id, lines) => core.splitTransaction(ctx, id, lines),
  getTransactionAmount: async (db, id) => {
    const t = await core.getTransaction(db, id);
    return { amount: t.amount as Milli, categoryId: t.categoryId, isSplit: t.isSplit };
  },
  approveTransactions: (ctx, ids) => core.approveTransactions(ctx, ids),
  assign: (ctx, input) => core.assign(ctx, input),
  moveMoney: (ctx, input) => core.moveMoney(ctx, input),
  autoAssign: (ctx, input) => core.autoAssign(ctx, input),
  listGroups: async (db) => (await core.listCategories(db, { includeHidden: true })).map((g) => ({ id: g.id, name: g.name, isSystem: g.isSystem })),
  createGroup: (ctx, input) => core.createGroup(ctx, input),
  createCategory: (ctx, input) => core.createCategory(ctx, input),
  editTarget: (ctx, input) => core.editTarget(ctx, input),
  addMemory: (ctx, text) => core.addMemory(ctx, text),
  insertRule: (ctx, input) => insertRule(ctx, input),
  loadRuleSubjects: (db) => loadRuleSubjects(db),
};

export function defaultActionExecutor(db: Db, requestedBy: string | null, today?: ISODate) {
  return createActionExecutor({ db, requestedBy, deps: DEFAULT_EXECUTOR_DEPS, ...(today ? { today } : {}) });
}
