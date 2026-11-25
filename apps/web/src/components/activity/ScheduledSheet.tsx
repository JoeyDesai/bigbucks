"use client";
import { useState, useTransition } from "react";
import { ChevronRight, Repeat } from "lucide-react";
import { FREQUENCIES, type Frequency, today as localToday } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { formatDay } from "@/lib/format";
import type { AccountVM, CategoryOption, SplitLineVM } from "@/lib/view-models";
import type { PayeeOption, ScheduledVM } from "@/server/queries/scheduled";
import { deleteScheduledAction, saveScheduledAction } from "@/server/actions/transactions";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { CategoryPicker } from "./CategoryPicker";
import { FlagMark, FlagPicker, type FlagColor } from "./FlagPicker";
import { PayeeInput } from "./PayeeInput";
import { SplitEditor, splitRemaining } from "./SplitEditor";

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  once: "Once",
  daily: "Every day",
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  twice_monthly: "Twice a month",
  every_4_weeks: "Every 4 weeks",
  monthly: "Every month",
  every_other_month: "Every other month",
  every_3_months: "Every 3 months",
  every_4_months: "Every 4 months",
  twice_yearly: "Twice a year",
  yearly: "Every year",
  every_other_year: "Every other year",
};

const FIELD = "h-11 w-full rounded-lg border border-rule-strong bg-paper-raised px-3 text-[15px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]";
let seq = 0;

/** Upcoming scheduled transactions (§6.8): next date, payee, cadence, amount. Tap to edit. */
export function ScheduledList({ items, onOpen, className, empty }: { items: ScheduledVM[]; onOpen?: (s: ScheduledVM) => void; className?: string; empty?: string }) {
  if (!items.length) return empty ? <p className={cx("text-[14px] text-ink-3", className)}>{empty}</p> : null;
  return (
    <ul className={cx("border-t border-rule", className)}>
      {items.map((s) => (
        <li key={s.id} className="border-b border-rule">
          <button type="button" onClick={() => onOpen?.(s)} disabled={!onOpen} className="flex min-h-[56px] w-full items-center gap-3 py-2 text-left">
            <Repeat size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 truncate text-[15px] text-ink">
                {s.flag && <FlagMark flag={s.flag} />}
                {s.payeeName ?? "No payee"}
              </span>
              <span className="block truncate text-[12px] text-ink-3">
                {formatDay(s.nextDate)} · {FREQUENCY_LABEL[s.frequency]} · {s.splits.length ? "Split" : (s.categoryName ?? (s.transferAccountId ? "Transfer" : "No category"))} · {s.accountName}
              </span>
            </span>
            <Money value={s.amount} tone={s.amount > 0n ? "pos" : "ink"} className="text-[15px]" />
            {onOpen && <ChevronRight size={16} strokeWidth={1.75} aria-hidden className="text-ink-3" />}
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface ScheduledSheetProps {
  open: boolean;
  onClose: () => void;
  /** null = new. */
  item: ScheduledVM | null;
  accounts: AccountVM[];
  defaultAccountId?: string;
  categoryOptions: CategoryOption[];
  recentCategoryIds: string[];
  payees: PayeeOption[];
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}

export function ScheduledSheet(props: ScheduledSheetProps) {
  return <Form key={`${props.open}-${props.item?.id ?? "new"}`} {...props} />;
}

function Form({ open, onClose, item, accounts, defaultAccountId, categoryOptions, recentCategoryIds, payees, onSaved, onError }: ScheduledSheetProps) {
  const nameOf = (id: string | null) => categoryOptions.find((o) => o.id === id)?.name ?? null;
  const [accountId, setAccountId] = useState(item?.accountId ?? defaultAccountId ?? accounts.find((a) => a.onBudget)?.id ?? "");
  const [payee, setPayee] = useState(item?.payeeName ?? "");
  const [direction, setDirection] = useState<"out" | "in">(item && item.amount > 0n ? "in" : "out");
  const [amount, setAmount] = useState(item ? (item.amount < 0n ? -item.amount : item.amount) : 0n);
  const [frequency, setFrequency] = useState<Frequency>(item?.frequency ?? "monthly");
  const [date, setDate] = useState(item?.nextDate ?? localToday());
  const [endDate, setEndDate] = useState(item?.endDate ?? "");
  const [category, setCategory] = useState<{ id: string; name: string } | null>(item?.categoryId ? { id: item.categoryId, name: item.categoryName ?? nameOf(item.categoryId) ?? "" } : null);
  const [splitting, setSplitting] = useState(!!item?.splits.length);
  const [lines, setLines] = useState<SplitLineVM[]>(item?.splits.map((l) => ({ id: `s${++seq}`, categoryId: l.categoryId, categoryName: nameOf(l.categoryId), amount: l.amount, memo: l.memo ?? undefined })) ?? []);
  const [memo, setMemo] = useState(item?.memo ?? "");
  const [flag, setFlag] = useState<FlagColor | null>(item?.flag ?? null);
  const [view, setView] = useState<"form" | "pick" | "pick-line">("form");
  const [pickLine, setPickLine] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const signed = direction === "out" ? -amount : amount;
  const splitOk = !splitting || (lines.length >= 2 && splitRemaining(signed, lines) === 0n);

  const save = () =>
    start(async () => {
      if (amount === 0n) return onError("Enter an amount.");
      const r = await saveScheduledAction(item?.id ?? null, {
        accountId,
        date,
        frequency,
        amount: signed,
        payeeName: payee || null,
        categoryId: splitting ? null : (category?.id ?? null),
        memo: memo || null,
        flag,
        endDate: endDate || null,
        splits: splitting ? lines.map((l) => ({ categoryId: l.categoryId, amount: l.amount, memo: l.memo ?? null })) : undefined,
      });
      if (!r.ok) return onError(r.error);
      onSaved(item ? `Updated the schedule for ${payee || "this transaction"}` : `Scheduled ${payee || "a transaction"} · ${FREQUENCY_LABEL[frequency].toLowerCase()}`);
      onClose();
    });

  const remove = () =>
    start(async () => {
      if (!item) return;
      const r = await deleteScheduledAction(item.id);
      if (!r.ok) return onError(r.error);
      onSaved(`Deleted the schedule for ${item.payeeName ?? "this transaction"}`);
      onClose();
    });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={view === "form" ? (item ? "Edit scheduled" : "New scheduled transaction") : "Choose category"}
      tall
      footer={
        view === "form" ? (
          <div className="flex gap-2">
            {item && (
              <Button variant="danger" onClick={remove} disabled={pending}>
                Delete
              </Button>
            )}
            <Button variant="primary" className="flex-1" busy={pending} onClick={save} disabled={!splitOk || amount === 0n || !accountId}>
              {item ? "Save" : "Schedule"}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" className="w-full" onClick={() => setView("form")}>
            Back
          </Button>
        )
      }
    >
      {view !== "form" ? (
        <CategoryPicker
          autoFocus
          options={categoryOptions}
          recentIds={recentCategoryIds}
          onSelect={(o) => {
            if (view === "pick") setCategory({ id: o.id, name: o.name });
            else setLines((ls) => ls.map((l) => (l.id === pickLine ? { ...l, categoryId: o.id, categoryName: o.name } : l)));
            setView("form");
          }}
        />
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="st-account" className="mb-1 block text-[13px] text-ink-2">
              Account
            </label>
            <select id="st-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={FIELD}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <SegmentedControl label="Direction" block value={direction} onChange={setDirection} options={[{ value: "out", label: "Outflow" }, { value: "in", label: "Inflow" }]} />
          <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-3">
            <div>
              <label htmlFor="st-payee" className="mb-1 block text-[13px] text-ink-2">
                Payee
              </label>
              <PayeeInput
                id="st-payee"
                value={payee}
                onChange={setPayee}
                payees={payees}
                onPick={(p) => !category && !splitting && p.defaultCategoryId && setCategory({ id: p.defaultCategoryId, name: p.defaultCategoryName ?? "" })}
                className={FIELD}
              />
            </div>
            <AmountInput tapToEdit={false} hideLabel={false} allowNegative={false} label="Amount" value={amount} onCommit={setAmount} className="w-full" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="st-freq" className="mb-1 block text-[13px] text-ink-2">
                Repeats
              </label>
              <select id="st-freq" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} className={FIELD}>
                {FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABEL[f]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="st-date" className="mb-1 block text-[13px] text-ink-2">
                Next date
              </label>
              <input id="st-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={FIELD} />
            </div>
          </div>
          {frequency !== "once" && (
            <div>
              <label htmlFor="st-end" className="mb-1 block text-[13px] text-ink-2">
                Ends (optional)
              </label>
              <input id="st-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={FIELD} />
            </div>
          )}
          {splitting ? (
            <div>
              <SplitEditor
                total={signed}
                lines={lines}
                onChange={setLines}
                onPickCategory={(id) => {
                  setPickLine(id);
                  setView("pick-line");
                }}
                newLineId={() => `s${++seq}`}
              />
              <button type="button" onClick={() => setSplitting(false)} className="mt-1 min-h-11 text-[13px] text-ink-3 underline-offset-4 hover:underline">
                Don’t split
              </button>
            </div>
          ) : (
            <div>
              <span className="mb-1 block text-[13px] text-ink-2">Category</span>
              <button type="button" onClick={() => setView("pick")} className={cx(FIELD, "flex items-center justify-between text-left", !category && "text-ink-3")}>
                <span className="truncate">{category?.name ?? "Choose a category"}</span>
                <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
              </button>
              <button
                type="button"
                disabled={amount === 0n}
                onClick={() => {
                  setSplitting(true);
                  if (lines.length < 2) setLines([{ id: `s${++seq}`, categoryId: category?.id ?? null, categoryName: category?.name ?? null, amount: signed }, { id: `s${++seq}`, categoryId: null, categoryName: null, amount: 0n }]);
                }}
                className="mt-1 min-h-11 text-[13px] text-accent disabled:opacity-40"
              >
                Split
              </button>
            </div>
          )}
          <div>
            <label htmlFor="st-memo" className="mb-1 block text-[13px] text-ink-2">
              Memo
            </label>
            <input id="st-memo" value={memo} onChange={(e) => setMemo(e.target.value)} className={FIELD} />
          </div>
          <div>
            <span className="mb-1 block text-[13px] text-ink-2">Flag</span>
            <FlagPicker value={flag} onChange={setFlag} />
          </div>
          <p className="text-[12px] text-ink-3">Each occurrence is entered on its date as an uncleared, unapproved transaction and matched to the bank’s copy when it syncs.</p>
        </div>
      )}
    </Sheet>
  );
}
