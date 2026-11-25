"use client";
import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { cx } from "@/lib/cx";
import type { SyncStatus } from "@/server/queries/sync";
import { syncNowAction } from "@/server/actions/accounts";
import { useToast } from "@/components/ui/Toast";

/** "Sync now" (separate from pull-to-refresh): enqueues a manual SimpleFIN sync, capped at 2 a day. */
export function SyncNowButton({ status, className }: { status: SyncStatus; className?: string }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const disabled = !status.available || !!status.reason || pending;
  const left = Math.max(2 - status.manualUsed, 0);
  return (
    <button
      type="button"
      disabled={disabled}
      title={status.reason ?? `${left} manual ${left === 1 ? "sync" : "syncs"} left today`}
      aria-label={status.reason ? `Sync now unavailable: ${status.reason}` : `Sync now, ${left} left today`}
      onClick={() =>
        start(async () => {
          const r = await syncNowAction();
          toast.show(r.ok ? { message: "Sync started. New transactions land in Review in a minute or two." } : { message: r.error, tone: "error" });
        })
      }
      className={cx(
        "inline-flex min-h-11 items-center gap-1.5 rounded-sm px-2.5 text-[13px] text-ink-2 hover:bg-paper-sunken hover:text-ink disabled:opacity-45 disabled:hover:bg-transparent",
        className,
      )}
    >
      <RefreshCw size={15} strokeWidth={1.75} aria-hidden className={cx(pending || status.queued ? "animate-spin" : "")} />
      <span className="hidden sm:inline">{status.queued ? "Syncing…" : "Sync now"}</span>
    </button>
  );
}
