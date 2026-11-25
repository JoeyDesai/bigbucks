"use client";
import { startTransition, useCallback, useOptimistic, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, IterationCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { formatMilli, type Month } from "@homebase/shared";
import type { BucketGroup, BucketMonth, BucketRow } from "@homebase/core";
import { cx } from "@/lib/cx";
import { monthParam, dollars } from "@/lib/format";
import { paceText, rowDisplay } from "@/lib/bucket-display";
import { BucketBar } from "@/components/glow/BucketBar";
import { BucketSheet } from "@/components/glow/BucketSheet";
import { GoalInline } from "@/components/glow/GoalInline";
import { SavingsCard } from "@/components/glow/SavingsCard";
import { MonthNav } from "@/components/glow/MonthNav";
import { useCountUp } from "@/components/glow/useCountUp";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { UserMenu } from "@/components/shell/UserMenu";
import { useToast } from "@/components/ui/Toast";
import { withSavingsDelta } from "@/lib/savings-display";
import { addToSavingsAction } from "@/server/actions/glow";
import { undoAction } from "@/server/actions/budget";

const TONE = { ink: "text-ink", over: "text-over", warn: "text-warn", muted: "text-ink-3" } as const;

function Amount({ value, k, delay, className, cents = false }: { value: bigint; k: string; delay?: number; className?: string; cents?: boolean }) {
  const shown = useCountUp(value, { key: k, delay });
  return (
    <span className={cx("num", className)} data-value={value.toString()} aria-label={cents ? formatMilli(value) : dollars(value)}>
      {cents ? formatMilli(shown) : dollars(shown)}
    </span>
  );
}

function Hero({ data, currentMonth }: { data: BucketMonth; currentMonth: Month }) {
  const t = data.totals;
  const over = t.left < 0n;
  const pace = data.pace;
  const p = paceText(pace.status, pace.spentRatio, pace.elapsed);
  const overall = t.budget > 0n ? { state: over ? ("over" as const) : pace.spentRatio >= 0.85 ? ("warn" as const) : ("under" as const), fill: over ? 0 : Math.max(0, 1 - pace.spentRatio), over: over ? Math.min(1, pace.spentRatio - 1) : 0 } : { state: "none" as const, fill: 0, over: 0 };
  const isCurrent = data.month === currentMonth;
  return (
    <section aria-label="This month" className="card relative overflow-hidden p-5 sm:p-7">
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full opacity-60 blur-3xl" style={{ background: "radial-gradient(closest-side, var(--accent-glow), transparent)" }} />
      <div className="relative">
        <div className="text-[13px] font-medium text-ink-3">{isCurrent ? "Left to spend this month" : data.month < currentMonth ? `Left in ${data.label}` : `Planned for ${data.label}`}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Amount value={over ? -t.left : t.left} k={data.month} className={cx("display text-[44px] leading-none sm:text-[56px]", over ? "text-over" : "text-ink")} />
          <span className="text-[15px] text-ink-3">
            {over ? "over" : "left"} of <Amount value={t.budget} k={data.month} className="font-semibold text-ink-2" />
          </span>
        </div>
        <BucketBar bar={overall} height={14} className="mt-5" label={`${Math.round(pace.spentRatio * 100)}% of the monthly budget spent`} />
        {/* pace marker: how much of the month has gone */}
        {pace.status !== "none" && isCurrent && (
          <div className="relative mt-1 h-4" aria-hidden>
            <motion.span initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.9, duration: 0.4 }} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: `${(pace.elapsed * 100).toFixed(1)}%` }}>
              <span className="h-2 w-px bg-ink-3" />
              <span className="text-[10.5px] font-medium text-ink-3">today</span>
            </motion.span>
          </div>
        )}
        <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-rule pt-4 sm:gap-6">
          <div>
            <dt className="text-[12px] text-ink-3">Spent</dt>
            <dd className="mt-0.5 text-[17px] font-semibold text-ink sm:text-[19px]">
              <Amount value={t.budgetedSpent} k={data.month} delay={150} />
            </dd>
            {t.unbudgetedSpent > 0n && <dd className="num mt-0.5 text-[11.5px] text-ink-3">+{dollars(t.unbudgetedSpent)} without a goal</dd>}
          </div>
          <div>
            <dt className="text-[12px] text-ink-3">Days left</dt>
            <dd className="num mt-0.5 text-[17px] font-semibold text-ink sm:text-[19px]">{pace.daysLeft}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-ink-3">Pace</dt>
            <dd className={cx("mt-0.5 flex items-center gap-1.5 text-[14px] font-semibold sm:text-[15px]", pace.status === "ahead" ? "text-over" : pace.status === "behind" ? "text-pos" : "text-ink")} title={p.detail} data-pace={pace.status}>
              <span aria-hidden className={cx("h-2 w-2 shrink-0 rounded-full", pace.status === "ahead" ? "bg-over" : pace.status === "behind" ? "bg-pos-bar" : "bg-accent")} style={{ animation: "hb-breathe 2.4s ease-in-out infinite" }} />
              <span className="leading-tight">{p.title}</span>
            </dd>
          </div>
        </dl>
        {p.detail && <p className="mt-1.5 text-[12px] text-ink-3">{p.detail}</p>}
      </div>
    </section>
  );
}

function Row({ r, index, month, onOpen }: { r: BucketRow; index: number; month: Month; onOpen: (r: BucketRow) => void }) {
  const d = rowDisplay(r);
  const reduce = useReducedMotion();
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.04 + Math.min(index, 14) * 0.03, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className="group/row relative"
      data-category-id={r.id}
      data-bar-state={d.bar.state}
    >
      <button
        type="button"
        onClick={() => onOpen(r)}
        aria-label={`${r.name} details`}
        className="absolute inset-0 z-0 rounded-[14px] transition-colors hover:bg-paper-hover focus-visible:bg-paper-hover"
      />
      <div className="pointer-events-none relative z-[1] grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-3 px-3 py-3 sm:py-3.5">
        <span className="row-span-2 flex h-10 w-10 items-center justify-center rounded-[12px] bg-accent-soft">
          <CategoryIcon icon={r.icon} name={r.name} size={19} tone="accent" />
        </span>
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[15px] font-medium text-ink">{r.name}</span>
            {r.rollover && (
              <span title="Leftovers roll over" className="shrink-0 text-accent" data-testid="rollover-icon">
                <IterationCw size={13} strokeWidth={2.2} aria-label="rolls over" />
              </span>
            )}
          </span>
          <span className="shrink-0 text-right">
            {d.done ? (
              <span className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-3">
                <Check size={14} strokeWidth={2.4} aria-hidden className="text-pos" /> Done
              </span>
            ) : (
              <>
            <Amount value={d.amount} k={month} delay={200 + Math.min(index, 14) * 35} className={cx("text-[15px] font-semibold", TONE[d.tone])} />
            <span className={cx("ml-1 text-[12.5px]", d.tone === "over" ? "text-over" : "text-ink-3")}>{d.amountSuffix}</span>
              </>
            )}
          </span>
        </div>
        <div className="col-start-2 mt-2">
          {d.bar.state === "none" ? (
            <div className="flex items-center justify-between gap-3">
              <div aria-hidden className="h-[10px] flex-1 rounded-full border border-dashed border-rule-strong" />
              <span className="pointer-events-auto">
                <GoalInline categoryId={r.id} name={r.name} month={month} />
              </span>
            </div>
          ) : (
            <BucketBar bar={d.bar} index={index} height={10} label={d.label} />
          )}
          {d.bar.state !== "none" && (
            <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[12px] text-ink-3">
              <span>{d.detail}</span>
              {d.rollover && (
                <span className="text-ink-2" data-testid="rollover-note">
                  {d.rollover}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.li>
  );
}

function Group({ g, offset, month, onOpen }: { g: BucketGroup; offset: number; month: Month; onOpen: (r: BucketRow) => void }) {
  return (
    <section aria-labelledby={`g-${g.id}`} className="card mb-5 break-inside-avoid px-2 pb-2 pt-4 sm:mb-6">
      <header className="mb-1 flex items-baseline justify-between px-3">
        <h2 id={`g-${g.id}`} className="text-[13px] font-semibold uppercase tracking-[0.07em] text-ink-2">
          {g.name}
        </h2>
        <span className="num text-[12.5px] text-ink-3">
          <span className="font-semibold text-ink-2">{dollars(g.spent > 0n ? g.spent : 0n)}</span>
          {g.budget > 0n && <> of {dollars(g.budget)}</>}
        </span>
      </header>
      <ul>
        {g.rows.map((r, i) => (
          <Row key={r.id} r={r} index={offset + i} month={month} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

/** The Budget tab: summary, an uncategorized callout, savings, then each group as a card of bucket rows. */
export function BudgetView({ data, currentMonth }: { data: BucketMonth; currentMonth: Month }) {
  const [open, setOpen] = useState<BucketRow | null>(null);
  const toast = useToast();
  // adds show at once (the balance counts up, the bar grows); the server's answer replaces them
  const [savings, applySavings] = useOptimistic(data.savings, (s, d: { id: string; delta: bigint }) => withSavingsDelta(s, d.id, d.delta));
  const changeSavings = useCallback(
    (r: BucketRow, amount: bigint) =>
      new Promise<void>((resolve) => {
        startTransition(async () => {
          applySavings({ id: r.id, delta: amount });
          const res = await addToSavingsAction({ categoryId: r.id, amount, month: data.month });
          resolve();
          if (!res.ok) return void toast.show({ message: res.error, tone: "error" });
          const v = formatMilli(amount < 0n ? -amount : amount, { cents: amount % 1000n !== 0n });
          toast.show({
            message: amount > 0n ? `Added ${v} to ${r.name}` : `Took ${v} out of ${r.name}`,
            action: res.operationId ? { label: "Undo", onAction: () => void undoAction(res.operationId!) } : undefined,
          });
        });
      }),
    [applySavings, data.month, toast],
  );
  const hrefFor = useCallback((m: Month) => (m === currentMonth ? "/budget" : `/budget?m=${monthParam(m)}`), [currentMonth]);
  const offsets = data.groups.map((_, i) => data.groups.slice(0, i).reduce((n, g) => n + g.rows.length, 0));
  const empty = data.groups.length === 0 && savings.rows.length === 0;
  const allRows = [...data.groups.flatMap((g) => g.rows), ...savings.rows];
  const live = open ? (allRows.find((r) => r.id === open.id) ?? open) : null;
  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pb-6 pt-3 sm:px-6 lg:px-10 lg:pt-8">
      <header className="mb-4 flex items-center gap-2 lg:mb-6">
        <h1 className="display flex-1 text-[28px] leading-tight text-ink lg:text-[32px]">Budget</h1>
        <MonthNav month={data.month} hrefFor={hrefFor} currentMonth={currentMonth} min={data.range.first} className="hidden sm:flex" />
        <Link
          href="/settings/categories"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-rule px-3.5 text-[13px] font-medium text-ink-2 transition-colors hover:border-accent/50 hover:text-ink"
          data-testid="edit-buckets"
        >
          <SlidersHorizontal size={15} strokeWidth={2} aria-hidden />
          Edit buckets
        </Link>
        <div className="-mr-2 lg:hidden">
          <UserMenu />
        </div>
      </header>
      <MonthNav month={data.month} hrefFor={hrefFor} currentMonth={currentMonth} min={data.range.first} className="-mx-1 mb-3 justify-center sm:hidden" />

      <div className="hb-rise grid gap-5 lg:gap-6">
        <Hero data={data} currentMonth={currentMonth} />

        {data.uncategorized.count > 0 && (
          <Link
            href="/transactions"
            className="group flex items-center gap-3 rounded-[18px] border border-dashed border-accent/40 bg-accent-soft/60 px-4 py-3.5 transition-colors hover:bg-accent-soft"
            data-testid="uncategorized-callout"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-contrast shadow-[0_0_16px_var(--accent-glow)]">
              <Sparkles size={17} strokeWidth={2} aria-hidden />
            </span>
            <span className="min-w-0 flex-1 text-[14px] text-ink">
              <span className="font-semibold">
                {data.uncategorized.count} {data.uncategorized.count === 1 ? "transaction needs" : "transactions need"} a bucket
              </span>
              <span className="text-ink-2"> · {formatMilli(data.uncategorized.spent)} not counted yet</span>
            </span>
            <ArrowRight size={17} strokeWidth={2} aria-hidden className="shrink-0 text-accent transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}

        <SavingsCard savings={savings} income={data.income} month={data.month} currentMonth={currentMonth} onOpen={setOpen} onChange={changeSavings} />

        {empty ? (
          <div className="card px-6 py-14 text-center">
            <h2 className="display text-[20px] text-ink">No buckets yet</h2>
            <p className="mx-auto mt-2 max-w-[360px] text-[14px] text-ink-3">Add categories in Settings → Categories, then give each one a monthly goal here.</p>
          </div>
        ) : (
          <div className="columns-1 gap-6 xl:columns-2" data-month={data.month} data-testid="buckets">
            {data.groups.map((g, i) => (
              <Group key={g.id} g={g} offset={offsets[i]!} month={data.month} onOpen={setOpen} />
            ))}
          </div>
        )}
      </div>
      <BucketSheet row={live} month={data.month} currentMonth={currentMonth} onClose={() => setOpen(null)} onSavingsChange={changeSavings} readyToSave={savings.ready?.amount} />
    </div>
  );
}
