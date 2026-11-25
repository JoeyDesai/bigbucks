"use client";
import { ChevronDown } from "lucide-react";
import { cx } from "@/lib/cx";
import { Money } from "@/components/ui/Money";
import { BUDGET_GRID } from "./columns";

export interface GroupHeaderProps {
  name: string;
  assigned: bigint;
  activity: bigint;
  available: bigint;
  collapsed: boolean;
  onToggle: () => void;
  /** id of the region this header controls. */
  controls: string;
  count?: number;
  /** Credit Card Payments: the Available column reads "PAYMENT" (YNAB). */
  payment?: boolean;
}

/** Gray, collapsible category-group row with column totals (YNAB). */
export function GroupHeader({ name, assigned, activity, available, collapsed, onToggle, controls, count, payment }: GroupHeaderProps) {
  return (
    <div className={cx(BUDGET_GRID, "sticky top-0 z-10 min-h-10 border-b border-rule bg-group pl-2 pr-4 lg:top-0 lg:pl-3 lg:pr-3")}>
      <span className="hidden lg:block" />
      <h3 className="min-w-0">
        <button type="button" aria-expanded={!collapsed} aria-controls={controls} onClick={onToggle} className="flex min-h-10 w-full items-center gap-1.5 rounded-md text-left lg:-ml-1">
          <ChevronDown size={16} strokeWidth={2.4} aria-hidden className={cx("shrink-0 text-ink-2 transition-transform duration-200", collapsed && "-rotate-90")} />
          <span className="truncate text-[14px] font-bold text-ink">{name}</span>
          {collapsed && count !== undefined && <span className="num text-[12px] font-medium text-ink-3">{count}</span>}
        </button>
      </h3>
      <Money value={assigned} className="hidden text-right text-[13.5px] font-semibold text-ink-2 lg:block" />
      <Money value={activity} className="hidden text-right text-[13.5px] font-semibold text-ink-2 lg:block" />
      <span className="flex items-center justify-end gap-2 pr-1">
        {payment && <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-ink-3">Payment</span>}
        <Money value={available} tone={available < 0n ? "neg" : "inherit"} className="text-right text-[13.5px] font-semibold text-ink-2" />
      </span>
    </div>
  );
}

/** Column labels shown once above the groups (uppercase, small, gray). */
export function BudgetColumnHeader({ className }: { className?: string }) {
  return (
    <div className={cx(BUDGET_GRID, "border-b border-rule bg-paper py-2 pl-4 pr-4 lg:pl-3 lg:pr-3", className)} aria-hidden>
      <span className="hidden lg:block" />
      <span className="eyebrow">Category</span>
      <span className="eyebrow hidden text-right lg:block">Assigned</span>
      <span className="eyebrow hidden text-right lg:block">Activity</span>
      <span className="eyebrow pr-1 text-right">Available</span>
    </div>
  );
}
