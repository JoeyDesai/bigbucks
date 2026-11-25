import { cx } from "@/lib/cx";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";

function Figure({ label, value, big }: { label: string; value: bigint; big?: boolean }) {
  return (
    <div className="min-w-0">
      <Money value={value} tone={value < 0n ? "neg" : value > 0n ? "pos" : "zero"} display className={cx("block leading-tight", big ? "text-[22px]" : "text-[18px]")} />
      <div className="mt-0.5 text-[12.5px] font-semibold text-ink-3">{label}</div>
    </div>
  );
}

/** YNAB's balance strip: Cleared Balance + Uncleared Balance = Working Balance. */
export function BalanceStrip({ cleared, uncleared, working, className }: { cleared: bigint; uncleared: bigint; working: bigint; className?: string }) {
  return (
    <>
      <div className={cx("sm:hidden", className)}>
        <div className="flex items-center gap-1">
          <Money value={working} tone={working < 0n ? "neg" : working > 0n ? "pos" : "zero"} display className="text-[28px] leading-tight" />
        </div>
        <div className="text-[13px] font-semibold text-ink-3">Working Balance</div>
        <div className="mt-1.5 flex gap-4 text-[13px] text-ink-2">
          <span>
            Cleared <Money value={cleared} className="font-semibold" />
          </span>
          <span>
            Uncleared <Money value={uncleared} className="font-semibold" />
          </span>
        </div>
      </div>
      <BalanceStripWide cleared={cleared} uncleared={uncleared} working={working} className={cx("hidden sm:flex", className)} />
    </>
  );
}

function BalanceStripWide({ cleared, uncleared, working, className }: { cleared: bigint; uncleared: bigint; working: bigint; className?: string }) {
  return (
    <div className={cx("flex items-start gap-3 sm:gap-5", className)}>
      <Figure label="Cleared Balance" value={cleared} />
      <span aria-hidden className="pt-1 text-[20px] font-light text-ink-3">+</span>
      <Figure label="Uncleared Balance" value={uncleared} />
      <span aria-hidden className="pt-1 text-[20px] font-light text-ink-3">=</span>
      <div className="flex items-start gap-1">
        <Figure label="Working Balance" value={working} big />
        <InfoTip label="What do these balances mean?" align="end" className="mt-1">
          Cleared is what your bank has posted. Uncleared is what you&rsquo;ve entered or synced that hasn&rsquo;t posted yet. Working is both together: the money you really have to plan with.
        </InfoTip>
      </div>
    </div>
  );
}
