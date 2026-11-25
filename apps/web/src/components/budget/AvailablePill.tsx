"use client";
import { CircleCheck, CreditCard } from "lucide-react";
import { cx } from "@/lib/cx";
import { STATE_LABEL, availablePill, availableState } from "@/lib/budget-display";
import type { CategoryVM } from "@/lib/view-models";
import { Money } from "@/components/ui/Money";

/**
 * YNAB's Available pill: green (check-circle when the target is met), gray at zero, yellow with a card
 * icon for credit overspending, red for cash overspending. `size="lg"` for the inspector / sheet.
 */
export function AvailablePill({ category, className, size = "md" }: { category: CategoryVM; className?: string; size?: "md" | "lg" }) {
  const look = availablePill(category);
  const state = availableState(category);
  const icon = size === "lg" ? 17 : 14;
  return (
    <span className={cx("pill", size === "lg" ? "min-h-8 px-3 text-[18px]" : "text-[13.5px]", className)} data-tone={look.tone} title={STATE_LABEL[state]}>
      {look.icon === "check" && <CircleCheck size={icon} strokeWidth={2.4} aria-hidden />}
      {look.icon === "card" && <CreditCard size={icon} strokeWidth={2.2} aria-hidden />}
      <Money value={category.available} tone="inherit" animate label={`Available, ${STATE_LABEL[state]},`} />
    </span>
  );
}

/** A plain money pill (group totals, balances): green > 0, gray 0, red < 0. */
export function MoneyPill({ value, className, label }: { value: bigint; className?: string; label?: string }) {
  return (
    <span className={cx("pill text-[13.5px]", className)} data-tone={value > 0n ? "pos" : value < 0n ? "neg" : "zero"}>
      <Money value={value} tone="inherit" label={label} />
    </span>
  );
}
