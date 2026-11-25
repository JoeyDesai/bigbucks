"use client";
import { useState, useTransition } from "react";
import { ChevronRight } from "lucide-react";
import { formatMilli, parseMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { updateAccountAction } from "@/server/settings/actions/household";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { TextArea, TextField, ToggleRow } from "./fields";

export interface AccountItem {
  id: string;
  name: string;
  nickname: string | null;
  institution: string | null;
  kind: string;
  kindLabel: string;
  onBudget: boolean;
  closed: boolean;
  entityName: string;
  balance: string;
  statementDueDay: number | null;
  monthlyContribution: string | null;
  note: string | null;
  source: string;
}

const CREDIT = new Set(["credit_card", "line_of_credit"]);
const INVEST = new Set(["brokerage", "retirement", "hsa", "crypto"]);

function EditForm({ a, onDone }: { a: AccountItem; onDone: () => void }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [f, setF] = useState({
    name: a.name,
    nickname: a.nickname ?? "",
    institution: a.institution ?? "",
    due: a.statementDueDay ? String(a.statementDueDay) : "",
    contribution: a.monthlyContribution ? formatMilli(BigInt(a.monthlyContribution), { sign: "never" }).replace("$", "") : "",
    note: a.note ?? "",
    closed: a.closed,
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  function save() {
    setErr(null);
    let contribution: string | null = null;
    if (f.contribution.trim()) {
      try {
        contribution = parseMilli(f.contribution.replace(/[$,\s]/g, "")).toString();
        if (contribution.startsWith("-")) throw new Error();
      } catch {
        setErr("Monthly contribution must be a dollar amount.");
        return;
      }
    }
    const due = f.due.trim() ? Number(f.due) : null;
    if (due !== null && !(Number.isInteger(due) && due >= 1 && due <= 31)) {
      setErr("Statement due day is 1–31.");
      return;
    }
    start(async () => {
      const r = await updateAccountAction(a.id, {
        name: f.name,
        nickname: f.nickname.trim() || null,
        institution: f.institution.trim() || null,
        note: f.note.trim() || null,
        closed: f.closed,
        ...(CREDIT.has(a.kind) ? { statementDueDay: due } : {}),
        ...(INVEST.has(a.kind) ? { monthlyContribution: contribution } : {}),
      });
      if (r.ok) {
        toast.show({ message: `Saved ${f.nickname.trim() || f.name}` });
        onDone();
      } else setErr(r.error);
    });
  }

  return (
    <div className="space-y-4">
      <TextField label="Name" value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={100} />
      <TextField label="Nickname" hint="Shown instead of the bank's name, e.g. “Work 401k”." value={f.nickname} onChange={(e) => set("nickname", e.target.value)} maxLength={100} />
      <TextField label="Institution" value={f.institution} onChange={(e) => set("institution", e.target.value)} maxLength={100} />
      {CREDIT.has(a.kind) && <TextField label="Statement due day" hint="Used for the card-payment-due alert when the bank doesn't send a due date." inputMode="numeric" value={f.due} onChange={(e) => set("due", e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="e.g. 14" />}
      {INVEST.has(a.kind) && <TextField label="Monthly contribution ($)" hint="Separates contributions from market change in investment growth." inputMode="decimal" value={f.contribution} onChange={(e) => set("contribution", e.target.value)} placeholder="0.00" />}
      <TextArea label="Note" value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={1000} />
      <div className="border-t border-rule">
        <ToggleRow label="Closed" description="Closed accounts are hidden from lists and syncs. Their history stays." checked={f.closed} onChange={(v) => set("closed", v)} />
      </div>
      {err && (
        <p role="alert" className="text-[13px] text-neg">
          {err}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} busy={pending}>
          Save
        </Button>
      </div>
    </div>
  );
}

export function AccountsEditor({ accounts }: { accounts: AccountItem[] }) {
  const [open, setOpen] = useState<AccountItem | null>(null);
  const groups = [
    { label: "On budget", items: accounts.filter((a) => !a.closed && a.onBudget) },
    { label: "Tracking", items: accounts.filter((a) => !a.closed && !a.onBudget) },
    { label: "Closed", items: accounts.filter((a) => a.closed) },
  ].filter((g) => g.items.length);
  return (
    <>
      <div className="space-y-8">
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h2 className="eyebrow mb-1">{g.label}</h2>
            <ul className="border-t border-rule">
              {g.items.map((a) => (
                <li key={a.id} className="border-b border-rule">
                  <button type="button" onClick={() => setOpen(a)} className="group flex min-h-[60px] w-full items-center gap-3 py-2.5 text-left">
                    <span className="min-w-0 flex-1">
                      <span className={cx("block truncate text-[15px]", a.closed ? "text-ink-3" : "text-ink")}>{a.nickname || a.name}</span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {a.kindLabel} · {a.entityName}
                        {a.nickname ? ` · ${a.name}` : ""}
                        {a.statementDueDay ? ` · due day ${a.statementDueDay}` : ""}
                      </span>
                    </span>
                    <span className="num shrink-0 text-[14px]">{formatMilli(BigInt(a.balance))}</span>
                    <ChevronRight size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open ? open.nickname || open.name : "Account"} description={open ? `${open.kindLabel} · ${open.onBudget ? "on budget" : "tracking"} · ${open.entityName}` : undefined}>
        {open && <EditForm key={open.id} a={open} onDone={() => setOpen(null)} />}
      </Sheet>
    </>
  );
}
