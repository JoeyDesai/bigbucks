"use client";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cx } from "@/lib/cx";
import { Button } from "@/components/ui/Button";

export interface DiffRow {
  label: string;
  before?: ReactNode;
  after: ReactNode;
}

export type ConfirmState = "pending" | "confirming" | "confirmed" | "cancelled" | "failed";

export interface ConfirmActionCardProps {
  /** Tool name, e.g. "recategorize" (shown small). */
  tool: string;
  /** Human-readable summary, e.g. "Move 14 transactions ($612.40) from Misc → House Projects". */
  summary: ReactNode;
  diff: DiffRow[];
  /** Extra lines (e.g. "Also creates a rule: payee is Lowe's → House Projects"). */
  notes?: ReactNode[];
  state: ConfirmState;
  onConfirm: () => void;
  onEdit?: () => void;
  onCancel: () => void;
  error?: string;
  /** When set, a failed card keeps its buttons (e.g. a network error before the server saw it). */
  onRetry?: () => void;
}

const RULE: Record<ConfirmState, string> = {
  pending: "bg-accent",
  confirming: "bg-accent",
  confirmed: "bg-pos-bar",
  cancelled: "bg-zero",
  failed: "bg-neg-bar",
};

/**
 * Pending AI write action (spec §11.3). Nothing changes until the user taps Confirm;
 * a confirmation applies to this card only.
 */
export function ConfirmActionCard({ tool, summary, diff, notes, state, onConfirm, onEdit, onCancel, error, onRetry }: ConfirmActionCardProps) {
  const done = state === "confirmed" || state === "cancelled";
  return (
    <section aria-label="Proposed change" className="relative border border-rule-strong bg-paper-raised pl-5 pr-4 py-4">
      <span aria-hidden className={cx("absolute inset-y-0 left-0 w-[3px]", RULE[state])} />
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">Proposed change</span>
        <span className="font-mono text-[11px] text-ink-3">{tool}</span>
      </div>
      <p className="mt-1.5 text-[15px] leading-snug text-ink">{summary}</p>
      {diff.length > 0 && (
        <dl className="mt-3 border-t border-rule text-[13px]">
          {diff.map((d, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-rule py-2">
              <dt className="truncate text-ink-2">{d.label}</dt>
              <dd className="num flex items-center gap-2 text-right">
                {d.before !== undefined && (
                  <>
                    <span className="text-ink-3 line-through decoration-ink-3/60">{d.before}</span>
                    <span aria-hidden className="text-ink-3">→</span>
                    <span className="sr-only">changes to</span>
                  </>
                )}
                <span className="font-medium text-ink">{d.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {notes && notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13px] text-ink-2">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-neg">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {state === "confirmed" ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-pos" role="status">
            <Check size={16} strokeWidth={2.25} aria-hidden /> Done — recorded in the audit log
          </span>
        ) : state === "cancelled" ? (
          <span className="text-[13px] text-ink-3" role="status">
            Cancelled. Nothing was changed.
          </span>
        ) : state === "failed" && !onRetry ? (
          <span className="text-[13px] text-ink-3" role="status">
            Not applied. Nothing was changed.
          </span>
        ) : (
          <>
            <Button variant="primary" onClick={onConfirm} busy={state === "confirming"} disabled={done}>
              Confirm
            </Button>
            {onEdit && (
              <Button variant="secondary" onClick={onEdit} disabled={state === "confirming"}>
                Edit
              </Button>
            )}
            <Button variant="ghost" onClick={onCancel} disabled={state === "confirming"}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
