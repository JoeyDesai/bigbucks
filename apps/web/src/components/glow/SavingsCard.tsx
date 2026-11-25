"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { formatMilli, formatMonth, type Month } from "@homebase/shared";
import type { BucketRow, BucketSavings } from "@homebase/core";
import { cx } from "@/lib/cx";
import { dollars } from "@/lib/format";
import { QUICK_AMOUNTS, overReadyWarning, readyLine, savingsChange, savingsDisplay, wholeDollars } from "@/lib/savings-display";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { AmountInput } from "@/components/ui/AmountInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { BucketBar } from "./BucketBar";
import { useCountUp } from "./useCountUp";

/** Add (positive) or take out (negative) money; resolves when the server has answered. */
export type SavingsChangeFn = (row: BucketRow, amount: bigint) => Promise<void> | void;

function Money({ value, k, className, delay }: { value: bigint; k: string; className?: string; delay?: number }) {
  const shown = useCountUp(value, { key: k, delay });
  return (
    <span className={cx("num", className)} data-value={value.toString()} aria-label={formatMilli(value)}>
      {shown < 0n ? "−" : ""}
      {dollars(shown < 0n ? -shown : shown)}
    </span>
  );
}

/**
 * The add / take-out form: an amount (focused, Enter submits), quick amounts, and a switch to take money
 * out instead. Used in the "+ Add" popover and in the bucket sheet. Adding more than `readyToSave` warns
 * once (the button turns into "Add anyway"); it never blocks, since older cash can go into savings too.
 */
export function SavingsAddForm({ row, onSubmit, onCancel, autoFocus = true, initialTakeOut = false, readyToSave }: { row: BucketRow; onSubmit: (amount: bigint) => void; onCancel?: () => void; autoFocus?: boolean; initialTakeOut?: boolean; readyToSave?: bigint }) {
  const [takeOut, setTakeOut] = useState(initialTakeOut);
  const [amount, setAmount] = useState<bigint>(0n);
  const [error, setError] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const balance = row.savings?.balance ?? 0n;

  const focusInput = () => requestAnimationFrame(() => wrap.current?.querySelector<HTMLInputElement>("input")?.focus());
  function submit(v: bigint = amount) {
    const r = savingsChange(v, takeOut, balance);
    if ("error" in r) {
      setError(r.error);
      focusInput();
      return;
    }
    if (!takeOut && readyToSave !== undefined && !warned && overReadyWarning(r.amount, readyToSave)) {
      setAmount(r.amount);
      setWarned(true);
      focusInput();
      return;
    }
    onSubmit(r.amount);
    setAmount(0n);
    setInputKey((k) => k + 1);
    setError(null);
    setWarned(false);
  }
  const overWarning = !takeOut && readyToSave !== undefined ? overReadyWarning(amount, readyToSave) : null;
  const verb = takeOut ? "Take out" : warned && overWarning ? "Add anyway" : "Add";

  return (
    <div
      ref={wrap}
      className="space-y-3"
      onKeyDown={(e) => {
        if (e.key === "Escape" && onCancel) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <SegmentedControl
        label={`Add to or take out of ${row.name}`}
        size="sm"
        block
        value={takeOut ? "out" : "add"}
        onChange={(v) => {
          setTakeOut(v === "out");
          setError(null);
          setWarned(false);
          focusInput();
        }}
        options={[
          { value: "add", label: "Add" },
          { value: "out", label: "Take out" },
        ]}
      />
      <div className="flex items-center gap-2">
        <span className={cx("text-[20px] font-semibold", takeOut ? "text-over" : "text-accent")} aria-hidden>
          {takeOut ? "−" : "+"}
        </span>
        <AmountInput
          key={inputKey}
          value={amount}
          tapToEdit={false}
          autoFocus={autoFocus}
          blankZero
          allowNegative={false}
          placeholder="0.00"
          label={takeOut ? `Amount to take out of ${row.name}` : `Amount to add to ${row.name}`}
          onCommit={(v) => {
            if (v !== amount) setWarned(false);
            setAmount(v);
            setError(null);
          }}
          onEnter={(v) => submit(v)}
          className="flex-1"
          inputClassName="text-left! text-[18px]"
        />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick amounts">
        {QUICK_AMOUNTS.map((q) => (
          <button
            key={q.toString()}
            type="button"
            onClick={() => {
              setAmount(q);
              setError(null);
              setWarned(false);
              focusInput();
            }}
            aria-pressed={amount === q}
            className={cx(
              "num h-8 rounded-full border px-3 text-[13px] font-medium transition-colors",
              amount === q ? "border-accent bg-accent-soft text-accent" : "border-rule-strong text-ink-2 hover:border-accent/60 hover:text-ink",
            )}
          >
            {wholeDollars(q)}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-[12.5px] text-over">
          {error}
        </p>
      ) : takeOut ? (
        <p className="text-[12.5px] text-ink-3">Up to {formatMilli(balance > 0n ? balance : 0n)}</p>
      ) : overWarning ? (
        <p role={warned ? "alert" : undefined} className="text-[12.5px] text-warn" data-testid="savings-over-free">
          {overWarning}
        </p>
      ) : readyToSave !== undefined ? (
        <p className="text-[12.5px] text-ink-3" data-testid="savings-ready-hint">
          Ready to save: <span className="num font-semibold text-ink-2">{formatMilli(readyToSave > 0n ? readyToSave : 0n)}</span>
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-9 rounded-[10px] px-3 text-[13px] font-medium text-ink-3 hover:bg-paper-hover hover:text-ink">
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => submit()}
          className={cx(
            "h-9 min-w-[96px] rounded-[10px] px-3.5 text-[13px] font-semibold transition-[opacity,box-shadow]",
            takeOut ? "border border-over/50 text-over hover:bg-over/10" : warned && overWarning ? "bg-warn-bar text-[#1a1206]" : "bg-accent text-accent-contrast shadow-[0_4px_14px_-6px_var(--accent-glow)]",
          )}
          data-testid="savings-submit"
        >
          {amount > 0n ? `${verb} ${formatMilli(amount, { cents: amount % 1000n !== 0n })}` : verb}
        </button>
      </div>
    </div>
  );
}

/** "+ Add" and its popover (anchored under the button, right-aligned; closes on outside tap or Escape). */
function AddPopover({ row, onChange, onOpenChange, readyToSave }: { row: BucketRow; onChange: SavingsChangeFn; onOpenChange?: (open: boolean) => void; readyToSave?: bigint }) {
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <div ref={ref} className="pointer-events-auto relative">
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Add money to ${row.name}`}
        className={cx(
          "inline-flex h-9 items-center gap-1 rounded-full border px-3 text-[13px] font-semibold transition-[background-color,border-color,color,box-shadow]",
          open ? "border-accent bg-accent text-accent-contrast shadow-[0_0_16px_-4px_var(--accent-glow)]" : "border-accent/40 text-accent hover:border-accent hover:bg-accent-soft",
        )}
        data-testid="savings-add"
      >
        <Plus size={15} strokeWidth={2.4} aria-hidden /> Add
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Add to ${row.name}`}
          className="absolute right-0 top-full z-40 mt-2 w-[300px] max-w-[calc(100vw-32px)] rounded-[16px] border border-rule bg-paper-raised p-4 shadow-pop"
          style={{ animation: "hb-pop 160ms var(--ease-out-quart)" }}
        >
          <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-ink">
            <CategoryIcon icon={row.icon} name={row.name} size={16} tone="accent" />
            <span className="truncate">{row.name}</span>
            <span className="num ml-auto text-[12.5px] font-medium text-ink-3">{dollars(row.savings?.balance ?? 0n)}</span>
          </div>
          <SavingsAddForm
            row={row}
            readyToSave={readyToSave}
            onCancel={close}
            onSubmit={(amount) => {
              setOpen(false);
              void onChange(row, amount);
            }}
          />
        </div>
      )}
    </div>
  );
}

function SavingsTile({ r, index, month, readyToSave, onOpen, onChange }: { r: BucketRow; index: number; month: Month; readyToSave?: bigint; onOpen: (r: BucketRow) => void; onChange: SavingsChangeFn }) {
  const s = r.savings!;
  const d = savingsDisplay(r.name, s, { monthLabel: (m) => formatMonth(m as Month) });
  const reduce = useReducedMotion();
  const [popOpen, setPopOpen] = useState(false);
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.04 + Math.min(index, 14) * 0.03, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className={cx("group/row relative", popOpen && "z-30")}
      data-category-id={r.id}
      data-bucket-kind="savings"
      data-balance={s.balance.toString()}
    >
      <button type="button" onClick={() => onOpen(r)} aria-label={`${r.name} details`} className="absolute inset-0 z-0 rounded-[14px] transition-colors hover:bg-paper-hover focus-visible:bg-paper-hover" />
      <div className="pointer-events-none relative z-[1] grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-3 sm:py-3.5">
        <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-accent-soft">
          <CategoryIcon icon={r.icon} name={r.name} size={19} tone="accent" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-ink">{r.name}</div>
          <Money value={s.balance} k={month} delay={200 + Math.min(index, 14) * 35} className={cx("display block text-[24px] leading-tight", d.negative ? "text-over" : "text-ink")} />
        </div>
        {s.started ? <AddPopover row={r} onChange={onChange} onOpenChange={setPopOpen} readyToSave={readyToSave} /> : <span />}
        <div className="col-span-2 col-start-2 mt-2">
          {d.bar && <BucketBar bar={d.bar} index={index} height={8} label={d.label} />}
          <div className={cx("text-[12px]", d.bar ? "mt-1.5" : "", d.negative ? "text-over" : "text-ink-3")} data-testid="savings-detail">
            {d.detail}
          </div>
        </div>
      </div>
    </motion.li>
  );
}

/**
 * The Savings card on the Budget page: each savings bucket's balance (and progress toward its target),
 * an inline "+ Add", and Ready to save (this month only): cash in the budget accounts that no bucket
 * holds, which is what you can move into savings.
 */
export function SavingsCard({ savings, income, month, currentMonth, onOpen, onChange }: { savings: BucketSavings; income: bigint; month: Month; currentMonth: Month; onOpen: (r: BucketRow) => void; onChange: SavingsChangeFn }) {
  if (!savings.rows.length) return null;
  const current = month === currentMonth;
  const added = savings.addedToSavings;
  const ready = savings.ready;
  const line = ready ? readyLine(ready.amount) : null;
  return (
    <section aria-labelledby="savings-h" className="card relative px-2 pb-2 pt-4" data-testid="savings-card">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 overflow-hidden rounded-t-[var(--radius-lg)]">
        <div className="absolute -left-16 -top-20 h-48 w-72 rounded-full opacity-50 blur-3xl" style={{ background: "radial-gradient(closest-side, var(--accent-glow), transparent)" }} />
      </div>
      <header className="relative mb-1 px-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="savings-h" className="text-[13px] font-semibold uppercase tracking-[0.07em] text-ink-2">
            Savings
          </h2>
          <span className="text-[12.5px] text-ink-3">
            Total saved <Money value={savings.totalSaved} k={month} className="ml-1 text-[17px] font-semibold text-ink" />
          </span>
        </div>
        {ready && line && (
          <>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5" data-testid="savings-ready" data-value={ready.amount.toString()}>
              <span className="text-[13px] text-ink-2">{line.label}</span>
              <span className={cx("num display text-[22px] leading-none", line.over ? "text-warn" : "text-accent")} aria-label={`${line.label}: ${line.amount}`}>
                <Money value={ready.amount < 0n ? -ready.amount : ready.amount} k={`${month}-ready`} />
              </span>
              <Link href="/guide#savings" className="ml-auto text-[12.5px] font-medium text-accent hover:underline" data-testid="savings-help">
                How this works
              </Link>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-3" data-testid="savings-breakdown">
              Cash in your accounts <span className="num text-ink-2">{wholeDollars(ready.cash)}</span> − left in this month&rsquo;s buckets <span className="num text-ink-2">{wholeDollars(ready.inBuckets)}</span> − already in savings{" "}
              <span className="num text-ink-2">{wholeDollars(ready.inSavings)}</span>
            </p>
          </>
        )}
        <p className="mt-1 text-[12px] text-ink-3" data-testid="savings-income">
          Came in {current ? "this month" : "that month"} <span className="num text-ink-2">{wholeDollars(income > 0n ? income : 0n)}</span> ·{" "}
          {added === 0n ? "nothing added to savings" : added > 0n ? `${wholeDollars(added)} added to savings` : `${wholeDollars(-added)} taken out of savings`}
        </p>
      </header>
      <ul className="relative grid sm:grid-cols-2 xl:grid-cols-3">
        {savings.rows.map((r, i) => (
          <SavingsTile key={r.id} r={r} index={i} month={month} readyToSave={ready?.amount} onOpen={onOpen} onChange={onChange} />
        ))}
      </ul>
    </section>
  );
}
