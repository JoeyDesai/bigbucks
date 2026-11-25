"use client";
import { useState, useTransition } from "react";
import { ChevronDown } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { formatDay } from "@/lib/format";
import type { CategoryChoice, TxItem } from "@/lib/tx";
import { categorizeAction } from "@/server/actions/glow";
import { restoreTransactionsAction } from "@/server/actions/transactions";
import { useToast } from "@/components/ui/Toast";
import { BucketPicker } from "./BucketPicker";

/**
 * One transaction in a bucket sheet. Tapping it opens the bucket picker right under it; picking moves
 * the transaction to that bucket (toast with Undo) and drops it from this list. Splits and transfers
 * aren't moved from here (Transactions handles those).
 */
export function BucketTxRow({ t, choices, index, onMoved }: { t: TxItem; choices: CategoryChoice[]; index: number; onMoved: (id: string, moved: boolean) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const movable = !t.isSplit && !t.transferAccountName && choices.length > 0;
  const body = (
    <>
      <span className="num w-12 shrink-0 text-[12.5px] text-ink-3">{formatDay(t.date)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{t.payee}</span>
        <span className="block truncate text-[12px] text-ink-3">
          {t.accountName}
          {t.isSplit ? " · split" : ""}
          {t.memo ? ` · ${t.memo}` : ""}
        </span>
      </span>
      <span className={cx("num shrink-0 text-[14px] font-semibold", t.amount > 0n ? "text-pos" : "text-ink")}>{formatMilli(t.amount, { sign: t.amount > 0n ? "always" : "auto" })}</span>
    </>
  );

  function move(c: CategoryChoice) {
    setOpen(false);
    if (c.id === t.categoryId) return;
    const before = { id: t.id, categoryId: t.categoryId, approved: t.approved };
    onMoved(t.id, true);
    start(async () => {
      const r = await categorizeAction({ ids: [t.id], categoryId: c.id });
      if (!r.ok || !r.updated.includes(t.id)) {
        onMoved(t.id, false);
        return void toast.show({ message: r.ok ? (r.skipped[0]?.reason ?? "That one can't be moved.") : r.error, tone: "error" });
      }
      toast.show({
        message: `${t.payee} → ${c.name}`,
        action: {
          label: "Undo",
          onAction: () =>
            void restoreTransactionsAction([before]).then((u) => {
              if (u.ok) onMoved(t.id, false);
              else toast.show({ message: u.error, tone: "error" });
            }),
        },
      });
    });
  }

  return (
    <li className="hb-rise" style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}>
      {movable ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={pending}
          aria-expanded={open}
          title="Move to another bucket"
          className="group -mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-[10px] px-2 py-2.5 text-left transition-colors hover:bg-paper-hover"
        >
          {body}
          <ChevronDown size={15} strokeWidth={2} aria-hidden className={cx("shrink-0 text-ink-3 transition-transform group-hover:text-ink-2", open && "rotate-180")} />
        </button>
      ) : (
        <div className="flex items-center gap-3 py-2.5">{body}</div>
      )}
      {open && (
        <div className="mb-2 overflow-hidden rounded-[14px] border border-rule bg-paper-raised">
          <BucketPicker choices={choices.filter((c) => c.id !== t.categoryId)} onPick={move} onClose={() => setOpen(false)} label={`Move ${t.payee} to`} maxHeight={260} />
        </div>
      )}
    </li>
  );
}
