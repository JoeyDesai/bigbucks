"use client";
import { useState, useTransition } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { formatMilli, parseMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { deleteRuleAction, saveRuleAction, setRuleEnabledAction, testRuleAction } from "@/server/settings/actions/household";
import { Button, IconButton } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { INPUT, SelectField, TextField, ToggleRow } from "./fields";

/** Canonical rule JSON (milli as decimal strings), as stored. */
export interface RuleJson {
  conditions: Record<string, unknown>[];
  actions: { setCategoryId?: string; setPayee?: { name?: string; payeeId?: string }; setMemo?: string; autoApprove?: boolean; split?: unknown; transferAccountId?: string };
}
export interface RuleRowVM {
  id: string;
  name: string | null;
  priority: number;
  enabled: boolean;
  source: "user" | "learned" | "ai_suggested";
  hitCount: number;
  lastHitAt: string | null;
  when: string;
  then: string;
  json: RuleJson | null;
  error: string | null;
}
export interface Choice {
  id: string;
  label: string;
}

type Field = "payee" | "raw_description" | "amount" | "account" | "day_of_month";
interface Cond {
  field: Field;
  op: string;
  value: string;
  min: string;
  max: string;
  sign: "any" | "outflow" | "inflow";
  accountId: string;
  from: string;
  to: string;
}
const blankCond = (): Cond => ({ field: "payee", op: "contains", value: "", min: "", max: "", sign: "outflow", accountId: "", from: "1", to: "31" });
const dollars = (m: unknown) => (m === undefined || m === null ? "" : formatMilli(BigInt(String(m)), { sign: "never" }).replace(/[$,]/g, ""));

function fromJson(j: RuleJson | null): { conds: Cond[]; category: string; rename: string; memo: string; autoApprove: boolean; extra: boolean } {
  const conds: Cond[] = (j?.conditions ?? []).map((c) => {
    const b = blankCond();
    const field = c.field as Field;
    if (field === "payee" || field === "raw_description") return { ...b, field, op: String(c.op), value: String(c.value ?? "") };
    if (field === "amount") return { ...b, field, op: String(c.op), sign: (c.sign as Cond["sign"]) ?? "any", value: dollars(c.valueMilli), min: dollars(c.minMilli), max: dollars(c.maxMilli) };
    if (field === "account") return { ...b, field, op: "in", accountId: String((c.accountIds as string[] | undefined)?.[0] ?? "") };
    return { ...b, field: "day_of_month", op: "range", from: String(c.from ?? 1), to: String(c.to ?? 31) };
  });
  const a = j?.actions ?? {};
  return { conds: conds.length ? conds : [blankCond()], category: a.setCategoryId ?? "", rename: a.setPayee?.name ?? "", memo: a.setMemo ?? "", autoApprove: !!a.autoApprove, extra: !!a.split || !!a.transferAccountId || !!a.setPayee?.payeeId };
}

function toJson(conds: Cond[], f: { category: string; rename: string; memo: string; autoApprove: boolean }, keep: RuleJson["actions"] | undefined): { ok: true; rule: RuleJson } | { ok: false; error: string } {
  const out: Record<string, unknown>[] = [];
  const m = (s: string) => parseMilli(s.replace(/[$,\s]/g, "")).toString();
  try {
    for (const c of conds) {
      if (c.field === "payee" || c.field === "raw_description") {
        if (!c.value.trim()) return { ok: false, error: "A text condition needs a value." };
        out.push({ field: c.field, op: c.op, value: c.value.trim() });
      } else if (c.field === "amount") {
        if (c.op === "equals") {
          if (!c.value.trim()) return { ok: false, error: "Enter the amount." };
          out.push({ field: "amount", op: "equals", valueMilli: m(c.value), sign: c.sign });
        } else {
          if (!c.min.trim() && !c.max.trim()) return { ok: false, error: "An amount range needs a minimum or a maximum." };
          out.push({ field: "amount", op: "range", sign: c.sign, ...(c.min.trim() ? { minMilli: m(c.min) } : {}), ...(c.max.trim() ? { maxMilli: m(c.max) } : {}) });
        }
      } else if (c.field === "account") {
        if (!c.accountId) return { ok: false, error: "Pick an account." };
        out.push({ field: "account", op: "in", accountIds: [c.accountId] });
      } else out.push({ field: "day_of_month", op: "range", from: Number(c.from), to: Number(c.to) });
    }
  } catch {
    return { ok: false, error: "Amounts must be dollar amounts like 15.49." };
  }
  const actions: RuleJson["actions"] = {};
  if (keep?.split) actions.split = keep.split;
  if (keep?.transferAccountId) actions.transferAccountId = keep.transferAccountId;
  if (f.category) actions.setCategoryId = f.category;
  if (f.rename.trim()) actions.setPayee = { name: f.rename.trim() };
  else if (keep?.setPayee?.payeeId) actions.setPayee = keep.setPayee;
  if (f.memo.trim()) actions.setMemo = f.memo.trim();
  if (f.autoApprove) actions.autoApprove = true;
  return { ok: true, rule: { conditions: out, actions } };
}

const OPS: Record<Field, { value: string; label: string }[]> = {
  payee: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "is" },
    { value: "regex", label: "matches regex" },
  ],
  raw_description: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "is" },
    { value: "regex", label: "matches regex" },
  ],
  amount: [
    { value: "range", label: "between" },
    { value: "equals", label: "is exactly" },
  ],
  account: [{ value: "in", label: "is" }],
  day_of_month: [{ value: "range", label: "between" }],
};

function Builder({ rule, categories, accounts, onDone }: { rule: RuleRowVM | null; categories: Choice[]; accounts: Choice[]; onDone: () => void }) {
  const toast = useToast();
  const init = fromJson(rule?.json ?? null);
  const [name, setName] = useState(rule?.name ?? "");
  const [conds, setConds] = useState<Cond[]>(init.conds);
  const [category, setCategory] = useState(init.category);
  const [rename, setRename] = useState(init.rename);
  const [memo, setMemo] = useState(init.memo);
  const [autoApprove, setAutoApprove] = useState(init.autoApprove);
  const [preview, setPreview] = useState<{ matchCount: number; wouldChangeCount: number; sample: { id: string; date: string; payee: string; amount: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const setCond = (i: number, patch: Partial<Cond>) => setConds((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const build = () => {
    const r = toJson(conds, { category, rename, memo, autoApprove }, rule?.json?.actions);
    if (!r.ok) setErr(r.error);
    return r;
  };

  return (
    <div className="space-y-6">
      <TextField label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lowe's is House Projects" maxLength={120} />
      <fieldset>
        <legend className="eyebrow mb-2">When all of these match</legend>
        <ul className="space-y-3">
          {conds.map((c, i) => (
            <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-l-2 border-rule pl-3">
              <div className="grid gap-2 sm:grid-cols-[150px_140px_minmax(0,1fr)]">
                <select aria-label="Field" value={c.field} onChange={(e) => setCond(i, { field: e.target.value as Field, op: OPS[e.target.value as Field][0]!.value })} className={INPUT}>
                  <option value="payee">Payee</option>
                  <option value="raw_description">Bank description</option>
                  <option value="amount">Amount</option>
                  <option value="account">Account</option>
                  <option value="day_of_month">Day of month</option>
                </select>
                <select aria-label="Comparison" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} className={INPUT}>
                  {OPS[c.field].map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {(c.field === "payee" || c.field === "raw_description") && <input aria-label="Value" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} className={INPUT} maxLength={200} placeholder={c.op === "regex" ? "^LOWES" : "Lowe's"} />}
                {c.field === "amount" && (
                  <div className="flex gap-2">
                    {c.op === "equals" ? (
                      <input aria-label="Amount" inputMode="decimal" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} className={cx(INPUT, "num")} placeholder="15.49" />
                    ) : (
                      <>
                        <input aria-label="Minimum" inputMode="decimal" value={c.min} onChange={(e) => setCond(i, { min: e.target.value })} className={cx(INPUT, "num")} placeholder="min" />
                        <input aria-label="Maximum" inputMode="decimal" value={c.max} onChange={(e) => setCond(i, { max: e.target.value })} className={cx(INPUT, "num")} placeholder="max" />
                      </>
                    )}
                    <select aria-label="Direction" value={c.sign} onChange={(e) => setCond(i, { sign: e.target.value as Cond["sign"] })} className={cx(INPUT, "w-28 shrink-0")}>
                      <option value="outflow">outflow</option>
                      <option value="inflow">inflow</option>
                      <option value="any">either</option>
                    </select>
                  </div>
                )}
                {c.field === "account" && (
                  <select aria-label="Account" value={c.accountId} onChange={(e) => setCond(i, { accountId: e.target.value })} className={INPUT}>
                    <option value="">Choose an account</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                )}
                {c.field === "day_of_month" && (
                  <div className="flex items-center gap-2">
                    <input aria-label="From day" inputMode="numeric" value={c.from} onChange={(e) => setCond(i, { from: e.target.value.replace(/\D/g, "").slice(0, 2) })} className={cx(INPUT, "num w-20")} />
                    <span className="text-ink-3">to</span>
                    <input aria-label="To day" inputMode="numeric" value={c.to} onChange={(e) => setCond(i, { to: e.target.value.replace(/\D/g, "").slice(0, 2) })} className={cx(INPUT, "num w-20")} />
                  </div>
                )}
              </div>
              <IconButton label="Remove condition" disabled={conds.length === 1} onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}>
                <X size={16} strokeWidth={1.6} />
              </IconButton>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setConds((cs) => [...cs, blankCond()])} className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">
          <Plus size={14} strokeWidth={1.75} aria-hidden /> Add condition
        </button>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="eyebrow mb-2">Then</legend>
        <SelectField label="Set category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Leave as is</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </SelectField>
        <TextField label="Rename payee to" value={rename} onChange={(e) => setRename(e.target.value)} maxLength={200} />
        <TextField label="Set memo" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} />
        <div className="border-t border-rule">
          <ToggleRow label="Auto-approve" description="Skip review. Income over $500 still needs review the first 3 times." checked={autoApprove} onChange={setAutoApprove} />
        </div>
        {init.extra && <p className="text-[12px] text-ink-3">This rule also has a split or transfer action, which is kept as is.</p>}
      </fieldset>

      {preview && (
        <div className="border-l-[3px] border-accent pl-3" role="status">
          <p className="text-[14px] text-ink">
            <span className="num font-medium">{preview.matchCount}</span> matching transaction{preview.matchCount === 1 ? "" : "s"} in the last two years
            {category ? (
              <>
                , <span className="num">{preview.wouldChangeCount}</span> with a different category today
              </>
            ) : null}
            .
          </p>
          {preview.sample.length > 0 && (
            <ul className="mt-2 text-[13px] text-ink-2">
              {preview.sample.map((s) => (
                <li key={s.id} className="flex gap-3 border-b border-rule py-1 last:border-0">
                  <span className="num w-20 shrink-0 text-ink-3">{s.date}</span>
                  <span className="min-w-0 flex-1 truncate">{s.payee}</span>
                  <span className="num">{formatMilli(BigInt(s.amount))}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {err && (
        <p role="alert" className="text-[13px] text-neg">
          {err}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          busy={pending}
          onClick={() => {
            setErr(null);
            const r = build();
            if (!r.ok) return;
            start(async () => {
              const t = await testRuleAction(r.rule);
              if (t.ok) setPreview(t);
              else setErr(t.error);
            });
          }}
        >
          Test against history
        </Button>
        <Button
          variant="primary"
          busy={pending}
          onClick={() => {
            setErr(null);
            const r = build();
            if (!r.ok) return;
            start(async () => {
              const s = await saveRuleAction(rule?.id ?? null, { name: name.trim() || null, ...r.rule });
              if (s.ok) {
                toast.show({ message: rule ? "Rule saved" : "Rule created" });
                onDone();
              } else setErr(s.error);
            });
          }}
        >
          {rule ? "Save rule" : "Create rule"}
        </Button>
      </div>
    </div>
  );
}

const SOURCE: Record<RuleRowVM["source"], string> = { user: "Yours", learned: "Learned", ai_suggested: "Suggested" };

export function RulesEditor({ rules, categories, accounts }: { rules: RuleRowVM[]; categories: Choice[]; accounts: Choice[] }) {
  const toast = useToast();
  const [open, setOpen] = useState<RuleRowVM | "new" | null>(null);
  const [pending, start] = useTransition();
  const run = (p: Promise<{ ok: true } | { ok: false; error: string }>, msg: string) =>
    start(async () => {
      const r = await p;
      toast.show(r.ok ? { message: msg } : { message: r.error, tone: "error" });
    });
  return (
    <>
      <div className="mb-6">
        <Button variant="primary" icon={<Plus size={15} strokeWidth={1.75} />} onClick={() => setOpen("new")}>
          New rule
        </Button>
      </div>
      {rules.length === 0 ? (
        <p className="border-t border-rule py-6 text-[14px] text-ink-3">No rules yet.</p>
      ) : (
        <ul className={cx("border-t border-rule", pending && "opacity-80")}>
          {rules.map((r) => (
            <li key={r.id} className="flex items-start gap-3 border-b border-rule py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={cx("truncate text-[15px]", r.enabled ? "text-ink" : "text-ink-3")}>{r.name || r.when || "Rule"}</span>
                  <span className="eyebrow shrink-0">{SOURCE[r.source]}</span>
                </div>
                {r.error ? (
                  <p className="mt-0.5 text-[12px] text-neg">Can&rsquo;t be read, so it&rsquo;s skipped: {r.error}</p>
                ) : (
                  <p className="mt-0.5 text-[13px] text-ink-2">
                    {r.name ? <>When {r.when} </> : "When matched "}
                    <span aria-hidden>→</span> {r.then}
                  </p>
                )}
                <p className="num mt-0.5 text-[12px] text-ink-3">
                  {r.hitCount} hit{r.hitCount === 1 ? "" : "s"}
                  {r.lastHitAt ? ` · last ${new Date(r.lastHitAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""} · priority {r.priority}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={r.enabled}
                aria-label={r.enabled ? "Disable rule" : "Enable rule"}
                onClick={() => run(setRuleEnabledAction(r.id, !r.enabled), r.enabled ? "Rule disabled" : "Rule enabled")}
                className={cx("relative mt-1 h-6 w-11 shrink-0 rounded-full border", r.enabled ? "border-accent bg-accent" : "border-rule-strong bg-paper-sunken")}
              >
                <span aria-hidden className={cx("absolute top-[3px] h-4 w-4 rounded-full", r.enabled ? "left-[22px] bg-paper" : "left-[3px] bg-ink-3")} />
              </button>
              <IconButton label="Edit rule" onClick={() => setOpen(r)} disabled={!!r.error}>
                <Pencil size={15} strokeWidth={1.6} />
              </IconButton>
              <IconButton label="Delete rule" onClick={() => window.confirm("Delete this rule?") && run(deleteRuleAction(r.id), "Rule deleted")}>
                <Trash2 size={15} strokeWidth={1.6} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open === "new" ? "New rule" : "Edit rule"} width={560} tall>
        {open !== null && <Builder key={open === "new" ? "new" : open.id} rule={open === "new" ? null : open} categories={categories} accounts={accounts} onDone={() => setOpen(null)} />}
      </Sheet>
    </>
  );
}
