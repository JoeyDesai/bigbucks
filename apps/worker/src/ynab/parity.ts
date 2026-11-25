/**
 * §6.9/§10 parity after an import: the budget computed from the *database* (what Homebase will show)
 * vs YNAB's own month figures in the export (to_be_budgeted; budgeted/activity/balance per category).
 * The engine-only golden test (`pnpm --filter @homebase/engine golden`) checks the engine against the
 * same file without the DB round trip.
 */
import { isNotNull } from "drizzle-orm";
import { categories, type Db } from "@homebase/db";
import { computeBudget, ynabPlanToSnapshot, type BudgetOptions } from "@homebase/engine";
import { formatMilli, type Milli, type Month } from "@homebase/shared";
import { loadBudgetSnapshot } from "../budget";

export interface ParityRow {
  month: Month;
  category: string;
  field: "to_be_budgeted" | "assigned" | "activity" | "available" | "missing";
  ynab: Milli;
  homebase: Milli | null;
}

export interface ParityReport {
  rows: ParityRow[];
  checked: number;
  months: Month[];
}

export async function ynabParity(db: Db, raw: unknown, o: { budget?: Partial<BudgetOptions> } = {}): Promise<ParityReport> {
  const mapped = ynabPlanToSnapshot(raw);
  if (!mapped.lastMonth) return { rows: [], checked: 0, months: [] };
  const snap = await loadBudgetSnapshot(db);
  const result = computeBudget(snap, { ...o.budget, through: mapped.lastMonth });
  const catRows = await db.select({ id: categories.id, ynabId: categories.ynabId, kind: categories.kind, name: categories.name }).from(categories).where(isNotNull(categories.ynabId));
  const byYnab = new Map(catRows.map((c) => [c.ynabId!, c]));
  const rows: ParityRow[] = [];
  let checked = 0;
  for (const exp of mapped.expected) {
    const mr = result.months[exp.month];
    checked++;
    if (!mr) {
      rows.push({ month: exp.month, category: "(month)", field: "missing", ynab: exp.toBeBudgeted, homebase: null });
      continue;
    }
    if (mr.readyToAssignDisplay !== exp.toBeBudgeted) rows.push({ month: exp.month, category: "Ready to Assign", field: "to_be_budgeted", ynab: exp.toBeBudgeted, homebase: mr.readyToAssignDisplay });
    for (const [ynabId, y] of Object.entries(exp.categories)) {
      const c = byYnab.get(ynabId);
      if (c?.kind === "internal_rta") continue;
      checked++;
      const e = c ? mr.categories[c.id] : undefined;
      const name = c?.name ?? mapped.categoryNames[ynabId] ?? ynabId;
      if (!e) {
        if (y.budgeted !== 0n || y.activity !== 0n || y.balance !== 0n) rows.push({ month: exp.month, category: name, field: "missing", ynab: y.balance, homebase: null });
        continue;
      }
      if (e.assigned !== y.budgeted) rows.push({ month: exp.month, category: name, field: "assigned", ynab: y.budgeted, homebase: e.assigned });
      if (e.activity !== y.activity) rows.push({ month: exp.month, category: name, field: "activity", ynab: y.activity, homebase: e.activity });
      if (e.available !== y.balance) rows.push({ month: exp.month, category: name, field: "available", ynab: y.balance, homebase: e.available });
    }
  }
  return { rows, checked, months: mapped.expected.map((e) => e.month) };
}

export function formatParity(r: ParityReport, limit = 40): string {
  if (!r.rows.length) return `parity: Homebase matches YNAB exactly (${r.checked} figures across ${r.months.length} months)`;
  const fmt = (m: Milli | null) => (m === null ? "—" : formatMilli(m));
  const lines = r.rows.slice(0, limit).map((x) => `  ${x.month.slice(0, 7)}  ${x.category.slice(0, 36).padEnd(36)}  ${x.field.padEnd(15)}  YNAB ${fmt(x.ynab).padStart(12)}  Homebase ${fmt(x.homebase).padStart(12)}`);
  const more = r.rows.length > limit ? `\n  … ${r.rows.length - limit} more` : "";
  return `parity: ${r.rows.length} difference(s) in ${r.checked} figures; first in ${r.rows[0]!.month.slice(0, 7)}\n${lines.join("\n")}${more}`;
}
