"use client";
import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addMonths, formatMonth, type Month } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { isTypingTarget } from "./ShortcutSheet";

const BTN = "inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-paper-hover hover:text-ink aria-disabled:pointer-events-none aria-disabled:opacity-25";

/** ‹ October 2026 › with history-routed links; ← / → switch months when nothing is focused for typing. */
export function MonthNav({ month, hrefFor, currentMonth, min, max, className }: { month: Month; hrefFor: (m: Month) => string; currentMonth: Month; min?: Month | null; max?: Month | null; className?: string }) {
  const router = useRouter();
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const prevOff = !!min && prev < min;
  const nextOff = !!max && next > max;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || document.querySelector('[role="dialog"]')) return;
      if (e.key === "ArrowLeft" && !prevOff) router.push(hrefFor(prev), { scroll: false });
      if (e.key === "ArrowRight" && !nextOff) router.push(hrefFor(next), { scroll: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, prev, next, prevOff, nextOff, hrefFor]);
  return (
    <div className={cx("flex items-center gap-1", className)} role="group" aria-label="Month">
      <Link href={hrefFor(prev)} scroll={false} aria-label={`Previous month, ${formatMonth(prev)}`} aria-disabled={prevOff || undefined} className={BTN}>
        <ChevronLeft size={18} strokeWidth={2} />
      </Link>
      <span className="min-w-[132px] text-center text-[15px] font-semibold tracking-[-0.01em] text-ink" aria-live="polite">
        {formatMonth(month)}
      </span>
      <Link href={hrefFor(next)} scroll={false} aria-label={`Next month, ${formatMonth(next)}`} aria-disabled={nextOff || undefined} className={BTN}>
        <ChevronRight size={18} strokeWidth={2} />
      </Link>
      {month !== currentMonth && (
        <Link href={hrefFor(currentMonth)} scroll={false} className="ml-1 rounded-full px-3 py-1 text-[12.5px] font-semibold text-accent hover:bg-accent-soft">
          Today
        </Link>
      )}
    </div>
  );
}
