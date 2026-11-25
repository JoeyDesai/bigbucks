import { cx } from "@/lib/cx";
import type { TargetProgress, Tone } from "@/lib/budget-display";

const FILL: Record<Tone, string> = {
  pos: "bg-pos-bar",
  neg: "bg-neg-bar",
  warn: "bg-warn-bar",
  zero: "bg-ink-3",
  ink: "bg-ink",
  muted: "bg-ink-3",
};

/**
 * YNAB's thin target bar under a category name: the funded share in a light tint, what's been spent
 * solid on top. Overspent shows a full red bar. The status text is rendered by the row.
 */
export function TargetBar({ progress, className }: { progress: TargetProgress; className?: string }) {
  const funded = Math.round(progress.funded * 100);
  const spent = Math.round(progress.spent * 100);
  return (
    <div
      role="meter"
      aria-label="Target progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={funded}
      aria-valuetext={progress.label}
      className={cx("relative h-[5px] w-full overflow-hidden rounded-full bg-track", className)}
    >
      <span className={cx("absolute inset-y-0 left-0 rounded-full opacity-45", FILL[progress.tone])} style={{ width: `${funded}%` }} />
      <span className={cx("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", FILL[progress.tone])} style={{ width: `${spent}%` }} />
    </div>
  );
}

/** Status text color for a target tone. */
export const TARGET_TEXT: Record<Tone, string> = {
  pos: "text-ink-3",
  neg: "text-neg",
  warn: "text-warn",
  zero: "text-ink-3",
  ink: "text-ink",
  muted: "text-ink-3",
};
