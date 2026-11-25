"use client";
import { BRAND } from "@/lib/brand";
import { useState, useTransition } from "react";
import { ACCOUNT_KINDS, type AccountKind } from "@homebase/shared";
import { formatDay } from "@/lib/format";
import type { AccountVM } from "@/lib/view-models";
import type { InboxEntryVM } from "@/server/queries/inbox";
import { linkInboxAccountAction, setupInboxAccountAction } from "@/server/actions/accounts";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

const FIELD = "h-11 w-full rounded-lg border border-rule-strong bg-paper-raised px-3 text-[15px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]";
const KIND_LABEL: Record<AccountKind, string> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit_card: "Credit card",
  line_of_credit: "Line of credit",
  brokerage: "Brokerage",
  retirement: "Retirement",
  hsa: "HSA",
  crypto: "Crypto",
  mortgage: "Mortgage",
  loan: "Loan",
  property: "Property",
  other: "Other",
};
const BUDGET_KINDS: AccountKind[] = ["checking", "savings", "cash", "credit_card"];

/** Admin: accounts a sync found that need a decision (§12.6 new-account inbox). */
export function AccountInbox({ entries, accounts, entities }: { entries: InboxEntryVM[]; accounts: AccountVM[]; entities: { id: string; name: string }[] }) {
  const [open, setOpen] = useState<InboxEntryVM | null>(null);
  if (!entries.length) return null;
  return (
    <section aria-labelledby="inbox-h" className="mb-10 border-l-[3px] border-accent pl-4 lg:max-w-[760px]">
      <h2 id="inbox-h" className="display text-[20px] leading-tight">
        New accounts <span className="num ml-1 text-[15px] text-ink-3">{entries.length}</span>
      </h2>
      <p className="mt-1 text-[13px] text-ink-2">A sync found accounts {BRAND.name} hasn’t seen. They stay off budget until you decide.</p>
      <ul className="mt-3 border-t border-rule">
        {entries.map((e) => (
          <li key={`${e.connectionId}:${e.externalId}`} className="flex min-h-[60px] items-center gap-3 border-b border-rule py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px]">{e.name}</span>
              <span className="block truncate text-[12px] text-ink-3">
                {e.institution ?? e.connectionLabel} · {KIND_LABEL[e.kindGuess as AccountKind] ?? e.kindGuess} · found {formatDay(e.detectedAt.slice(0, 10))}
              </span>
            </span>
            {e.balance !== null && <Money value={e.balance} tone={e.balance < 0n ? "neg" : "ink"} />}
            <Button size="sm" onClick={() => setOpen(e)}>
              Set up
            </Button>
          </li>
        ))}
      </ul>
      <InboxSheet entry={open} onClose={() => setOpen(null)} accounts={accounts.filter((a) => !entries.some((e) => e.accountId === a.id))} entities={entities} />
    </section>
  );
}

function InboxSheet({ entry, onClose, accounts, entities }: { entry: InboxEntryVM | null; onClose: () => void; accounts: AccountVM[]; entities: { id: string; name: string }[] }) {
  return <InboxForm key={entry ? `${entry.connectionId}:${entry.externalId}` : "none"} entry={entry} onClose={onClose} accounts={accounts} entities={entities} />;
}

function InboxForm({ entry, onClose, accounts, entities }: { entry: InboxEntryVM | null; onClose: () => void; accounts: AccountVM[]; entities: { id: string; name: string }[] }) {
  const toast = useToast();
  const [mode, setMode] = useState<"new" | "link">("new");
  const guess = (entry?.kindGuess as AccountKind) ?? "checking";
  const [name, setName] = useState(entry?.name ?? "");
  const [kind, setKind] = useState<AccountKind>(ACCOUNT_KINDS.includes(guess) ? guess : "other");
  const [onBudget, setOnBudget] = useState(BUDGET_KINDS.includes(guess));
  const [entityId, setEntityId] = useState(entities[0]?.id ?? "");
  const [sign, setSign] = useState<"normal" | "inverted">("normal");
  const [target, setTarget] = useState(accounts[0]?.id ?? "");
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      if (!entry) return;
      const r =
        mode === "new"
          ? await setupInboxAccountAction({ connectionId: entry.connectionId, accountId: entry.accountId, externalId: entry.externalId, name, kind, onBudget, entityId, balanceSign: sign })
          : await linkInboxAccountAction({ connectionId: entry.connectionId, accountId: entry.accountId, externalId: entry.externalId, targetAccountId: target });
      if (!r.ok) return void toast.show({ message: r.error, tone: "error" });
      toast.show({ message: mode === "new" ? `${name} is set up${onBudget ? " on budget" : ""}` : "Linked. The next sync fills in the existing account." });
      onClose();
    });

  return (
    <Sheet
      open={!!entry}
      onClose={onClose}
      title={entry?.name ?? ""}
      description={entry ? `${entry.institution ?? entry.connectionLabel}` : undefined}
      footer={
        <Button variant="primary" className="w-full" onClick={submit} busy={pending} disabled={mode === "new" ? !name.trim() : !target}>
          {mode === "new" ? "Save account" : "Link account"}
        </Button>
      }
    >
      <SegmentedControl
        label="How to set up"
        block
        value={mode}
        onChange={setMode}
        options={[
          { value: "new", label: "New account" },
          { value: "link", label: "Same as an existing one" },
        ]}
      />
      {mode === "new" ? (
        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor="ib-name" className="mb-1 block text-[13px] text-ink-2">
              Name
            </label>
            <input id="ib-name" value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
          </div>
          <div>
            <label htmlFor="ib-kind" className="mb-1 block text-[13px] text-ink-2">
              Kind
            </label>
            <select
              id="ib-kind"
              value={kind}
              onChange={(e) => {
                const k = e.target.value as AccountKind;
                setKind(k);
                if (!BUDGET_KINDS.includes(k)) setOnBudget(false);
              }}
              className={FIELD}
            >
              {ACCOUNT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ib-entity" className="mb-1 block text-[13px] text-ink-2">
              Belongs to
            </label>
            <select
              id="ib-entity"
              value={entityId}
              onChange={(e) => {
                setEntityId(e.target.value);
                if (e.target.value !== entities[0]?.id) setOnBudget(false);
              }}
              className={FIELD}
            >
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex min-h-11 items-center gap-3 text-[15px]">
            <input type="checkbox" checked={onBudget} disabled={!BUDGET_KINDS.includes(kind) || entityId !== entities[0]?.id} onChange={(e) => setOnBudget(e.target.checked)} className="h-5 w-5 accent-[var(--pos)]" />
            On budget
            <span className="text-[12px] text-ink-3">(its money counts toward Ready to Assign)</span>
          </label>
          <div>
            <span className="mb-1 block text-[13px] text-ink-2">Balance sign</span>
            <SegmentedControl
              label="Balance sign"
              size="sm"
              value={sign}
              onChange={setSign}
              options={[
                { value: "normal", label: "As reported" },
                { value: "inverted", label: "Flip sign" },
              ]}
            />
            <p className="mt-1 text-[12px] text-ink-3">Flip it if a card or loan shows what you owe as a positive number.</p>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-2">
          <label htmlFor="ib-target" className="block text-[13px] text-ink-2">
            Existing account
          </label>
          <select id="ib-target" value={target} onChange={(e) => setTarget(e.target.value)} className={FIELD}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.institution}
              </option>
            ))}
          </select>
          <p className="text-[12px] text-ink-3">
            For an account already in {BRAND.name}, for example one imported from YNAB. The duplicate this sync created is removed, and the next sync attaches to the account you pick and matches its existing transactions.
          </p>
        </div>
      )}
    </Sheet>
  );
}
