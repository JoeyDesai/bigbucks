"use client";
import { BRAND } from "@/lib/brand";
import { useState, useTransition } from "react";
import { formatMilli } from "@homebase/shared";
import { reconcileAction } from "@/server/actions/transactions";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { Sheet } from "@/components/ui/Sheet";

export interface ReconcileSheetProps {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountName: string;
  clearedBalance: bigint;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * Reconcile (§6.8): confirm the cleared balance matches the bank, or enter the statement balance and
 * let Homebase add an adjustment. Cleared rows are then locked as reconciled.
 */
export function ReconcileSheet(props: ReconcileSheetProps) {
  return <Inner key={String(props.open)} {...props} />;
}

function Inner({ open, onClose, accountId, accountName, clearedBalance, onDone, onError }: ReconcileSheetProps) {
  const [step, setStep] = useState<"ask" | "enter">("ask");
  const [statement, setStatement] = useState(clearedBalance);
  const [pending, start] = useTransition();
  const diff = statement - clearedBalance;

  const finish = (balance: bigint) =>
    start(async () => {
      const r = await reconcileAction({ accountId, statementBalance: balance });
      if (!r.ok) return onError(r.error);
      onDone(
        r.difference === 0n
          ? `${accountName} reconciled · ${r.reconciledCount} transactions locked`
          : `${accountName} reconciled with a ${formatMilli(r.difference, { sign: "always" })} adjustment`,
      );
      onClose();
    });

  return (
    <Sheet open={open} onClose={onClose} title={`Reconcile ${accountName}`}>
      {step === "ask" ? (
        <div>
          <p className="text-[15px] text-ink-2">Is your bank’s cleared balance</p>
          <Money value={clearedBalance} display tone={clearedBalance < 0n ? "neg" : "ink"} className="mt-1 block text-[36px] leading-none" />
          <div className="mt-6 flex gap-2">
            <Button variant="primary" className="flex-1" busy={pending} onClick={() => finish(clearedBalance)}>
              Yes, it matches
            </Button>
            <Button variant="secondary" className="flex-1" disabled={pending} onClick={() => setStep("enter")}>
              No
            </Button>
          </div>
          <p className="mt-4 text-[12px] text-ink-3">Reconciling locks every cleared transaction so later edits can’t quietly change a balance you already checked.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <AmountInput tapToEdit={false} hideLabel={false} label="Statement (cleared) balance" value={statement} onCommit={setStatement} className="w-full" />
          <dl className="border-t border-rule text-[14px]">
            <div className="flex justify-between border-b border-rule py-2">
              <dt className="text-ink-2">Cleared in {BRAND.name}</dt>
              <dd>
                <Money value={clearedBalance} />
              </dd>
            </div>
            <div className="flex justify-between border-b border-rule py-2">
              <dt className="text-ink-2">Difference</dt>
              <dd>
                <Money value={diff} tone={diff === 0n ? "zero" : "warn"} sign="always" />
              </dd>
            </div>
          </dl>
          <p className="text-[13px] text-ink-2">
            {diff === 0n
              ? "Balances match. Nothing to adjust."
              : `First look for a missing or uncleared transaction. If you can't find it, ${BRAND.name} adds a ${formatMilli(diff, { sign: "always" })} "Reconciliation Balance Adjustment".`}
          </p>
          <Button variant="primary" className="w-full" busy={pending} onClick={() => finish(statement)}>
            {diff === 0n ? "Reconcile" : "Add adjustment and reconcile"}
          </Button>
        </div>
      )}
    </Sheet>
  );
}
