"use client";
import { useOptimistic, useTransition } from "react";
import { Pin, PinOff } from "lucide-react";
import { pinSavedReportAction } from "@/app/(app)/reports/actions";
import { cx } from "@/lib/cx";

/** Pin / unpin a saved report (pinned ones sit at the top of Reports). */
export function PinButton({ id, pinned, name, withLabel }: { id: string; pinned: boolean; name: string; withLabel?: boolean }) {
  const [, start] = useTransition();
  const [on, setOn] = useOptimistic(pinned);
  const label = on ? `Unpin ${name}` : `Pin ${name} to the top of Reports`;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() =>
        start(async () => {
          setOn(!on);
          await pinSavedReportAction(id, !on);
        })
      }
      className={cx(
        "inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-sm text-[13px] font-medium transition-colors hover:bg-paper-sunken",
        withLabel ? "px-3" : "w-11",
        on ? "text-ink" : "text-ink-3 hover:text-ink",
      )}
    >
      {on ? <PinOff size={16} strokeWidth={1.75} aria-hidden /> : <Pin size={16} strokeWidth={1.75} aria-hidden />}
      {withLabel && (on ? "Unpin" : "Pin")}
    </button>
  );
}
