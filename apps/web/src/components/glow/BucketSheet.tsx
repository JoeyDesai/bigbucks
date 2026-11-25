"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { IterationCw, Pencil } from "lucide-react";
import { formatMilli, formatMonth, type Month } from "@homebase/shared";
import type { BucketRow } from "@homebase/core";
import { cx } from "@/lib/cx";
import { rowDisplay } from "@/lib/bucket-display";
import type { CategoryChoice, TxItem } from "@/lib/tx";
import { bucketTransactionsAction, setBucketGoalAction, setBucketRolloverAction } from "@/server/actions/glow";
import { undoAction } from "@/server/actions/budget";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { AmountInput } from "@/components/ui/AmountInput";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { BucketBar } from "./BucketBar";
import { BucketEditor } from "./BucketEditor";
import { BucketTxRow } from "./BucketTxRow";
import { GoalInline } from "./GoalInline";
import type { SavingsChangeFn } from "./SavingsCard";
import { SavingsSheetBody } from "./SavingsSheetBody";

/**
 * A bucket's detail (bottom sheet on phones, side panel on desktop): what's left, the bar, the monthly
 * goal editor, the overflow (rollover) switch, and this month's transactions in the bucket. Savings
 * buckets get their own body (balance, Add / Take out, target, starting balance, history).
 */
export function BucketSheet({ row, month, currentMonth, onClose, onSavingsChange, readyToSave }: { row: BucketRow | null; month: Month; currentMonth: Month; onClose: () => void; onSavingsChange?: SavingsChangeFn; readyToSave?: bigint }) {
  const [shown, setShown] = useState<BucketRow | null>(row);
  if (row && row !== shown) setShown(row);
  const r = row ?? shown;
  return (
    <Sheet
      open={!!row}
      onClose={onClose}
      width={460}
      title={
        r ? (
          <span className="flex w-full items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-accent-soft">
              <CategoryIcon icon={r.icon} name={r.name} size={18} tone="accent" />
            </span>
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            <button
              type="button"
              onClick={() => document.getElementById("bucket-edit")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-rule-strong px-3 text-[12.5px] font-medium text-ink-2 hover:border-accent/60 hover:text-ink"
              data-testid="bucket-edit-jump"
            >
              <Pencil size={13} aria-hidden /> Edit
            </button>
          </span>
        ) : (
          ""
        )
      }
    >
      {r && (
        <div className="space-y-6">
          {r.bucketKind === "savings" && r.savings ? <SavingsSheetBody key={`${r.id}-${month}-savings`} r={r} month={month} onChange={onSavingsChange} readyToSave={readyToSave} /> : <Body key={`${r.id}-${month}`} r={r} month={month} currentMonth={currentMonth} />}
          <BucketEditor key={r.id} r={r} onClose={onClose} />
        </div>
      )}
    </Sheet>
  );
}

function Body({ r, month, currentMonth }: { r: BucketRow; month: Month; currentMonth: Month }) {
  const d = rowDisplay(r);
  const [loaded, setLoaded] = useState<{ items: TxItem[]; choices: CategoryChoice[] } | null>(null);
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const txs = loaded && loaded.items.filter((t) => !moved.has(t.id));
  const [pending, start] = useTransition();
  const toast = useToast();
  useEffect(() => {
    let live = true;
    void bucketTransactionsAction(r.id, month).then((x) => {
      if (!live) return;
      setLoaded(x);
      setMoved(new Set());
    });
    return () => {
      live = false;
    };
  }, [r.id, month, r.spent]);
  const simple = !r.goal || r.goal.simple;
  const keepType = r.goal?.simple && (r.goal.type === "need_set_aside" || r.goal.type === "need_refill" || r.goal.type === "monthly_builder") ? r.goal.type : undefined;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-baseline gap-2">
          <span className={cx("num display text-[38px] leading-none", d.tone === "over" ? "text-over" : "text-ink")}>{formatMilli(d.amount)}</span>
          <span className={cx("text-[15px]", d.tone === "over" ? "text-over" : "text-ink-3")}>{d.amountSuffix}</span>
        </div>
        {d.bar.state !== "none" && <BucketBar bar={d.bar} height={12} className="mt-4" label={d.label} />}
        <div className="mt-2 text-[13px] text-ink-3">{d.bar.state === "none" ? `${formatMilli(r.spent > 0n ? r.spent : 0n)} spent this month` : d.detail}</div>
        {d.rollover && (
          <div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-2" data-testid="rollover-note">
            <IterationCw size={13} strokeWidth={2.2} aria-hidden className="text-accent" />
            {d.rollover}
          </div>
        )}
      </div>

      <section aria-label="Goal" className="rounded-[16px] border border-rule bg-paper-sunken/60 p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-[14px] font-semibold text-ink">Monthly goal</h3>
          {r.goal && <span className="text-[12px] text-ink-3">{r.goal.label}</span>}
        </div>
        {!simple && <p className="mb-3 text-[12.5px] text-ink-3">Saving here replaces it with a plain monthly goal from this month on.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <GoalInline categoryId={r.id} name={r.name} month={month} initial={r.goal?.simple ? r.goal.targetAmount : null} inline={false} keepType={keepType} />
          {r.goal && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await setBucketGoalAction({ categoryId: r.id, month, amount: null });
                  if (!res.ok) return void toast.show({ message: res.error, tone: "error" });
                  toast.show({ message: `Removed the goal for ${r.name}`, action: res.operationId ? { label: "Undo", onAction: () => void undoAction(res.operationId!) } : undefined });
                })
              }
              className="h-9 rounded-[10px] px-3 text-[13px] font-medium text-ink-3 hover:bg-paper-hover hover:text-over"
            >
              Remove goal
            </button>
          )}
        </div>
      </section>

      {r.goal?.kind !== "balance" && <Overflow r={r} month={month} currentMonth={currentMonth} />}

      <section aria-label="Transactions this month">
        <h3 className="eyebrow mb-2">This month</h3>
        {txs && txs.length > 0 && <p className="-mt-1 mb-1 text-[12px] text-ink-3">Tap one to move it to another bucket.</p>}
        {txs === null ? (
          <ul className="space-y-2">
            {[0, 1, 2].map((i) => (
              <li key={i} className="skeleton h-12" />
            ))}
          </ul>
        ) : txs.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-ink-3">Nothing in this bucket yet this month.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {txs.map((t, i) => (
              <BucketTxRow key={t.id} t={t} index={i} choices={loaded!.choices} onMoved={(id, m) => setMoved((s) => toggled(s, id, m))} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Overflow (rollover): a switch, one line on what it does, and, in the month it starts, what's already
 * saved (carried into that first month). Optimistic; the page data catches up on revalidate.
 */
function Overflow({ r, month, currentMonth }: { r: BucketRow; month: Month; currentMonth: Month }) {
  const id = useId();
  const [on, setOn] = useState(r.rollover);
  const [seen, setSeen] = useState(r.rollover);
  if (r.rollover !== seen) {
    setSeen(r.rollover);
    setOn(r.rollover);
  }
  const [pending, start] = useTransition();
  const toast = useToast();
  // turning it on starts the current month; "Already saved" is the carry into that first month
  const from = r.rolloverFrom ?? (on ? currentMonth : null);
  const firstMonth = on && from === month;

  function toggle(next: boolean) {
    setOn(next);
    start(async () => {
      const res = await setBucketRolloverAction({ categoryId: r.id, enabled: next });
      if (!res.ok) {
        setOn(!next);
        return void toast.show({ message: res.error, tone: "error" });
      }
      toast.show({
        message: next ? `${r.name}: leftovers roll over` : `${r.name} no longer rolls over`,
        action: res.operationId ? { label: "Undo", onAction: () => void undoAction(res.operationId!) } : undefined,
      });
    });
  }

  const openingRef = useRef<HTMLSpanElement>(null);
  function saveOpening(v: bigint) {
    // keep focus in the sheet (the field turns back into a button), so Escape still closes it
    requestAnimationFrame(() => openingRef.current?.querySelector("button")?.focus());
    start(async () => {
      const res = await setBucketRolloverAction({ categoryId: r.id, enabled: true, openingMilli: v });
      if (!res.ok) return void toast.show({ message: res.error, tone: "error" });
      toast.show({
        message: `${r.name}: ${formatMilli(v, { cents: false })} already saved`,
        action: res.operationId ? { label: "Undo", onAction: () => void undoAction(res.operationId!) } : undefined,
      });
    });
  }

  return (
    <section aria-label="Overflow" className="rounded-[16px] border border-rule bg-paper-sunken/60 p-4" data-rollover={on ? "on" : "off"}>
      <h3 className="mb-2 flex items-center gap-1.5 text-[14px] font-semibold text-ink">
        <IterationCw size={15} strokeWidth={2.2} aria-hidden className={on ? "text-accent" : "text-ink-3"} />
        Overflow
      </h3>
      <div className="flex items-center gap-4">
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-[14px] text-ink">Roll leftover money into next month</span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">What&rsquo;s left at the end of a month raises the next month&rsquo;s budget. Overspending doesn&rsquo;t carry.</span>
        </label>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          disabled={pending}
          onClick={() => toggle(!on)}
          className={cx(
            "relative h-7 w-12 shrink-0 rounded-full border transition-[background-color,border-color,box-shadow] duration-200 disabled:opacity-60",
            on ? "border-accent bg-accent shadow-[0_0_14px_-2px_var(--accent-glow)]" : "border-rule-strong bg-paper-sunken",
          )}
        >
          <span aria-hidden className={cx("absolute top-[3px] h-5 w-5 rounded-full shadow-sm transition-[left] duration-200", on ? "left-[23px] bg-accent-contrast" : "left-[3px] bg-ink-3")} />
        </button>
      </div>
      {on && (
        <div className="mt-3 flex min-h-11 items-center gap-3 border-t border-rule pt-3">
          {firstMonth ? (
            <>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] text-ink">Already saved</span>
                <span className="block text-[12px] text-ink-3">Optional. Counts as rolled over into {formatMonth(month)}.</span>
              </span>
              <span ref={openingRef}>
                <AmountInput value={r.rolloverFrom === month ? r.carryIn : 0n} onCommit={saveOpening} label={`Already saved in ${r.name}`} allowNegative={false} boxed />
              </span>
            </>
          ) : (
            <span className="text-[12.5px] text-ink-3">{from && from > month ? `Starts in ${formatMonth(from)}` : from ? `Rolling over since ${formatMonth(from)}` : ""}</span>
          )}
        </div>
      )}
    </section>
  );
}

function toggled(s: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const n = new Set(s);
  if (on) n.add(id);
  else n.delete(id);
  return n;
}
