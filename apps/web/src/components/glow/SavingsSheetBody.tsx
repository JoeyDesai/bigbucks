"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { PiggyBank } from "lucide-react";
import { formatMilli, formatMonth, type Month } from "@homebase/shared";
import type { BucketRow } from "@homebase/core";
import { cx } from "@/lib/cx";
import { formatDay } from "@/lib/format";
import { savingsDisplay } from "@/lib/savings-display";
import type { CategoryChoice, TxItem } from "@/lib/tx";
import { bucketTransactionsAction, savingsHistoryAction, setSavingsBucketAction, setSavingsTargetAction, type SavingsHistoryItem } from "@/server/actions/glow";
import { undoAction } from "@/server/actions/budget";
import { AmountInput } from "@/components/ui/AmountInput";
import { useToast } from "@/components/ui/Toast";
import { BucketBar } from "./BucketBar";
import { BucketTxRow } from "./BucketTxRow";
import { SavingsAddForm, type SavingsChangeFn } from "./SavingsCard";

const signed = (m: bigint) => formatMilli(m, { sign: m > 0n ? "always" : "auto" });

/**
 * The bucket sheet for a savings bucket (ADR "Buckets: savings buckets"): balance and progress, Add /
 * Take out, the optional target, the starting balance (editable in the start month), and this month's
 * history (what came in, what was added or taken out, what was spent). No monthly goal, no overflow.
 */
export function SavingsSheetBody({ r, month, onChange, readyToSave }: { r: BucketRow; month: Month; onChange?: SavingsChangeFn; readyToSave?: bigint }) {
  const s = r.savings!;
  const d = savingsDisplay(r.name, s, { monthLabel: (m) => formatMonth(m as Month) });
  const [loaded, setLoaded] = useState<{ items: TxItem[]; choices: CategoryChoice[] } | null>(null);
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const txs = loaded && loaded.items.filter((t) => !moved.has(t.id));
  const [adds, setAdds] = useState<SavingsHistoryItem[] | null>(null);
  const [pending, start] = useTransition();
  const [refresh, setRefresh] = useState(0);
  const [sending, setSending] = useState(0);
  const toast = useToast();
  useEffect(() => {
    let live = true;
    void bucketTransactionsAction(r.id, month).then((x) => {
      if (!live) return;
      setLoaded(x);
      setMoved(new Set());
    });
    void savingsHistoryAction(r.id, month).then((x) => live && setAdds(x));
    return () => {
      live = false;
    };
  }, [r.id, month, s.spent, s.contributed, refresh]);

  const startMonth = s.from === month;
  const logged = (adds ?? []).reduce((a, x) => a + x.amount, 0n);
  // seeded / imported assignments have no operation behind them; hidden while an add is still saving
  const earlier = adds && sending === 0 ? s.contributed - logged : 0n;

  function saveTarget(v: bigint | null) {
    start(async () => {
      const res = await setSavingsTargetAction({ categoryId: r.id, targetMilli: v });
      if (!res.ok) return void toast.show({ message: res.error, tone: "error" });
      toast.show({
        message: v === null ? `Removed the target for ${r.name}` : `${r.name}: saving toward ${formatMilli(v, { cents: false })}`,
        action: res.operationId ? { label: "Undo", onAction: () => void undoAction(res.operationId!) } : undefined,
      });
    });
  }
  const openingRef = useRef<HTMLSpanElement>(null);
  function saveOpening(v: bigint) {
    requestAnimationFrame(() => openingRef.current?.querySelector("button")?.focus());
    start(async () => {
      const res = await setSavingsBucketAction({ categoryId: r.id, enabled: true, openingMilli: v });
      if (!res.ok) return void toast.show({ message: res.error, tone: "error" });
      toast.show({
        message: `${r.name} started with ${formatMilli(v, { cents: false })}`,
        action: res.operationId ? { label: "Undo", onAction: () => void undoAction(res.operationId!) } : undefined,
      });
    });
  }

  return (
    <div className={cx("space-y-6", pending && "opacity-90")} data-bucket-kind="savings">
      <div>
        <div className="flex items-baseline gap-2">
          <span className={cx("num display text-[38px] leading-none", d.negative ? "text-over" : "text-ink")} data-testid="savings-balance" data-value={s.balance.toString()}>
            {formatMilli(s.balance)}
          </span>
          <span className="text-[15px] text-ink-3">saved</span>
        </div>
        {d.bar && <BucketBar bar={d.bar} height={12} className="mt-4" label={d.label} />}
        <div className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-3">
          <PiggyBank size={14} strokeWidth={2} aria-hidden className="text-accent" />
          {d.bar ? d.detail : s.started ? "Savings bucket: add money as it comes in" : d.detail}
        </div>
      </div>

      {s.started && onChange && (
        <section aria-label="Add or take out" className="rounded-[16px] border border-rule bg-paper-sunken/60 p-4">
          <SavingsAddForm
            row={r}
            autoFocus={false}
            readyToSave={readyToSave}
            onSubmit={(amount) => {
              setSending((n) => n + 1);
              void Promise.resolve(onChange(r, amount)).finally(() => {
                setSending((n) => n - 1);
                setRefresh((n) => n + 1);
              });
            }}
          />
        </section>
      )}

      <section aria-label="Target" className="rounded-[16px] border border-rule bg-paper-sunken/60 p-4">
        <div className="flex min-h-11 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-ink">Target</span>
            <span className="block text-[12.5px] text-ink-3">{s.target ? "Optional. The bar fills toward it." : "Optional. Set one to see progress."}</span>
          </span>
          <AmountInput value={s.target ?? 0n} onCommit={(v) => saveTarget(v > 0n ? v : null)} label={`Target for ${r.name}`} allowNegative={false} boxed />
        </div>
        {s.target !== null && (
          <div className="mt-1 flex justify-end">
            <button type="button" disabled={pending} onClick={() => saveTarget(null)} className="h-8 rounded-[10px] px-2.5 text-[12.5px] font-medium text-ink-3 hover:bg-paper-hover hover:text-over">
              Remove target
            </button>
          </div>
        )}
      </section>

      <section aria-label="Starting balance" className="rounded-[16px] border border-rule bg-paper-sunken/60 p-4">
        <div className="flex min-h-11 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-ink">Starting balance</span>
            <span className="block text-[12.5px] text-ink-3">
              {startMonth ? `What was already saved when it started in ${formatMonth(s.from)}.` : `Saving since ${formatMonth(s.from)}, started with ${formatMilli(s.opening, { cents: false })}.`}
            </span>
          </span>
          {startMonth && (
            <span ref={openingRef}>
              <AmountInput value={s.opening} onCommit={saveOpening} label={`Starting balance for ${r.name}`} allowNegative={false} boxed />
            </span>
          )}
        </div>
      </section>

      <section aria-label="This month">
        <h3 className="eyebrow mb-2">This month</h3>
        {txs === null || adds === null ? (
          <ul className="space-y-2">
            {[0, 1, 2].map((i) => (
              <li key={i} className="skeleton h-12" />
            ))}
          </ul>
        ) : (
          <ul className="divide-y divide-rule" data-testid="savings-history">
            {s.started && (
              <li className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1 text-[14px] text-ink-2">{startMonth ? "Starting balance" : "Carried in from last month"}</span>
                <span className="num shrink-0 text-[14px] font-semibold text-ink">{formatMilli(s.carryIn)}</span>
              </li>
            )}
            {adds.map((a, i) => (
              <li key={a.operationId} className="flex items-center gap-3 py-2.5 hb-rise" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
                <span className="num w-12 shrink-0 text-[12.5px] text-ink-3">{formatDay(a.at.slice(0, 10))}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{a.amount > 0n ? "Added" : "Taken out"}</span>
                  {a.userName && <span className="block truncate text-[12px] text-ink-3">{a.userName}</span>}
                </span>
                <span className={cx("num shrink-0 text-[14px] font-semibold", a.amount > 0n ? "text-pos" : "text-over")}>{signed(a.amount)}</span>
              </li>
            ))}
            {earlier !== 0n && (
              <li className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1 text-[14px] text-ink-2">{earlier > 0n ? "Added earlier" : "Taken out earlier"}</span>
                <span className={cx("num shrink-0 text-[14px] font-semibold", earlier > 0n ? "text-pos" : "text-over")}>{signed(earlier)}</span>
              </li>
            )}
            {txs.map((t, i) => (
              <BucketTxRow
                key={t.id}
                t={t}
                index={i + adds.length}
                choices={loaded!.choices}
                onMoved={(id, m) =>
                  setMoved((s) => {
                    const n = new Set(s);
                    if (m) n.add(id);
                    else n.delete(id);
                    return n;
                  })
                }
              />
            ))}
            {!adds.length && earlier === 0n && !txs.length && <li className="py-6 text-center text-[13.5px] text-ink-3">Nothing added or spent yet this month.</li>}
            {s.started && (
              <li className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">Balance</span>
                <span className={cx("num shrink-0 text-[14px] font-semibold", s.balance < 0n ? "text-over" : "text-ink")}>{formatMilli(s.balance)}</span>
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
