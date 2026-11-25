"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { Cell, CellKind, ReportTable, TableColumn } from "@homebase/core";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { moneyToneClass } from "@/components/ui/Money";
import { bpsLabel, dayLabel, monthLabel } from "./url";

export function formatCell(v: Cell, kind: CellKind): string {
  if (v === null || v === undefined) return "—";
  switch (kind) {
    case "money":
      return typeof v === "bigint" ? formatMilli(v) : String(v);
    case "bps":
      return typeof v === "number" ? bpsLabel(v) : String(v);
    case "count":
      return typeof v === "number" ? v.toLocaleString("en-US") : String(v);
    case "days":
      return typeof v === "number" ? (Math.abs(v) === 1 ? `${v} day` : `${v} days`) : String(v);
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? dayLabel(v, false) : String(v);
    case "month":
      return typeof v === "string" && /^\d{4}-\d{2}-01$/.test(v) ? `${monthLabel(v).slice(0, 3)} ’${v.slice(2, 4)}` : String(v);
    default:
      return String(v);
  }
}

type Row = { key: string; cells: Record<string, Cell>; href?: string; total?: boolean };

export interface ReportTableViewProps {
  table: ReportTable;
  /** Drill-down links by row key (computed on the server with core `drillDown`). */
  hrefs?: Record<string, string>;
  caption: string;
  /** Color squares before the first cell (chart legend), by row key. */
  swatches?: Record<string, string>;
}

/** A report's table: hairline rows, secondary columns hidden on phones, rows link to Activity. */
export function ReportTableView({ table, hrefs = {}, caption, swatches }: ReportTableViewProps) {
  const router = useRouter();
  const cols = table.columns.filter((c) => !c.csvOnly);
  const rows: Row[] = table.rows.map((r) => ({ key: r.key, cells: r.cells, href: hrefs[r.key] }));
  if (table.total) rows.push({ key: "__total", cells: table.total, total: true });
  const first = cols[0]?.key;
  const columns: Column<Row>[] = cols.map((c: TableColumn, i) => ({
    key: c.key,
    header: c.label,
    numeric: c.kind !== "text" && !(i === 0 && (c.kind === "month" || c.kind === "date")),
    desktopOnly: c.secondary,
    render: (r) => {
      const v = r.cells[c.key] ?? null;
      const text = c.kind === "days" && c.key === "change" && typeof v === "number" && v > 0 ? `+${formatCell(v, c.kind)}` : formatCell(v, c.kind);
      const tone = c.kind === "money" && c.signed && typeof v === "bigint" ? moneyToneClass(v, "signed") : c.kind === "days" && c.key === "change" && typeof v === "number" ? (v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-3") : undefined;
      const sw = c.key === first && swatches?.[r.key] ? <span aria-hidden className="mr-2 inline-block h-2.5 w-2.5 shrink-0" style={{ background: swatches[r.key] }} /> : null;
      if (c.key === first && r.href) {
        return (
          <Link href={r.href} onClick={(e) => e.stopPropagation()} className="group inline-flex min-h-6 max-w-full items-center gap-1 text-ink hover:underline hover:decoration-1 hover:underline-offset-4">
            {sw}
            <span className="truncate">{text}</span>
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </Link>
        );
      }
      return (
        <span className={cx(r.total && "font-semibold", tone, v === null && "text-ink-3", c.key === first && "block truncate")}>
          {sw}
          {text}
        </span>
      );
    },
  }));
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      caption={caption}
      dense
      className={cx("[&_td:first-child]:max-w-[46vw] lg:[&_td:first-child]:max-w-none [&_td]:px-2 [&_th]:px-2 lg:[&_td]:px-3 lg:[&_th]:px-3", table.total && "[&_tbody_tr:last-child]:border-t [&_tbody_tr:last-child]:border-rule-strong")}
      onRowClick={(r) => r.href && router.push(r.href)}
      empty="Nothing in this period."
    />
  );
}
