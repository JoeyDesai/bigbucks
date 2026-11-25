"use client";
import { useMemo } from "react";
import { Plus, X } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import type { SplitLineVM } from "@/lib/view-models";
import { AmountInput } from "@/components/ui/AmountInput";
import { IconButton } from "@/components/ui/Button";

export interface SplitEditorProps {
  /** Parent transaction amount (negative for outflows). */
  total: bigint;
  lines: SplitLineVM[];
  onChange: (lines: SplitLineVM[]) => void;
  /** Open a category picker for a line; caller writes the choice back via onChange. */
  onPickCategory: (lineId: string) => void;
  newLineId?: () => string;
}

/** Remaining amount the lines must still cover (lines must sum to the parent, spec §5.1). */
export function splitRemaining(total: bigint, lines: SplitLineVM[]): bigint {
  return total - lines.reduce((a, l) => a + l.amount, 0n);
}

/**
 * Split lines editor. Amounts are entered as positive outflows for an outflow parent
 * (sign follows the parent). Shows the remaining amount; the caller disables Save until it is 0.
 */
export function SplitEditor({ total, lines, onChange, onPickCategory, newLineId = () => `line-${Math.random().toString(36).slice(2, 8)}` }: SplitEditorProps) {
  const sign = total < 0n ? -1n : 1n;
  const remaining = useMemo(() => splitRemaining(total, lines), [total, lines]);

  const update = (id: string, patch: Partial<SplitLineVM>) => onChange(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="eyebrow">Split lines</span>
        <span className={cx("num text-[13px]", remaining === 0n ? "text-pos" : "text-warn")} aria-live="polite">
          {remaining === 0n ? "Fully split" : `${formatMilli(remaining * sign)} left to split`}
        </span>
      </div>
      <ul className="border-t border-rule">
        {lines.map((l, i) => (
          <li key={l.id} className="grid grid-cols-[minmax(0,1fr)_120px_44px] items-center gap-2 border-b border-rule py-2">
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => onPickCategory(l.id)}
                className={cx("flex min-h-11 w-full items-center truncate rounded-xs border border-rule px-2.5 text-left text-[14px]", l.categoryName ? "text-ink" : "text-ink-3")}
              >
                <span className="truncate">{l.categoryName ?? `Choose category for line ${i + 1}`}</span>
              </button>
              <input
                value={l.memo ?? ""}
                onChange={(e) => update(l.id, { memo: e.target.value })}
                placeholder="Memo"
                aria-label={`Memo for line ${i + 1}`}
                className="mt-1 h-9 w-full border-0 border-b border-transparent bg-transparent px-1 text-[13px] text-ink-2 outline-none placeholder:text-ink-3 focus:border-rule-strong"
              />
            </div>
            <AmountInput
              tapToEdit={false}
              value={l.amount * sign}
              allowNegative={false}
              label={`Amount for line ${i + 1}`}
              onCommit={(v) => update(l.id, { amount: v * sign })}
            />
            <IconButton label={`Remove line ${i + 1}`} disabled={lines.length <= 2} onClick={() => onChange(lines.filter((x) => x.id !== l.id))}>
              <X size={16} strokeWidth={1.75} />
            </IconButton>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange([...lines, { id: newLineId(), categoryId: null, categoryName: null, amount: remaining }])}
        className="mt-2 inline-flex min-h-11 items-center gap-2 text-[14px] text-accent"
      >
        <Plus size={16} strokeWidth={1.75} aria-hidden /> Add line
        {remaining !== 0n && <span className="num text-ink-3">({formatMilli(remaining * sign)})</span>}
      </button>
    </div>
  );
}
