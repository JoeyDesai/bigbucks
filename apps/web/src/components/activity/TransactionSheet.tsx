"use client";
import { useState, useTransition } from "react";
import { ArrowLeftRight, ChevronRight, Split, Trash2 } from "lucide-react";
import { formatMilli, today as localToday } from "@homebase/shared";
import { cx } from "@/lib/cx";
import type { AccountVM, CategoryOption, SplitLineVM, TransactionVM } from "@/lib/view-models";
import { createTransactionAction, deleteTransactionsAction, markTransferAction, splitAction, updateTransactionAction } from "@/server/actions/transactions";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import type { PayeeOption } from "@/server/queries/scheduled";
import { CategoryPicker } from "./CategoryPicker";
import { FlagPicker, type FlagColor } from "./FlagPicker";
import { PayeeInput } from "./PayeeInput";
import { SplitEditor, splitRemaining } from "./SplitEditor";

export interface TransactionSheetProps {
  open: boolean;
  onClose: () => void;
  /** null = new manual transaction. */
  tx: TransactionVM | null;
  accounts: AccountVM[];
  defaultAccountId?: string;
  categoryOptions: CategoryOption[];
  recentCategoryIds: string[];
  /** Known payees for autocomplete. */
  payees?: PayeeOption[];
  /** Called after a successful save with a message and an optional undo. */
  onSaved: (message: string, undo?: () => Promise<void>) => void;
  onError: (message: string) => void;
  /** Open straight into the split editor (Transactions tab "S") or the transfer picker ("T"). */
  initialMode?: "split" | "transfer";
}

type View = "form" | "pick" | "pick-line" | "transfer";
const FIELD = "h-11 w-full rounded-lg border border-rule-strong bg-paper-raised px-3 text-[15px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]";
let lineSeq = 0;
const newLine = (amount: bigint): SplitLineVM => ({ id: `n${++lineSeq}`, categoryId: null, categoryName: null, amount });

/** Add or edit a transaction (spec §12.2): account, date, payee, amount, category or split, memo, cleared. */
export function TransactionSheet(props: TransactionSheetProps) {
  // Remount the form for each transaction so its state starts fresh.
  return <Inner key={`${props.open}-${props.tx?.id ?? "new"}`} {...props} />;
}

function Inner({ open, onClose, tx, accounts, defaultAccountId, categoryOptions, recentCategoryIds, payees = [], onSaved, onError, initialMode }: TransactionSheetProps) {
  const isNew = tx === null;
  const budgetAccounts = accounts.filter((a) => a.onBudget);
  const [accountId, setAccountId] = useState(tx?.accountId ?? defaultAccountId ?? budgetAccounts[0]?.id ?? accounts[0]?.id ?? "");
  const [date, setDate] = useState(tx?.date ?? localToday());
  const [payee, setPayee] = useState(tx?.payee ?? "");
  const [direction, setDirection] = useState<"out" | "in">(tx && tx.amount > 0n ? "in" : "out");
  const [amount, setAmount] = useState<bigint>(tx ? (tx.amount < 0n ? -tx.amount : tx.amount) : 0n);
  const [category, setCategory] = useState<{ id: string; name: string } | null>(tx?.categoryId && !tx.splits ? { id: tx.categoryId, name: tx.categoryName ?? "" } : null);
  const startsSplit = !!tx?.splits?.length || (initialMode === "split" && !!tx && !tx.transferAccountName);
  const [splitting, setSplitting] = useState(startsSplit);
  const [lines, setLines] = useState<SplitLineVM[]>(() =>
    tx?.splits?.length ? tx.splits : startsSplit && tx ? [{ ...newLine(tx.amount), categoryId: tx.categoryId, categoryName: tx.categoryName }, newLine(0n)] : [],
  );
  const [pickLine, setPickLine] = useState<string | null>(null);
  const [memo, setMemo] = useState(tx?.memo ?? "");
  const [cleared, setCleared] = useState(tx ? tx.cleared === "cleared" || tx.cleared === "reconciled" : false);
  const [flag, setFlag] = useState<FlagColor | null>(tx?.flag ?? null);
  const [view, setView] = useState<View>(initialMode === "transfer" && tx && !tx.transferAccountName ? "transfer" : "form");
  const [pending, start] = useTransition();

  const signed = direction === "out" ? -amount : amount;
  const isTransfer = !!tx?.transferAccountName;
  const reconciled = tx?.cleared === "reconciled";
  const splitOk = !splitting || (lines.length >= 2 && splitRemaining(signed, lines) === 0n);

  function startSplit() {
    setSplitting(true);
    if (lines.length < 2) setLines([{ ...newLine(signed), categoryId: category?.id ?? null, categoryName: category?.name ?? null }, newLine(0n)]);
  }

  function save() {
    if (amount === 0n) return onError("Enter an amount.");
    if (!splitOk) return onError("Split lines must add up to the amount.");
    start(async () => {
      if (isNew) {
        const r = await createTransactionAction({
          accountId,
          date,
          amount: signed,
          payeeName: payee || undefined,
          categoryId: splitting ? null : (category?.id ?? null),
          memo: memo || undefined,
          cleared: cleared ? "cleared" : "uncleared",
          flag,
          splits: splitting ? lines.map((l) => ({ categoryId: l.categoryId, amount: l.amount, memo: l.memo })) : undefined,
        });
        if (!r.ok) return onError(r.error);
        onSaved(`Added ${payee || "transaction"} ${formatMilli(signed)}`, async () => {
          await deleteTransactionsAction([r.id]);
        });
        return onClose();
      }
      const t = tx!;
      const patch: Parameters<typeof updateTransactionAction>[1] = {};
      if (date !== t.date) patch.date = date;
      if (!reconciled && signed !== t.amount) patch.amount = signed;
      if (payee !== t.payee) patch.payeeName = payee || null;
      if ((memo || "") !== (t.memo ?? "")) patch.memo = memo || null;
      if (!reconciled && cleared !== (t.cleared === "cleared")) patch.cleared = cleared ? "cleared" : "uncleared";
      if (!splitting && !isTransfer && (category?.id ?? null) !== (t.splits ? null : t.categoryId)) patch.categoryId = category?.id ?? null;
      if (flag !== (t.flag ?? null)) patch.flag = flag;
      if (!t.approved) patch.approved = true;
      if (Object.keys(patch).length) {
        const r = await updateTransactionAction(t.id, patch);
        if (!r.ok) return onError(r.error);
      }
      if (splitting) {
        const r = await splitAction({ id: t.id, lines: lines.map((l) => ({ categoryId: l.categoryId, amount: l.amount, memo: l.memo })), approve: true });
        if (!r.ok) return onError(r.error);
      }
      onSaved(`Saved ${payee || "transaction"}`, async () => {
        await updateTransactionAction(t.id, { categoryId: t.splits ? null : t.categoryId, memo: t.memo ?? null, approved: t.approved, ...(reconciled ? {} : { amount: t.amount }), date: t.date });
      });
      onClose();
    });
  }

  function remove() {
    if (!tx) return;
    start(async () => {
      const r = await deleteTransactionsAction([tx.id]);
      if (!r.ok) return onError(r.error);
      onSaved(`Deleted ${tx.payee}`);
      onClose();
    });
  }

  function transferTo(account: AccountVM) {
    if (!tx) return;
    start(async () => {
      const r = await markTransferAction({ id: tx.id, accountId: account.id });
      if (!r.ok) return onError(r.error);
      onSaved(`${tx.payee} is now a transfer with ${account.name}`);
      onClose();
    });
  }

  const title = view === "transfer" ? "Transfer with…" : view === "pick" || view === "pick-line" ? "Choose category" : isNew ? "New transaction" : tx!.payee;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={view === "form" && !isNew ? `${tx!.accountName}${reconciled ? " · reconciled" : ""}` : undefined}
      tall
      footer={
        view === "form" ? (
          <div className="flex gap-2">
            {!isNew && (
              <Button variant="danger" icon={<Trash2 size={16} strokeWidth={1.75} />} onClick={remove} disabled={pending || reconciled} aria-label="Delete transaction" className="px-3">
                <span className="sr-only">Delete</span>
              </Button>
            )}
            <Button variant="primary" className="flex-1" onClick={save} busy={pending} disabled={!splitOk || amount === 0n || !accountId}>
              {isNew ? "Add transaction" : "Save"}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" className="w-full" onClick={() => setView("form")}>
            Back
          </Button>
        )
      }
    >
      {view === "pick" && (
        <CategoryPicker
          autoFocus
          options={categoryOptions}
          recentIds={recentCategoryIds}
          value={category?.id}
          onSelect={(o) => {
            setCategory({ id: o.id, name: o.name });
            setView("form");
          }}
        />
      )}
      {view === "pick-line" && (
        <CategoryPicker
          autoFocus
          options={categoryOptions}
          recentIds={recentCategoryIds}
          onSelect={(o) => {
            setLines((ls) => ls.map((l) => (l.id === pickLine ? { ...l, categoryId: o.id, categoryName: o.name } : l)));
            setView("form");
          }}
        />
      )}
      {view === "transfer" && (
        <ul className="border-t border-rule">
          {accounts
            .filter((a) => a.id !== tx?.accountId)
            .map((a) => (
              <li key={a.id} className="border-b border-rule">
                <button type="button" disabled={pending} onClick={() => transferTo(a)} className="flex min-h-[52px] w-full items-center justify-between text-left text-[15px]">
                  <span>
                    {a.name}
                    <span className="block text-[12px] text-ink-3">{a.onBudget ? "Budget account" : "Tracking account"}</span>
                  </span>
                  <ChevronRight size={16} strokeWidth={1.75} className="text-ink-3" aria-hidden />
                </button>
              </li>
            ))}
        </ul>
      )}
      {view === "form" && (
        <div className="space-y-4">
          {isNew ? (
            <div>
              <label htmlFor="tx-account" className="mb-1 block text-[13px] text-ink-2">
                Account
              </label>
              <select id="tx-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={FIELD}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.onBudget ? "" : " (tracking)"}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <SegmentedControl
            label="Direction"
            block
            value={direction}
            onChange={setDirection}
            options={[
              { value: "out", label: "Outflow", disabled: reconciled },
              { value: "in", label: "Inflow", disabled: reconciled },
            ]}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-3">
            <div>
              <label htmlFor="tx-payee" className="mb-1 block text-[13px] text-ink-2">
                Payee
              </label>
              <PayeeInput
                id="tx-payee"
                value={payee}
                onChange={setPayee}
                payees={payees}
                onPick={(p) => {
                  if (!category && !splitting && p.defaultCategoryId) setCategory({ id: p.defaultCategoryId, name: p.defaultCategoryName ?? "" });
                }}
                className={FIELD}
              />
            </div>
            <AmountInput tapToEdit={false} hideLabel={false} allowNegative={false} label="Amount" value={amount} onCommit={setAmount} className={cx("w-full", reconciled && "pointer-events-none opacity-60")} />
          </div>
          <div>
            <label htmlFor="tx-date" className="mb-1 block text-[13px] text-ink-2">
              Date
            </label>
            <input id="tx-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={FIELD} />
          </div>

          {isTransfer ? (
            <p className="text-[14px] text-ink-2">Transfer with {tx!.transferAccountName}</p>
          ) : splitting ? (
            <div>
              <SplitEditor
                total={signed}
                lines={lines}
                onChange={setLines}
                onPickCategory={(id) => {
                  setPickLine(id);
                  setView("pick-line");
                }}
                newLineId={() => `n${++lineSeq}`}
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
              <div className="mt-1 flex gap-4">
                <button type="button" onClick={startSplit} disabled={amount === 0n} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-accent disabled:opacity-40">
                  <Split size={15} strokeWidth={1.75} aria-hidden /> Split
                </button>
                {!isNew && (
                  <button type="button" onClick={() => setView("transfer")} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-accent">
                    <ArrowLeftRight size={15} strokeWidth={1.75} aria-hidden /> Mark as transfer
                  </button>
                )}
              </div>
            </div>
          )}

          <div>
            <label htmlFor="tx-memo" className="mb-1 block text-[13px] text-ink-2">
              Memo
            </label>
            <input id="tx-memo" value={memo} onChange={(e) => setMemo(e.target.value)} className={FIELD} />
          </div>
          <div>
            <span className="mb-1 block text-[13px] text-ink-2">Flag</span>
            <FlagPicker value={flag} onChange={setFlag} />
          </div>
          <label className="flex min-h-11 items-center gap-3 text-[15px]">
            <input type="checkbox" checked={cleared} disabled={reconciled} onChange={(e) => setCleared(e.target.checked)} className="h-5 w-5 accent-[var(--pos)]" />
            Cleared
          </label>
          {tx?.rawDescription && <p className="font-mono text-[11px] text-ink-3">Bank text: {tx.rawDescription}</p>}
        </div>
      )}
    </Sheet>
  );
}
