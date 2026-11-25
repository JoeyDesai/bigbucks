"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { ChevronRight, Search, Trash2 } from "lucide-react";
import {
  createAliasAction,
  deleteAliasAction,
  getPayeeDetailAction,
  mergePayeesAction,
  renamePayeeAction,
  setPayeeDefaultCategoryAction,
} from "@/server/settings/actions/household";
import { Button, IconButton } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { INPUT, SelectField, TextField } from "./fields";

export interface PayeeItem {
  id: string;
  name: string;
  defaultCategoryName: string | null;
  transactionCount: number;
  lastUsed: string | null;
  aliasCount: number;
  hasMerchant: boolean;
}
export interface CategoryChoice {
  id: string;
  label: string;
}

type Detail = {
  id: string;
  name: string;
  defaultCategoryId: string | null;
  merchant: { type: string; description: string; website: string | null; location: string | null; lookedUpAt: string; found: boolean } | null;
  aliases: { id: string; pattern: string; match: "exact" | "prefix" | "regex" }[];
};

function PayeeDetail({ payee, all, categories, onClose }: { payee: PayeeItem; all: PayeeItem[]; categories: CategoryChoice[]; onClose: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [name, setName] = useState(payee.name);
  const [mergeQuery, setMergeQuery] = useState("");
  const [mergeTarget, setMergeTarget] = useState<PayeeItem | null>(null);
  const [alias, setAlias] = useState("");
  const [aliasMatch, setAliasMatch] = useState<"exact" | "prefix" | "regex">("prefix");
  const [pending, start] = useTransition();

  const reload = () =>
    start(async () => {
      const r = await getPayeeDetailAction(payee.id);
      if (r.ok) setD(r.payee as Detail);
      else toast.show({ message: r.error, tone: "error" });
    });
  useEffect(reload, [payee.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (p: Promise<{ ok: true } | { ok: false; error: string }>, msg: string, after?: () => void) =>
    start(async () => {
      const r = await p;
      if (r.ok) {
        toast.show({ message: msg });
        after?.();
      } else toast.show({ message: r.error, tone: "error" });
    });

  const candidates = useMemo(() => {
    const q = mergeQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return all.filter((p) => p.id !== payee.id && p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [mergeQuery, all, payee.id]);

  if (!d) return <p className="text-[14px] text-ink-3">Loading…</p>;
  return (
    <div className="space-y-8">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== d.name) go(renamePayeeAction(d.id, name), "Renamed");
        }}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className="min-w-0 flex-1" />
        <Button type="submit" disabled={!name.trim() || name.trim() === d.name} busy={pending}>
          Rename
        </Button>
      </form>

      <SelectField
        label="Default category"
        hint="Used for new transactions from this payee when history isn't decisive."
        value={d.defaultCategoryId ?? ""}
        onChange={(e) => go(setPayeeDefaultCategoryAction(d.id, e.target.value || null), "Default category saved", reload)}
      >
        <option value="">None</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </SelectField>

      <section>
        <h3 className="eyebrow mb-2">Merchant profile</h3>
        {d.merchant ? (
          <dl className="border-t border-rule text-[14px]">
            {[
              ["What it is", d.merchant.found ? d.merchant.type : "Not identified"],
              ["Description", d.merchant.description],
              ["Location", d.merchant.location],
              ["Website", d.merchant.website],
              ["Looked up", new Date(d.merchant.lookedUpAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 border-b border-rule py-2">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="break-words text-ink">{v}</dd>
                </div>
              ))}
          </dl>
        ) : (
          <p className="border-t border-rule py-2 text-[13px] text-ink-3">No profile. Unfamiliar merchants are looked up once during categorization (when web lookup is on).</p>
        )}
      </section>

      <section>
        <h3 className="eyebrow mb-2">Aliases</h3>
        <p className="mb-2 text-[12px] text-ink-3">Bank descriptions that should map to this payee.</p>
        <ul className="border-t border-rule">
          {d.aliases.map((a) => (
            <li key={a.id} className="flex min-h-11 items-center gap-2 border-b border-rule">
              <span className="w-14 shrink-0 text-[12px] text-ink-3">{a.match}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{a.pattern}</span>
              <IconButton label={`Remove alias ${a.pattern}`} onClick={() => go(deleteAliasAction(a.id), "Alias removed", reload)}>
                <Trash2 size={15} strokeWidth={1.6} />
              </IconButton>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (alias.trim())
              go(createAliasAction(d.id, alias.trim(), aliasMatch), "Alias added", () => {
                setAlias("");
                reload();
              });
          }}
        >
          <select aria-label="Match type" value={aliasMatch} onChange={(e) => setAliasMatch(e.target.value as typeof aliasMatch)} className={`${INPUT} w-28 shrink-0`}>
            <option value="prefix">Starts with</option>
            <option value="exact">Exactly</option>
            <option value="regex">Regex</option>
          </select>
          <input aria-label="Alias pattern" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="e.g. LOWES #" className={INPUT} maxLength={300} />
          <Button type="submit" disabled={!alias.trim()}>
            Add
          </Button>
        </form>
      </section>

      <section>
        <h3 className="eyebrow mb-2">Merge into another payee</h3>
        <p className="mb-2 text-[12px] text-ink-3">Moves every transaction to the payee you pick and keeps this name as an alias.</p>
        <label className="relative block">
          <span className="sr-only">Find a payee</span>
          <Search size={15} strokeWidth={1.75} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <input value={mergeQuery} onChange={(e) => setMergeQuery(e.target.value)} placeholder="Type a payee name" className={`${INPUT} pl-9`} />
        </label>
        {candidates.length > 0 && (
          <ul className="mt-1 border-y border-rule">
            {candidates.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setMergeTarget(c)} className={`flex min-h-11 w-full items-center justify-between px-1 text-left text-[14px] hover:bg-paper-sunken ${mergeTarget?.id === c.id ? "font-medium" : ""}`}>
                  <span className="truncate">{c.name}</span>
                  <span className="num text-[12px] text-ink-3">{c.transactionCount}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mergeTarget && (
          <div className="mt-3 border-l-[3px] border-warn-bar pl-3">
            <p className="text-[14px]">
              Merge <strong>{d.name}</strong> into <strong>{mergeTarget.name}</strong>? {payee.transactionCount} transaction{payee.transactionCount === 1 ? "" : "s"} will move. This can&rsquo;t be undone.
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="danger" busy={pending} onClick={() => go(mergePayeesAction([d.id], mergeTarget.id), `Merged into ${mergeTarget.name}`, onClose)}>
                Merge
              </Button>
              <Button variant="ghost" onClick={() => setMergeTarget(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function PayeesEditor({ payees, categories }: { payees: PayeeItem[]; categories: CategoryChoice[] }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<PayeeItem | null>(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? payees.filter((p) => p.name.toLowerCase().includes(s)) : payees).slice(0, 300);
  }, [q, payees]);
  return (
    <>
      <label className="relative mb-4 block">
        <span className="sr-only">Search payees</span>
        <Search size={15} strokeWidth={1.75} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${payees.length} payees`} className={`${INPUT} pl-9`} />
      </label>
      <ul className="border-t border-rule">
        {shown.map((p) => (
          <li key={p.id} className="border-b border-rule">
            <button type="button" onClick={() => setOpen(p)} className="group flex min-h-[56px] w-full items-center gap-3 py-2 text-left">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] text-ink">{p.name}</span>
                <span className="block truncate text-[12px] text-ink-3">
                  {p.transactionCount} transaction{p.transactionCount === 1 ? "" : "s"}
                  {p.defaultCategoryName ? ` · default ${p.defaultCategoryName}` : ""}
                  {p.aliasCount ? ` · ${p.aliasCount} alias${p.aliasCount === 1 ? "" : "es"}` : ""}
                  {p.hasMerchant ? " · profile" : ""}
                </span>
              </span>
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 300 && <p className="mt-2 text-[12px] text-ink-3">Showing the first 300. Search to narrow.</p>}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.name ?? "Payee"} tall>
        {open && <PayeeDetail key={open.id} payee={open} all={payees} categories={categories} onClose={() => setOpen(null)} />}
      </Sheet>
    </>
  );
}
