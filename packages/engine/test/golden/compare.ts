/**
 * §6.9 parity comparison: engine output vs YNAB's own month figures, with a readable diff table.
 */
import { formatMilli, monthOf } from "@homebase/shared";
import { computeBudget } from "../../src/budget";
import type { BudgetOptions, BudgetResult, Milli, Month } from "../../src/types";
import type { YnabMapResult } from "./ynabToSnapshot";

export interface DiffRow {
  month: Month;
  categoryId: string;
  name: string;
  /** Category kind ("" for month-level rows). */
  kind?: string;
  field: "assigned" | "activity" | "available" | "to_be_budgeted" | "goal_under_funded" | "missing";
  ynab: Milli | null;
  engine: Milli | null;
}

export interface GoldenReport {
  result: BudgetResult;
  rows: DiffRow[];
  checked: number;
  /** Month whose goal_under_funded values were compared (null = none). */
  goalMonth: Month | null;
}

export interface GoldenOptions {
  budget?: Partial<BudgetOptions>;
  /** Month for goal_under_funded parity (targets are only valid for the snapshot month). */
  goalMonth?: Month | null;
}

export function runGolden(mapped: YnabMapResult, opts: GoldenOptions = {}): GoldenReport {
  const through = mapped.lastMonth ?? opts.budget?.through;
  if (!through) throw new Error("fixture has no months");
  const result = computeBudget(mapped.snapshot, { ...opts.budget, through });
  const kinds = new Map(mapped.snapshot.categories.map((c) => [c.id, c.kind]));
  const rows: DiffRow[] = [];
  let checked = 0;
  const goalMonth = opts.goalMonth === undefined ? null : opts.goalMonth;
  const name = (id: string) => mapped.categoryNames[id] ?? id;
  for (const exp of mapped.expected) {
    const mr = result.months[exp.month];
    checked++;
    if (!mr) {
      rows.push({ month: exp.month, categoryId: "", name: "(month)", field: "missing", ynab: exp.toBeBudgeted, engine: null });
      continue;
    }
    // YNAB's month `to_be_budgeted` is the raw per-month figure (verified, ADR-E7), not the
    // future-adjusted number the Plan banner shows.
    if (mr.rta !== exp.toBeBudgeted) rows.push({ month: exp.month, categoryId: "", name: "Ready to Assign", field: "to_be_budgeted", ynab: exp.toBeBudgeted, engine: mr.rta });
    for (const [id, y] of Object.entries(exp.categories)) {
      if (kinds.get(id) === "internal_rta") continue;
      const e = mr.categories[id];
      checked++;
      if (!e) {
        if (y.budgeted !== 0n || y.activity !== 0n || y.balance !== 0n) rows.push({ month: exp.month, categoryId: id, name: name(id), field: "missing", ynab: y.balance, engine: null });
        continue;
      }
      if (e.assigned !== y.budgeted) rows.push({ month: exp.month, categoryId: id, name: name(id), kind: kinds.get(id), field: "assigned", ynab: y.budgeted, engine: e.assigned });
      if (e.activity !== y.activity) rows.push({ month: exp.month, categoryId: id, name: name(id), kind: kinds.get(id), field: "activity", ynab: y.activity, engine: e.activity });
      if (e.available !== y.balance) rows.push({ month: exp.month, categoryId: id, name: name(id), kind: kinds.get(id), field: "available", ynab: y.balance, engine: e.available });
      if (goalMonth && exp.month === goalMonth && y.goalType && y.goalUnderFunded !== null && e.underfunded !== y.goalUnderFunded)
        rows.push({ month: exp.month, categoryId: id, name: name(id), field: "goal_under_funded", ynab: y.goalUnderFunded, engine: e.underfunded });
    }
  }
  return { result, rows, checked, goalMonth };
}

/**
 * Split diffs into fatal ones and the known open-month residual (ADR-E13): in the plan's open month
 * (the month it was exported in, while transactions are still unapproved and being imported), a
 * net-zero difference between payment categories is reported but not fatal unless `strict`.
 */
export function partitionDiffs(rows: DiffRow[], openMonth: Month | null, strict: boolean): { fatal: DiffRow[]; tolerated: DiffRow[] } {
  if (strict || !openMonth) return { fatal: rows, tolerated: [] };
  const isPay = (r: DiffRow) => r.kind === "cc_payment" && r.month >= openMonth && (r.field === "activity" || r.field === "available");
  const candidates = rows.filter(isPay);
  const others = rows.filter((r) => !isPay(r));
  // tolerate only if, per month and field, the payment-category differences cancel out
  const sums = new Map<string, Milli>();
  for (const r of candidates) sums.set(`${r.month}|${r.field}`, (sums.get(`${r.month}|${r.field}`) ?? 0n) + (r.engine! - r.ynab!));
  const netZero = [...sums.values()].every((v) => v === 0n);
  return netZero ? { fatal: others, tolerated: candidates } : { fatal: rows, tolerated: [] };
}

const fmt = (m: Milli | null) => (m === null ? "—" : formatMilli(m));

/** A fixed-width diff table, earliest month first (the first mismatch usually explains the rest). */
export function formatDiffTable(rows: DiffRow[], limit = 200): string {
  if (rows.length === 0) return "golden parity: no differences";
  const head = ["month", "category", "field", "YNAB", "engine", "Δ (engine − YNAB)"];
  const body = rows.slice(0, limit).map((r) => [r.month.slice(0, 7), r.name.slice(0, 40), r.field, fmt(r.ynab), fmt(r.engine), r.ynab !== null && r.engine !== null ? fmt(r.engine - r.ynab) : "—"]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i >= 3 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join(" │ ");
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
  const byField = new Map<string, number>();
  for (const r of rows) byField.set(r.field, (byField.get(r.field) ?? 0) + 1);
  const summary = `golden parity: ${rows.length} difference(s) — ${[...byField].map(([f, n]) => `${f}: ${n}`).join(", ")}; first in ${rows[0]!.month.slice(0, 7)}`;
  const more = rows.length > limit ? `\n… ${rows.length - limit} more` : "";
  return [summary, line(head), sep, ...body.map(line)].join("\n") + more;
}

/** Month to check goal_under_funded in: env override, else the month the plan was last modified. */
export function goalMonthFor(plan: { last_modified_on?: unknown }, env: string | undefined): Month | null {
  if (env) return monthOf(env);
  return typeof plan.last_modified_on === "string" ? monthOf(plan.last_modified_on.slice(0, 10)) : null;
}
