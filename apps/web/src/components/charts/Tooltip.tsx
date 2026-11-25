"use client";
import { fmtDollars } from "./util";

interface Item {
  name?: string | number;
  value?: number | string | (number | string)[];
  color?: string;
  dataKey?: string | number;
  payload?: { fill?: string };
}

/** Square, hairline tooltip used by every Recharts wrapper. */
export function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
}: {
  active?: boolean;
  payload?: readonly Item[];
  label?: string | number;
  labelFormatter?: (l: string) => string;
  /** Number → text (default: dollars). */
  valueFormatter?: (n: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-[160px] border border-rule-strong bg-paper-raised px-3 py-2 text-[12px] text-ink">
      {label !== undefined && label !== "" && <div className="mb-1 text-ink-3">{labelFormatter ? labelFormatter(String(label)) : label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 shrink-0" style={{ background: p.color ?? p.payload?.fill }} />
            <span className="truncate">{p.name}</span>
          </span>
          <span className="num">{typeof p.value === "number" ? (valueFormatter ?? fmtDollars)(p.value) : String(p.value)}</span>
        </div>
      ))}
    </div>
  );
}
