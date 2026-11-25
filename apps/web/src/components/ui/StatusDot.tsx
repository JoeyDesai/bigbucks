import { cx } from "@/lib/cx";
import type { ConnectionStatus } from "@/lib/view-models";

const COLOR: Record<ConnectionStatus, string> = {
  ok: "bg-pos",
  needs_attention: "bg-warn-bar",
  error: "bg-neg",
  disabled: "bg-zero",
  manual: "bg-rule-strong",
};

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  ok: "Connected",
  needs_attention: "Needs attention",
  error: "Not syncing",
  disabled: "Disabled",
  manual: "Manual",
};

/** Small round status dot for connections (green / yellow / red / gray). */
export function StatusDot({ status, showLabel, className }: { status: ConnectionStatus; showLabel?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden className={cx("inline-block h-2 w-2 shrink-0 rounded-full", COLOR[status])} />
      {showLabel ? (
        <span className={cx("text-[12px]", status === "ok" ? "text-ink-3" : status === "error" ? "text-neg" : status === "needs_attention" ? "text-warn" : "text-ink-3")}>
          {STATUS_LABEL[status]}
        </span>
      ) : (
        <span className="sr-only">{STATUS_LABEL[status]}</span>
      )}
    </span>
  );
}
