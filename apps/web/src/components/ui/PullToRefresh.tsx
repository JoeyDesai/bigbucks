"use client";
import { useRef, useState, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import { cx } from "@/lib/cx";
import { Spinner } from "./Button";

export interface PullToRefreshProps {
  /** Recompute from the DB (e.g. router.refresh()). Never triggers a bank sync (spec §12). */
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
  /** Pull distance (px) that arms the refresh. */
  threshold?: number;
}

/** Touch pull-to-refresh at the top of the page. Desktop users get no gesture (use the browser). */
export function PullToRefresh({ onRefresh, children, threshold = 72 }: PullToRefreshProps) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const [touching, setTouching] = useState(false);
  const startY = useRef<number | null>(null);

  const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;

  return (
    <div
      onTouchStart={(e) => {
        if (busy || !atTop()) return;
        startY.current = e.touches[0]!.clientY;
        setTouching(true);
      }}
      onTouchMove={(e) => {
        if (startY.current === null) return;
        const dy = e.touches[0]!.clientY - startY.current;
        if (dy <= 0) {
          setPull(0);
          return;
        }
        setPull(Math.min(threshold * 1.6, dy * 0.5));
      }}
      onTouchEnd={async () => {
        const armed = pull >= threshold;
        startY.current = null;
        setTouching(false);
        if (!armed) {
          setPull(0);
          return;
        }
        setBusy(true);
        setPull(threshold * 0.7);
        try {
          await onRefresh();
        } finally {
          setBusy(false);
          setPull(0);
        }
      }}
    >
      <div
        aria-hidden={!busy}
        className="flex items-end justify-center overflow-hidden text-[12px] text-ink-3"
        style={{ height: pull, transition: !touching ? "height 220ms var(--ease-out-quart)" : "none" }}
      >
        <span className="mb-2 flex items-center gap-2" role={busy ? "status" : undefined}>
          {busy ? (
            <>
              <Spinner size={12} /> Recomputing…
            </>
          ) : (
            <>
              <ArrowDown size={14} strokeWidth={1.75} className={cx("transition-transform", pull >= threshold && "rotate-180")} />
              {pull >= threshold ? "Release to recompute" : "Pull to recompute"}
            </>
          )}
        </span>
      </div>
      {children}
    </div>
  );
}
