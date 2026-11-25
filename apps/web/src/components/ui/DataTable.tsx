"use client";
import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "@/lib/cx";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Numeric columns are right-aligned with tabular numerals. */
  numeric?: boolean;
  /** CSS width (e.g. "120px", "30%"). */
  width?: string;
  /** Hide below the lg breakpoint. */
  desktopOnly?: boolean;
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption?: string;
  onRowClick?: (row: T) => void;
  /** Max height before the body scrolls (header stays sticky). */
  maxHeight?: number | string;
  empty?: ReactNode;
  className?: string;
  dense?: boolean;
}

/** Hairline table: sticky header, numeric columns right-aligned, keyboard-activatable rows. */
export function DataTable<T>({ columns, rows, rowKey, caption, onRowClick, maxHeight, empty, className, dense }: DataTableProps<T>) {
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (onRowClick && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onRowClick(row);
    }
  };
  return (
    <div className={cx("overflow-auto border-y border-rule", className)} style={{ maxHeight }}>
      <table className="w-full border-collapse text-[14px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={{ width: c.width }}
                className={cx(
                  "eyebrow sticky top-0 z-[1] border-b border-rule bg-paper px-3 py-2.5 font-semibold first:pl-0 last:pr-0",
                  c.numeric ? "text-right" : "text-left",
                  c.desktopOnly && "hidden lg:table-cell",
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="py-8 text-center text-ink-3">
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => onKey(e, r) : undefined}
              className={cx("border-b border-rule last:border-b-0", onRowClick && "cursor-pointer hover:bg-paper-hover focus-visible:bg-accent-soft")}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cx(
                    "px-3 first:pl-0 last:pr-0",
                    dense ? "py-2" : "py-3",
                    c.numeric ? "num whitespace-nowrap text-right" : "text-left",
                    c.desktopOnly && "hidden lg:table-cell",
                  )}
                >
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
