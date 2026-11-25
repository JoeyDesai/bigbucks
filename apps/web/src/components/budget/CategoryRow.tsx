"use client";
import { memo, type MouseEvent } from "react";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { targetProgress } from "@/lib/budget-display";
import { categoryLabel } from "@/lib/category-icons";
import type { CategoryVM } from "@/lib/view-models";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { AmountInput } from "@/components/ui/AmountInput";
import { Money } from "@/components/ui/Money";
import { AvailablePill } from "./AvailablePill";
import { TARGET_TEXT, TargetBar } from "./TargetBar";
import { BUDGET_GRID } from "./columns";

export interface CategoryRowProps {
  category: CategoryVM;
  /** Commit a new Assigned amount (optimistic; caller shows Undo toast). */
  onAssign?: (categoryId: string, next: bigint) => void;
  /** Select the category (inspector on desktop, bottom sheet on phones). */
  onOpen?: (categoryId: string) => void;
  selected?: boolean;
  /** Compact rows (desktop density toggle). */
  compact?: boolean;
}

/** Kept for older callers: the Available pill. */
export { AvailablePill as AvailableAmount } from "./AvailablePill";

/** Status text shown with the bar, or the plain-language state when there's no target. */
function statusText(c: CategoryVM): { text: string; className: string } | null {
  const p = targetProgress(c);
  if (p) return { text: p.label, className: TARGET_TEXT[p.tone] };
  if (c.available < 0n && c.statusLabel) return { text: c.statusLabel, className: c.pill === "red" ? "text-neg" : "text-warn" };
  if (c.kind === "cc_payment") return { text: c.suggestedPayment && c.suggestedPayment > 0n ? `Pay ${formatMilli(c.suggestedPayment)}` : "Payment", className: "text-ink-3" };
  return null;
}

/**
 * YNAB budget row. Desktop: checkbox · icon + name (status text right, thin target bar under) · Assigned
 * (editable) · Activity · Available pill. Phone: icon + name with bar/status under, Available pill right;
 * tapping opens the category sheet (where Assigned is edited).
 */
export const CategoryRow = memo(function CategoryRow({ category: c, onAssign, onOpen, selected, compact }: CategoryRowProps) {
  const progress = targetProgress(c);
  const status = statusText(c);
  const label = categoryLabel(c.name);
  const select = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,input,a")) return;
    onOpen?.(c.id);
  };
  return (
    <div
      className={cx(
        BUDGET_GRID,
        "group/row border-b border-rule pl-4 pr-4 transition-colors lg:pl-3 lg:pr-3",
        compact ? "min-h-[44px] py-1" : "min-h-[56px] py-1.5 lg:min-h-[52px]",
        selected ? "bg-accent-soft" : "hover:bg-paper-hover",
      )}
      data-category-id={c.id}
      data-selected={selected || undefined}
      onClick={select}
    >
      <span className="hidden lg:flex">
        <input type="checkbox" checked={!!selected} onChange={() => onOpen?.(c.id)} aria-label={`Select ${label}`} className="h-4 w-4 rounded-sm" />
      </span>
      <button type="button" onClick={() => onOpen?.(c.id)} className="w-full min-w-0 rounded-md py-1 text-left outline-offset-0" aria-label={`${label} details`}>
        <span className="flex min-w-0 items-center gap-2">
          <CategoryIcon icon={c.icon} name={c.name} size={17} />
          <span className={cx("min-w-0 flex-1 truncate text-[15px] leading-snug text-ink lg:max-w-[58%] lg:flex-none lg:shrink-0", selected && "font-semibold")}>{label}</span>
          {status && <span className={cx("hidden min-w-0 flex-1 truncate text-right text-[11.5px] lg:block", status.className)}>{status.text}</span>}
        </span>
        {progress && !compact ? (
          <span className="mt-1.5 flex items-center gap-2 pl-[25px]">
            <TargetBar progress={progress} className="flex-1" />
            {status && <span className={cx("max-w-[52%] shrink-0 truncate text-[11.5px] lg:hidden", status.className)}>{status.text}</span>}
          </span>
        ) : status && !progress ? (
          <span className={cx("mt-0.5 block truncate pl-[25px] text-[11.5px] lg:hidden", status.className)}>{status.text}</span>
        ) : null}
      </button>
      <div className="hidden justify-end lg:flex">
        {onAssign ? (
          <AmountInput value={c.assigned} label={`Assigned to ${label}`} onCommit={(v) => onAssign(c.id, v)} size="sm" className="w-full max-w-[128px] text-[14px]" />
        ) : (
          <Money value={c.assigned} className="text-ink-2" />
        )}
      </div>
      <div className="hidden justify-end text-[14px] lg:flex">
        <Money value={c.activity} tone={c.activity === 0n ? "zero" : "ink"} className="text-ink-2" />
      </div>
      <div className="flex justify-end">
        <AvailablePill category={c} />
      </div>
    </div>
  );
});
