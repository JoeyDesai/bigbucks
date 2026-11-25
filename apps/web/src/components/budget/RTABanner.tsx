import type { ReactNode } from "react";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";

export interface RTABannerProps {
  /** Ready to Assign, as of the future-most month with assignments (spec §6.2). */
  amount: bigint;
  /** "Assigned in future months" shown as a footnote when > 0. */
  assignedInFuture?: bigint;
  /** Slot for the Assign menu (Auto-Assign options, §6.6). */
  menu?: ReactNode;
  className?: string;
}

type Key = "pos" | "zero" | "neg";
const STYLE: Record<Key, { bg: string; ink: string; btn: string; note: string }> = {
  pos: { bg: "var(--rta-pos-bg)", ink: "var(--rta-pos-ink)", btn: "var(--rta-pos-btn)", note: "Ready to Assign" },
  zero: { bg: "var(--rta-zero-bg)", ink: "var(--rta-zero-ink)", btn: "var(--rta-zero-btn)", note: "All Money Assigned" },
  neg: { bg: "var(--rta-neg-bg)", ink: "var(--rta-neg-ink)", btn: "var(--rta-neg-btn)", note: "You assigned more than you have" },
};

export const rtaKey = (amount: bigint): Key => (amount > 0n ? "pos" : amount < 0n ? "neg" : "zero");

/** The Assign button inside the block (dark green on green, red on red). */
export const RTA_BUTTON =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--rta-btn)] px-4 text-[15px] font-bold text-white shadow-sm transition-[filter] hover:brightness-110 lg:min-h-10";

/** YNAB's Ready to Assign block: bright green when positive, gray at zero, red when negative, with Assign ▾. */
export function RTABanner({ amount, assignedInFuture, menu, className }: RTABannerProps) {
  const key = rtaKey(amount);
  const s = STYLE[key];
  return (
    <section
      aria-label="Ready to Assign"
      className={cx("flex items-center gap-4 rounded-xl py-2.5 pl-5 pr-3", className)}
      style={{ background: s.bg, color: s.ink, ["--rta-btn" as string]: s.btn }}
    >
      <div className="min-w-0 flex-1">
        <Money value={amount} tone="inherit" display animate className="block text-[26px] leading-[1.1] lg:text-[24px]" />
        <div className="flex items-center gap-1 text-[13px] font-semibold">
          {key === "pos" ? "Ready to Assign" : s.note}
          <InfoTip label="What is Ready to Assign?" size={14}>
            Money you have in your budget accounts that isn&rsquo;t in a category yet. Give every dollar a job by assigning it until this reaches $0.00.
            {key === "neg" && " Below zero means more is assigned than you have: take money back from a category."}
          </InfoTip>
        </div>
        {assignedInFuture && assignedInFuture > 0n ? <p className="text-[11.5px] opacity-80">{formatMilli(assignedInFuture)} assigned in future months</p> : null}
      </div>
      {menu && <div className="shrink-0">{menu}</div>}
    </section>
  );
}
