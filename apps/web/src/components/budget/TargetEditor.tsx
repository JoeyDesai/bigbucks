"use client";
import { useId, useState, useTransition } from "react";
import type { TargetType } from "@homebase/shared";
import type { CategoryVM, TargetFields } from "@/lib/view-models";
import { editTargetAction, snoozeTargetAction } from "@/server/actions/budget";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

const TYPES: { value: TargetType; label: string; hint: string }[] = [
  { value: "need_set_aside", label: "Set aside", hint: "Set aside another amount every period" },
  { value: "need_refill", label: "Refill up to", hint: "Top the category back up to an amount" },
  { value: "balance", label: "Have a balance", hint: "Build up to a balance, no date" },
  { value: "balance_by_date", label: "Balance by date", hint: "Reach a balance by a date" },
  { value: "monthly_builder", label: "Monthly builder", hint: "Assign the same amount every month" },
  { value: "debt", label: "Debt payment", hint: "Pay a fixed amount each month" },
  { value: "percent_of_income", label: "% of income", hint: "A share of income received this month" },
];
const CADENCES: { value: TargetFields["cadence"]; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "weekly", label: "Weekly" },
  { value: "yearly", label: "Yearly" },
  { value: "every_n_months", label: "Every N months" },
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const FIELD = "h-11 w-full rounded-lg border border-rule-strong bg-paper-raised px-3 text-[15px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]";

export interface TargetEditorProps {
  month: string;
  category: CategoryVM;
  onDone: (message: string, operationId: string | null) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}

const blank = (): TargetFields => ({ type: "need_set_aside", amount: 0n, cadence: "monthly", cadenceEvery: 1, day: null, targetDate: null, percent: null });

/** Create / edit / remove / snooze a category target (§6.5). Edits apply from this month on. */
export function TargetEditor({ month, category, onDone, onError, onCancel }: TargetEditorProps) {
  const id = useId();
  const [f, setF] = useState<TargetFields>(category.target?.fields ?? blank());
  const [pending, start] = useTransition();
  const set = <K extends keyof TargetFields>(k: K, v: TargetFields[K]) => setF((x) => ({ ...x, [k]: v }));
  const hasCadence = f.type === "need_set_aside" || f.type === "need_refill";
  const needsDate = f.type === "balance_by_date" || (f.type === "need_set_aside" && (f.cadence === "yearly" || f.cadence === "every_n_months"));

  const save = () =>
    start(async () => {
      const r = await editTargetAction({
        categoryId: category.id,
        month,
        target: {
          type: f.type,
          amount: f.type === "percent_of_income" ? 0n : f.amount,
          cadence: hasCadence ? f.cadence : f.type === "balance" || f.type === "balance_by_date" ? "none" : "monthly",
          cadenceEvery: f.cadence === "every_n_months" ? Math.max(2, f.cadenceEvery) : 1,
          day: hasCadence && f.cadence === "weekly" ? (f.day ?? 0) : null,
          targetDate: needsDate ? f.targetDate : null,
          percent: f.type === "percent_of_income" ? (f.percent ?? "10") : null,
        },
      });
      if (r.ok) onDone(`Target saved for ${category.name}`, r.operationId);
      else onError(r.error);
    });

  const remove = () =>
    start(async () => {
      const r = await editTargetAction({ categoryId: category.id, month, target: null });
      if (r.ok) onDone(`Target removed from ${category.name}`, r.operationId);
      else onError(r.error);
    });

  const snooze = (snoozed: boolean) =>
    start(async () => {
      const r = await snoozeTargetAction({ categoryId: category.id, month, snoozed });
      if (r.ok) onDone(snoozed ? `Snoozed ${category.name} for this month` : `Un-snoozed ${category.name}`, r.operationId);
      else onError(r.error);
    });

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`${id}-type`} className="mb-1 block text-[13px] text-ink-2">
          Target type
        </label>
        <select id={`${id}-type`} value={f.type} onChange={(e) => set("type", e.target.value as TargetType)} className={FIELD}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[12px] text-ink-3">{TYPES.find((t) => t.value === f.type)?.hint}</p>
      </div>

      {f.type === "percent_of_income" ? (
        <div>
          <label htmlFor={`${id}-pct`} className="mb-1 block text-[13px] text-ink-2">
            Percent of income
          </label>
          <input
            id={`${id}-pct`}
            inputMode="decimal"
            value={f.percent ?? ""}
            onChange={(e) => set("percent", e.target.value.replace(/[^\d.]/g, "") || null)}
            placeholder="10"
            className={`${FIELD} num`}
          />
        </div>
      ) : (
        <AmountInput tapToEdit={false} hideLabel={false} allowNegative={false} label="Amount" value={f.amount} onCommit={(v) => set("amount", v)} className="w-full" />
      )}

      {hasCadence && (
        <div>
          <span className="mb-1 block text-[13px] text-ink-2">Every</span>
          <SegmentedControl label="Cadence" size="sm" block value={f.cadence} onChange={(v) => set("cadence", v)} options={CADENCES} />
          {f.cadence === "weekly" && (
            <select aria-label="Day of week" value={f.day ?? 0} onChange={(e) => set("day", Number(e.target.value))} className={`${FIELD} mt-2`}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  on {d}
                </option>
              ))}
            </select>
          )}
          {f.cadence === "every_n_months" && (
            <input
              aria-label="Number of months"
              type="number"
              min={2}
              max={120}
              value={f.cadenceEvery}
              onChange={(e) => set("cadenceEvery", Number(e.target.value) || 2)}
              className={`${FIELD} num mt-2`}
            />
          )}
        </div>
      )}

      {needsDate && (
        <div>
          <label htmlFor={`${id}-date`} className="mb-1 block text-[13px] text-ink-2">
            {f.type === "balance_by_date" ? "By" : "Next due"}
          </label>
          <input id={`${id}-date`} type="date" value={f.targetDate ?? ""} onChange={(e) => set("targetDate", e.target.value || null)} className={FIELD} />
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="primary" onClick={save} busy={pending}>
          Save target
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {category.target && (
          <>
            <Button variant="secondary" onClick={() => snooze(!category.target!.snoozed)} disabled={pending}>
              {category.target.snoozed ? "Un-snooze" : "Snooze this month"}
            </Button>
            <Button variant="danger" onClick={remove} disabled={pending}>
              Remove
            </Button>
          </>
        )}
      </div>
      <p className="text-[12px] text-ink-3">Changes apply from this month on; earlier months keep the target they had.</p>
    </div>
  );
}
