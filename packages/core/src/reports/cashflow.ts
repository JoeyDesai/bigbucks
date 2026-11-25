/** §13 reports 3 and 8: income vs expense (with savings rate) and the cash-flow sankey. */
import { sql } from "drizzle-orm";
import { divRound, type Milli, type Month } from "@homebase/shared";
import type { DbLike } from "../context";
import { resolvePeriod, type ReportParams, type ResolvedPeriod } from "./params";
import { drillForKey, reportScope } from "./scope";
import { bps, type ReportTable } from "./table";

export interface IncomeExpenseMonth {
  month: Month;
  income: Milli;
  expense: Milli;
  net: Milli;
  /** (income − expense) / income in basis points; null when there was no income. */
  savingsRateBps: number | null;
}

export interface IncomeVsExpense {
  period: ResolvedPeriod;
  params: ReportParams;
  months: IncomeExpenseMonth[];
  totals: IncomeExpenseMonth & { month: "total" };
  avgIncome: Milli;
  avgExpense: Milli;
  /** Income by payee over the period, largest first. */
  sources: { key: string; label: string; amount: Milli }[];
  table: ReportTable;
}

const rate = (income: Milli, expense: Milli) => (income > 0n ? bps(income - expense, income) : null);

export async function incomeVsExpenseReport(db: DbLike, params: ReportParams): Promise<IncomeVsExpense> {
  const period = resolvePeriod(params);
  const s = await reportScope(db, params, period);
  const res = await db.execute<{ month: string; income: bigint; expense: bigint }>(sql`
    SELECT v.month::text AS month,
      coalesce(sum(v.amount_milli) FILTER (WHERE ${s.income}), 0)::bigint AS income,
      coalesce(-sum(v.amount_milli) FILTER (WHERE ${s.spend}), 0)::bigint AS expense
    FROM v_transactions_flat v
    WHERE ${s.base}
    GROUP BY 1`);
  const by = new Map(res.rows.map((r) => [r.month, r]));
  const months = period.months.map((m) => {
    const r = by.get(m);
    const income = BigInt(r?.income ?? 0n);
    const expense = BigInt(r?.expense ?? 0n);
    return { month: m, income, expense, net: income - expense, savingsRateBps: rate(income, expense) };
  });
  const income = months.reduce((t, m) => t + m.income, 0n);
  const expense = months.reduce((t, m) => t + m.expense, 0n);
  const src = await db.execute<{ payee_id: string | null; label: string; amount: bigint }>(sql`
    SELECT v.payee_id::text AS payee_id, coalesce(max(v.payee_name), max(v.transfer_account_name), 'Other income') AS label, sum(v.amount_milli)::bigint AS amount
    FROM v_transactions_flat v
    WHERE ${s.income}
    GROUP BY v.payee_id
    ORDER BY 3 DESC`);
  const n = BigInt(period.months.length);
  return {
    period,
    params,
    months,
    totals: { month: "total", income, expense, net: income - expense, savingsRateBps: rate(income, expense) },
    avgIncome: divRound(income, n),
    avgExpense: divRound(expense, n),
    sources: src.rows.map((r) => ({ key: r.payee_id ? `payee:${r.payee_id}` : "payee:none", label: r.label, amount: BigInt(r.amount) })),
    table: {
      columns: [
        { key: "month", label: "Month", kind: "month" },
        { key: "income", label: "Income", kind: "money" },
        { key: "expense", label: "Expense", kind: "money" },
        { key: "net", label: "Net", kind: "money", secondary: true, signed: true },
        { key: "rate", label: "Saved", kind: "bps" },
      ],
      rows: months.map((m) => ({
        key: m.month,
        drill: { from: m.month, to: lastOf(m.month, period.to) },
        cells: { month: m.month, income: m.income, expense: m.expense, net: m.net, rate: m.savingsRateBps },
      })),
      total: { month: "Total", income, expense, net: income - expense, rate: rate(income, expense) },
    },
  };
}

function lastOf(month: Month, cap: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const d = `${month.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  return d > cap ? cap : d;
}

// ── sankey ──────────────────────────────────────────────────────────────────

export type SankeyNodeKind = "source" | "hub" | "group" | "category" | "sink";

export interface CashFlowSankey {
  period: ResolvedPeriod;
  params: ReportParams;
  /** Node names are unique (ECharts keys nodes by name). */
  nodes: { name: string; kind: SankeyNodeKind; key: string }[];
  links: { source: string; target: string; value: Milli }[];
  income: Milli;
  /** Σ positive category (or group) spending: what flows out of the hub to spending. */
  spending: Milli;
  /** income − spending when positive. */
  saved: Milli;
  /** spending − income when positive (funded from savings / earlier months). */
  shortfall: Milli;
  table: ReportTable;
}

export const HUB = "Income";
export const SAVED = "Kept";
export const SHORTFALL = "From earlier months";

export async function cashFlowSankeyReport(db: DbLike, params: ReportParams, opts: { maxSources?: number; maxCategoriesPerGroup?: number } = {}): Promise<CashFlowSankey> {
  const period = resolvePeriod(params);
  const s = await reportScope(db, params, period);
  const maxSources = opts.maxSources ?? 5;
  const maxCats = opts.maxCategoriesPerGroup ?? 6;
  const ie = await db.execute<{ payee_id: string | null; label: string; amount: bigint }>(sql`
    SELECT v.payee_id::text AS payee_id, coalesce(max(v.payee_name), max(v.transfer_account_name), 'Other income') AS label, sum(v.amount_milli)::bigint AS amount
    FROM v_transactions_flat v WHERE ${s.income} GROUP BY v.payee_id HAVING sum(v.amount_milli) > 0 ORDER BY 3 DESC`);
  const sp = await db.execute<{ gkey: string; glabel: string; ckey: string; clabel: string; amount: bigint; cats: (string | null)[] | null }>(sql`
    SELECT ${s.groupKey} AS gkey, ${s.groupLabel} AS glabel, ${s.categoryKey} AS ckey, ${s.categoryLabel} AS clabel,
      (-sum(v.amount_milli))::bigint AS amount, array_agg(DISTINCT v.category_id::text) AS cats
    FROM v_transactions_flat v WHERE ${s.spend} GROUP BY 1, 2, 3, 4 HAVING -sum(v.amount_milli) > 0 ORDER BY 5 DESC`);

  const used = new Set<string>();
  const nodes: CashFlowSankey["nodes"] = [];
  const nameFor = (label: string, suffix: string) => {
    let n = label;
    if (used.has(n)) n = `${label} ${suffix}`;
    let i = 2;
    while (used.has(n)) n = `${label} ${suffix} ${i++}`;
    used.add(n);
    return n;
  };
  const add = (label: string, kind: SankeyNodeKind, key: string, suffix: string) => {
    const name = nameFor(label, suffix);
    nodes.push({ name, kind, key });
    return name;
  };
  const links: CashFlowSankey["links"] = [];
  const hub = add(HUB, "hub", "hub", "");

  // sources
  let income = 0n;
  const srcRows = ie.rows.map((r) => ({ key: r.payee_id ? `payee:${r.payee_id}` : "payee:none", label: r.label, amount: BigInt(r.amount) }));
  srcRows.forEach((r) => (income += r.amount));
  const topSrc = srcRows.length > maxSources + 1 ? srcRows.slice(0, maxSources) : srcRows;
  for (const r of topSrc) links.push({ source: add(r.label, "source", r.key, "(income)"), target: hub, value: r.amount });
  if (topSrc.length < srcRows.length) {
    links.push({ source: add("Other income", "source", "other-income", "(income)"), target: hub, value: srcRows.slice(topSrc.length).reduce((t, r) => t + r.amount, 0n) });
  }

  // groups → categories
  const groups = new Map<string, { label: string; amount: Milli; cats: { key: string; label: string; amount: Milli }[] }>();
  for (const r of sp.rows) {
    const g = groups.get(r.gkey) ?? { label: r.glabel, amount: 0n, cats: [] };
    g.amount += BigInt(r.amount);
    g.cats.push({ key: r.ckey, label: r.clabel, amount: BigInt(r.amount) });
    groups.set(r.gkey, g);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => (b[1].amount > a[1].amount ? 1 : b[1].amount < a[1].amount ? -1 : 0));
  let spending = 0n;
  const tableRows: ReportTable["rows"] = [];
  for (const [gkey, g] of sortedGroups) {
    spending += g.amount;
    const gname = add(g.label, "group", gkey, "(group)");
    links.push({ source: hub, target: gname, value: g.amount });
    if (params.level === "group") {
      tableRows.push({ key: gkey, drill: drillForKey(gkey, sp.rows.filter((r) => r.gkey === gkey).flatMap((r) => r.cats ?? [])), cells: { flow: g.label, from: HUB, amount: g.amount, share: 0 } });
      continue;
    }
    const cats = g.cats.sort((a, b) => (b.amount > a.amount ? 1 : -1));
    const top = cats.length > maxCats + 1 ? cats.slice(0, maxCats) : cats;
    for (const c of top) {
      const isSelf = c.key === gkey; // uncategorized is its own group
      if (isSelf && cats.length === 1) {
        tableRows.push({ key: c.key, drill: drillForKey(c.key, null), cells: { flow: c.label, from: g.label, amount: c.amount, share: 0 } });
        continue;
      }
      links.push({ source: gname, target: add(c.label, "category", c.key, "(category)"), value: c.amount });
      tableRows.push({ key: c.key, drill: drillForKey(c.key, null), cells: { flow: c.label, from: g.label, amount: c.amount, share: 0 } });
    }
    if (top.length < cats.length) {
      const rest = cats.slice(top.length);
      const amt = rest.reduce((t, c) => t + c.amount, 0n);
      links.push({ source: gname, target: add(`Other ${g.label}`, "category", `${gkey}:other`, "(category)"), value: amt });
      for (const c of rest) tableRows.push({ key: c.key, drill: drillForKey(c.key, null), cells: { flow: c.label, from: g.label, amount: c.amount, share: 0 } });
    }
  }
  const saved = income > spending ? income - spending : 0n;
  const shortfall = spending > income ? spending - income : 0n;
  if (saved > 0n) links.push({ source: hub, target: add(SAVED, "sink", "saved", "(saved)"), value: saved });
  if (shortfall > 0n) links.push({ source: add(SHORTFALL, "source", "shortfall", "(funds)"), target: hub, value: shortfall });
  for (const r of tableRows) r.cells.share = bps(r.cells.amount as Milli, spending);
  tableRows.sort((a, b) => ((b.cells.amount as Milli) > (a.cells.amount as Milli) ? 1 : (b.cells.amount as Milli) < (a.cells.amount as Milli) ? -1 : 0));
  return {
    period,
    params,
    nodes,
    links,
    income,
    spending,
    saved,
    shortfall,
    table: {
      columns: [
        { key: "flow", label: params.level === "group" ? "Group" : "Category", kind: "text" },
        { key: "from", label: params.level === "group" ? "From" : "Group", kind: "text", secondary: true },
        { key: "share", label: "Share", kind: "bps" },
        { key: "amount", label: "Amount", kind: "money" },
      ],
      rows: [
        ...srcRows.map((r) => ({ key: r.key, drill: r.key !== "payee:none" ? { payeeIds: [r.key.slice(6)] } : {}, cells: { flow: r.label, from: "Income source", share: bps(r.amount, income), amount: r.amount } })),
        ...tableRows,
      ],
      total: { flow: saved > 0n ? "Kept" : "From earlier months", from: null, share: null, amount: saved > 0n ? saved : shortfall },
    },
  };
}
