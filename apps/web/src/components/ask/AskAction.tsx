"use client";
import { BRAND } from "@/lib/brand";
import { useState } from "react";
import { ConfirmActionCard, type ConfirmState } from "./ConfirmActionCard";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import type { ActionVM } from "./types";

export interface CategoryOption {
  id: string;
  name: string;
  group: string;
}

const RTA_ID = "ready_to_assign";

const STATE: Record<ActionVM["status"], ConfirmState> = {
  awaiting_confirmation: "pending",
  executing: "confirming",
  confirmed: "confirmed",
  rejected: "cancelled",
  failed: "failed",
};

const LABELS: Record<string, string> = {
  transaction_ids: "Transactions",
  transaction_id: "Transaction",
  category_id: "Category",
  from_category_id: "From",
  to_category_id: "To",
  amount: "Amount ($)",
  month: "Month (YYYY-MM)",
  mode: "Mode",
  payee_equals: "Payee is",
  payee_contains: "Payee contains",
  description_contains: "Description contains",
  min_abs_amount: "Min amount ($)",
  max_abs_amount: "Max amount ($)",
  set_payee_name: "Rename payee to",
  auto_approve: "Auto-approve",
  apply_to_existing: "Apply to existing transactions",
  category_ids: "Categories",
  account_ids: "Accounts",
  group: "Group",
  name: "Name",
  fact: "Fact",
  target: "Target",
  type: "Type",
  cadence: "Cadence",
  cadence_every: "Every N",
  day: "Day",
  target_date: "Target date",
  percent: "Percent",
  lines: "Lines",
  memo: "Memo",
};
const label = (k: string) => LABELS[k] ?? k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function setAt(obj: Json, path: (string | number)[], value: Json): Json {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(obj)) {
    const copy = [...obj];
    copy[head as number] = setAt(copy[head as number] ?? null, rest, value);
    return copy;
  }
  const o = (obj && typeof obj === "object" ? obj : {}) as Record<string, Json>;
  return { ...o, [head as string]: setAt(o[head as string] ?? null, rest, value) };
}

const inputCls = "block min-h-11 w-full rounded-sm border border-rule-strong bg-paper-raised px-3 text-[15px] outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]";

function Field({ k, value, path, onChange, categories }: { k: string; value: Json; path: (string | number)[]; onChange: (path: (string | number)[], v: Json) => void; categories: CategoryOption[] }) {
  const id = `f-${path.join("-")}`;
  if (typeof value === "boolean")
    return (
      <label className="flex min-h-11 items-center gap-3 text-[14px]">
        <input type="checkbox" checked={value} onChange={(e) => onChange(path, e.target.checked)} className="h-4 w-4 accent-[var(--ink)]" />
        {label(k)}
      </label>
    );
  if (Array.isArray(value)) {
    if (value.every((v) => v && typeof v === "object" && !Array.isArray(v)))
      return (
        <fieldset className="space-y-3 border-t border-rule pt-3">
          <legend className="eyebrow">{label(k)}</legend>
          {value.map((v, i) => (
            <div key={i} className="grid gap-3 border-l-2 border-rule pl-3">
              {Object.entries(v as Record<string, Json>).map(([kk, vv]) => (
                <Field key={kk} k={kk} value={vv} path={[...path, i, kk]} onChange={onChange} categories={categories} />
              ))}
            </div>
          ))}
        </fieldset>
      );
    return (
      <div className="text-[14px]">
        <div className="eyebrow mb-1">{label(k)}</div>
        <p className="text-ink-2">
          {value.length} selected{k.endsWith("ids") ? " (from the conversation)" : ""}
        </p>
      </div>
    );
  }
  if (value && typeof value === "object")
    return (
      <fieldset className="space-y-3 border-t border-rule pt-3">
        <legend className="eyebrow">{label(k)}</legend>
        {Object.entries(value).map(([kk, vv]) => (
          <Field key={kk} k={kk} value={vv} path={[...path, kk]} onChange={onChange} categories={categories} />
        ))}
      </fieldset>
    );
  if (/category_id$/.test(k) && categories.length) {
    const allowRta = k === "from_category_id" || k === "to_category_id";
    return (
      <label htmlFor={id} className="block text-[14px]">
        <span className="eyebrow mb-1 block">{label(k)}</span>
        <select id={id} value={String(value ?? "")} onChange={(e) => onChange(path, e.target.value)} className={inputCls}>
          {allowRta && <option value={RTA_ID}>Ready to Assign</option>}
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.group} · {c.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const numeric = typeof value === "number";
  const money = /amount$/.test(k);
  return (
    <label htmlFor={id} className="block text-[14px]">
      <span className="eyebrow mb-1 block">{label(k)}</span>
      <input
        id={id}
        value={value === null ? "" : String(value)}
        inputMode={numeric || money ? "decimal" : undefined}
        onChange={(e) => onChange(path, numeric ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)}
        className={`${inputCls} ${numeric || money ? "num" : ""}`}
      />
    </label>
  );
}

/** A pending action card wired to /api/ai/actions/:id/confirm|reject, with an Edit sheet. */
export function AskAction({ action, categories, onChange }: { action: ActionVM; categories: CategoryOption[]; onChange: (a: ActionVM) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Json>(action.input as Json);
  const [networkError, setNetworkError] = useState<string | null>(null);

  async function post(kind: "confirm" | "reject", editedInput?: Json) {
    setNetworkError(null);
    onChange({ ...action, status: kind === "confirm" ? "executing" : action.status });
    try {
      const res = await fetch(`/api/ai/actions/${action.id}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editedInput !== undefined ? { editedInput } : {}),
      });
      const j = (await res.json().catch(() => ({}))) as { status?: ActionVM["status"]; error?: string; summary?: string };
      if (res.ok) {
        onChange({ ...action, status: j.status ?? (kind === "confirm" ? "confirmed" : "rejected"), ...(j.summary ? { result: j.summary } : {}), ...(editedInput !== undefined ? { input: editedInput as Record<string, unknown> } : {}) });
      } else if (j.status === "failed") {
        onChange({ ...action, status: "failed", error: j.error ?? "That change couldn't be applied." });
      } else if (res.status === 409) {
        onChange({ ...action, status: action.status, error: j.error ?? "This card was already handled." });
      } else {
        onChange({ ...action, status: "awaiting_confirmation", error: j.error ?? "That didn't work. Nothing was changed." });
      }
    } catch {
      setNetworkError(`Couldn't reach ${BRAND.name}. Nothing was changed.`);
      onChange({ ...action, status: "awaiting_confirmation" });
    }
  }

  const state = STATE[action.status];
  return (
    <>
      <ConfirmActionCard
        tool={action.tool}
        summary={action.humanDiff}
        diff={[]}
        notes={action.result ? [action.result] : undefined}
        state={state}
        error={networkError ?? action.error}
        onConfirm={() => void post("confirm")}
        onEdit={
          state === "pending"
            ? () => {
                setDraft(action.input as Json);
                setEditing(true);
              }
            : undefined
        }
        onCancel={() => void post("reject")}
      />
      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit before confirming"
        description="Change the details, then confirm. The card's summary was written for the original values."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Back
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setEditing(false);
                void post("confirm", draft);
              }}
            >
              Confirm edited change
            </Button>
          </div>
        }
      >
        <div className="space-y-4 pb-2">
          {draft && typeof draft === "object" && !Array.isArray(draft)
            ? Object.entries(draft).map(([k, v]) => <Field key={k} k={k} value={v} path={[k]} categories={categories} onChange={(p, val) => setDraft((d) => setAt(d, p, val))} />)
            : null}
        </div>
      </Sheet>
    </>
  );
}
