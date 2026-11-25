"use client";
import { useEffect, useState, useTransition } from "react";
import { ArrowRightLeft, ChevronDown, CircleCheck, Pencil, Sparkles, X } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { targetProgress } from "@/lib/budget-display";
import { categoryLabel } from "@/lib/category-icons";
import { formatDay } from "@/lib/format";
import type { CategoryOption, CategoryVM } from "@/lib/view-models";
import type { ScheduledVM } from "@/server/queries/scheduled";
import { categoryDetailAction, setCategoryIconAction, setCategoryNoteAction, snoozeTargetAction, type CategoryDetailVM } from "@/server/actions/budget";
import { CategoryPicker } from "@/components/activity/CategoryPicker";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { IconPicker } from "@/components/icons/IconPicker";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SkeletonText } from "@/components/ui/Skeleton";
import { AvailablePill } from "./AvailablePill";
import { InspectorCard } from "./MonthSummary";
import { TargetEditor } from "./TargetEditor";
import { AUTO_ASSIGN_OPTIONS } from "./auto-assign";

export interface CategoryDetailProps {
  month: string;
  category: CategoryVM;
  /** Group name from the Plan (shown before the detail read arrives). */
  groupName?: string;
  categoryOptions: CategoryOption[];
  recentCategoryIds: string[];
  onAssign: (id: string, value: bigint) => void;
  onAutoAssign: (mode: string) => void;
  onMove: (fromId: string, toId: string, amount: bigint) => void;
  /** A non-assignment change (target, note, icon) finished: show its Undo toast. */
  onChanged: (message: string, operationId: string | null) => void;
  onError: (message: string) => void;
  scheduled?: ScheduledVM[];
  isHidden?: boolean;
  onSetHidden?: (hidden: boolean) => void;
  /** "inspector": desktop right column (shows the name and a close button). "sheet": phone bottom sheet body. */
  variant: "inspector" | "sheet";
  onClose?: () => void;
}

/** Circular target progress (YNAB's ring in the Target card). */
export function ProgressRing({ value, tone, size = 64 }: { value: number; tone: "pos" | "warn" | "neg" | "muted"; size?: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  const color = tone === "pos" ? "var(--pos-bar)" : tone === "warn" ? "var(--warn-bar)" : tone === "neg" ? "var(--neg-bar)" : "var(--ink-3)";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={`${Math.round(pct * 100)}% funded`} className="shrink-0">
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--track)" strokeWidth="7" />
      <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 32 32)" style={{ transition: "stroke-dasharray 500ms var(--ease-out-quart)" }} />
      {pct >= 1 ? (
        <path d="M24 32.5l5.5 5.5L41 26.5" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <text x="32" y="36.5" textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--ink)">
          {Math.round(pct * 100)}%
        </text>
      )}
    </svg>
  );
}

function Breakdown({ rows }: { rows: [string, bigint][] }) {
  return (
    <dl className="text-[14px]">
      {rows.map(([label, v]) => (
        <div key={label} className="flex items-baseline justify-between gap-3 py-1">
          <dt className="text-ink-2">{label}</dt>
          <dd>
            <Money value={v} className="font-medium" />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Category details (spec §12.1), YNAB layout: Available Balance + breakdown, Target card with a
 * progress ring, Auto-Assign, Notes, upcoming and recent transactions. Shared by the desktop inspector
 * and the phone bottom sheet.
 */
export function CategoryDetail({ month, category: c, groupName, categoryOptions, recentCategoryIds, onAssign, onAutoAssign, onMove, onChanged, onError, scheduled = [], isHidden, onSetHidden, variant, onClose }: CategoryDetailProps) {
  const [moving, setMoving] = useState<{ amount: bigint; direction: "from" | "to" } | null>(null);
  const [editingTarget, setEditingTarget] = useState(false);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; data: CategoryDetailVM | null } | null>(null);
  const [pending, start] = useTransition();
  const label = categoryLabel(c.name);

  useEffect(() => {
    let live = true;
    categoryDetailAction(month, c.id).then((data) => live && setDetail({ id: c.id, data }));
    return () => {
      live = false;
    };
    // refetch when the category's numbers change (after an assign / move)
  }, [c.id, c.assigned, c.available, month]);

  // Reset local editors when another category is selected.
  const [seenId, setSeenId] = useState(c.id);
  if (seenId !== c.id) {
    setSeenId(c.id);
    setMoving(null);
    setEditingTarget(false);
    setPickingIcon(false);
    setNote(null);
  }

  const d = detail && detail.id === c.id ? detail.data : null;
  const progress = targetProgress(c);
  const group = d?.groupName ?? groupName ?? "";
  const t = c.target;

  const saveNote = () => {
    if (note === null || note === (c.note ?? "")) return;
    start(async () => {
      const r = await setCategoryNoteAction({ categoryId: c.id, note });
      if (r.ok) onChanged(`Note saved for ${label}`, r.operationId);
      else onError(r.error);
    });
  };
  const pickIcon = (icon: string | null) => {
    setPickingIcon(false);
    start(async () => {
      const r = await setCategoryIconAction({ categoryId: c.id, icon });
      if (r.ok) onChanged(icon ? `Icon updated for ${label}` : `${label} uses an automatic icon`, r.operationId);
      else onError(r.error);
    });
  };
  const snooze = () =>
    start(async () => {
      const r = await snoozeTargetAction({ categoryId: c.id, month, snoozed: !t?.snoozed });
      if (r.ok) onChanged(t?.snoozed ? `${label}: target back on` : `${label}: target snoozed for this month`, r.operationId);
      else onError(r.error);
    });

  const upcoming = scheduled
    .flatMap((s) => {
      const line = s.categoryId === c.id ? s.amount : s.splits.filter((l) => l.categoryId === c.id).reduce((a, l) => a + l.amount, 0n);
      if (s.categoryId !== c.id && line === 0n) return [];
      return s.upcoming.map((date) => ({ id: `${s.id}:${date}`, date, payee: s.payeeName ?? "Scheduled", amount: line }));
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const funded = t ? (t.needed > 0n ? Number(((t.needed - (t.underfunded > t.needed ? t.needed : t.underfunded)) * 1000n) / t.needed) / 1000 : 1) : 0;
  const ringTone = !t ? "muted" : t.snoozed ? "muted" : c.available < 0n ? "neg" : t.underfunded > 0n ? "warn" : "pos";

  return (
    <div className={cx("space-y-3", variant === "sheet" && "pb-2")}>
      <section aria-label="Available" className={cx(variant === "inspector" ? "card p-4" : "")}>
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => setPickingIcon((v) => !v)}
            aria-expanded={pickingIcon}
            aria-label={`Change icon for ${label}`}
            title="Change icon"
            className="group relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft hover:ring-2 hover:ring-accent"
          >
            <CategoryIcon icon={c.icon} name={c.name} size={22} tone="accent" />
            <span className="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-paper-raised bg-accent text-accent-contrast">
              <Pencil size={9} strokeWidth={3} aria-hidden />
            </span>
          </button>
          <div className="min-w-0 flex-1 pt-0.5">
            {variant === "inspector" ? <h2 className="truncate text-[18px] font-bold leading-tight text-ink">{label}</h2> : null}
            <p className={cx("truncate text-ink-3", variant === "inspector" ? "text-[13px]" : "pt-2.5 text-[14px]")}>{group || " "}</p>
          </div>
          {variant === "inspector" && onClose && (
            <button type="button" onClick={onClose} aria-label="Close category details" className="-mr-1 -mt-1 inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-paper-sunken hover:text-ink">
              <X size={18} strokeWidth={2} />
            </button>
          )}
        </div>
        {pickingIcon && (
          <div className="mt-3 rounded-xl border border-rule bg-paper p-3">
            <IconPicker value={c.icon ?? null} name={c.name} onPick={pickIcon} />
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[15px] font-semibold text-ink">Available Balance</span>
          <AvailablePill category={c} size="lg" />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 border-b border-rule pb-3">
          <span className="text-[14px] font-semibold text-ink">Assigned</span>
          <AmountInput boxed value={c.assigned} label={`Assigned to ${label}`} onCommit={(v) => onAssign(c.id, v)} className="text-[16px] font-semibold" />
        </div>
        <div className="pt-2">
          <Breakdown
            rows={[
              ["Cash Left Over From Last Month", c.carryIn ?? 0n],
              ["Assigned This Month", c.assigned],
              ["Cash Spending", c.cashSpending ?? 0n],
              ["Credit Spending", c.creditSpending ?? 0n],
              ...(d && d.breakdown.otherActivity !== 0n ? ([[c.kind === "cc_payment" ? "Payments and Funded Spending" : "Inflows and Refunds", d.breakdown.otherActivity]] as [string, bigint][]) : []),
            ]}
          />
        </div>
        {c.kind === "cc_payment" && c.suggestedPayment !== undefined && (
          <p className="mt-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-ink-2">
            Suggested card payment <span className="num font-bold text-ink">{formatMilli(c.suggestedPayment)}</span>
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {t && !t.snoozed && t.underfunded > 0n && (
            <Button variant="primary" size="sm" onClick={() => onAssign(c.id, c.assigned + t.underfunded)}>
              Assign {formatMilli(t.underfunded)}
            </Button>
          )}
          <Button variant="secondary" size="sm" icon={<ArrowRightLeft size={15} strokeWidth={2} />} onClick={() => setMoving({ amount: c.available > 0n ? c.available : -c.available, direction: c.available < 0n ? "to" : "from" })}>
            Move money
          </Button>
          <ActionMenu
            label="Auto-Assign this category"
            align="end"
            trigger={
              <span className="inline-flex items-center gap-1.5">
                <Sparkles size={15} strokeWidth={2} aria-hidden /> Auto-Assign <ChevronDown size={14} aria-hidden />
              </span>
            }
            triggerClassName="inline-flex min-h-9 items-center rounded-md border border-rule-strong bg-paper-raised px-3 text-[13px] font-semibold text-ink hover:bg-paper-hover"
            menuClassName={variant === "sheet" ? "bottom-full mb-1 mt-0" : undefined}
            items={AUTO_ASSIGN_OPTIONS.map((o) => ({ id: o.id, label: o.label, description: o.description, onSelect: () => onAutoAssign(o.id) }))}
          />
        </div>
      </section>

      {moving && (
        <section aria-label="Move money" className="card border-accent p-4">
          <h3 className="mb-2 text-[15px] font-bold">Move money</h3>
          <SegmentedControl
            label="Direction"
            size="sm"
            value={moving.direction}
            onChange={(direction) => setMoving({ ...moving, direction })}
            options={[
              { value: "from", label: `From ${label.length > 14 ? "this" : label}` },
              { value: "to", label: `To ${label.length > 14 ? "this" : label}` },
            ]}
          />
          <div className="mt-3">
            <AmountInput tapToEdit={false} value={moving.amount} label="Amount to move" hideLabel={false} allowNegative={false} onCommit={(v) => setMoving({ ...moving, amount: v })} className="w-40" />
          </div>
          <div className="eyebrow mb-1 mt-4">{moving.direction === "from" ? "Move to" : "Take from"}</div>
          <div className="max-h-[40dvh] overflow-y-auto">
            <CategoryPicker
              options={categoryOptions.filter((o) => o.id !== c.id && o.groupName !== "Inflow").concat([{ id: "rta", name: "Ready to Assign", groupName: "Ready to Assign" }])}
              recentIds={recentCategoryIds}
              onSelect={(o) => {
                if (moving.amount <= 0n) return onError("Enter an amount to move.");
                if (moving.direction === "from") onMove(c.id, o.id, moving.amount);
                else onMove(o.id, c.id, moving.amount);
                setMoving(null);
              }}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={() => setMoving(null)} className="mt-2">
            Cancel move
          </Button>
        </section>
      )}

      {c.kind !== "cc_payment" || t ? (
        <InspectorCard
          label="Target"
          title="Target"
        >
          {editingTarget ? (
            <TargetEditor
              month={month}
              category={c}
              onCancel={() => setEditingTarget(false)}
              onError={onError}
              onDone={(m, op) => {
                setEditingTarget(false);
                onChanged(m, op);
              }}
            />
          ) : t ? (
            <div>
              <div className="flex items-center gap-4">
                <ProgressRing value={funded} tone={ringTone} />
                <div className="min-w-0">
                  <p className="text-[14.5px] font-semibold leading-snug text-ink">{t.description}</p>
                  <p className="mt-0.5 text-[13px] text-ink-3">{t.dueLabel ? `By ${t.dueLabel}` : "By the end of the month"}</p>
                  <p className={cx("mt-1 flex items-center gap-1 text-[13px] font-semibold", t.snoozed ? "text-ink-3" : c.available < 0n ? "text-neg" : t.underfunded > 0n ? "text-warn" : "text-pos")}>
                    {t.snoozed ? (
                      "Snoozed for this month"
                    ) : c.available < 0n ? (
                      progress?.label
                    ) : t.underfunded > 0n ? (
                      `Assign ${formatMilli(t.underfunded)} more to meet your target`
                    ) : (
                      <>
                        <CircleCheck size={14} strokeWidth={2.4} aria-hidden /> You&rsquo;ve met your target!
                      </>
                    )}
                  </p>
                </div>
              </div>
              <div className="mt-3" />
              <Breakdown
                rows={[
                  ["Amount to Assign This Month", t.needed],
                  ["Assigned So Far", t.needed > t.underfunded ? t.needed - t.underfunded : 0n],
                  ["To Go", t.underfunded],
                ]}
              />
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditingTarget(true)}>
                  Edit Target
                </Button>
                <Button size="sm" variant="ghost" onClick={snooze} disabled={pending}>
                  {t.snoozed ? "Unsnooze" : "Snooze"}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-[14px] text-ink-2">How much do you need for {label}? A target tells you what to assign each month and shows progress here.</p>
              <Button size="sm" variant="primary" className="mt-3" onClick={() => setEditingTarget(true)}>
                Create Target
              </Button>
            </div>
          )}
        </InspectorCard>
      ) : null}

      <InspectorCard title="Notes" label="Notes">
        <label htmlFor={`cat-note-${variant}`} className="sr-only">
          Notes for {label}
        </label>
        <textarea
          id={`cat-note-${variant}`}
          rows={2}
          value={note ?? c.note ?? ""}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          placeholder="Enter a note..."
          className="w-full resize-none rounded-lg border border-rule bg-paper-raised px-3 py-2 text-[14px] outline-none placeholder:text-ink-3 focus:border-accent"
        />
      </InspectorCard>

      {upcoming.length > 0 && (
        <InspectorCard title="Upcoming" label="Upcoming">
          <ul>
            {upcoming.slice(0, 6).map((u) => (
              <li key={u.id} className="flex items-baseline justify-between gap-3 border-b border-dashed border-rule py-2 text-[14px] text-ink-2 last:border-b-0">
                <span className="min-w-0">
                  <span className="block truncate">{u.payee}</span>
                  <span className="block text-[12px] text-ink-3">{formatDay(u.date)} · scheduled</span>
                </span>
                <Money value={u.amount} tone="muted" />
              </li>
            ))}
          </ul>
        </InspectorCard>
      )}

      <InspectorCard title="Recent Transactions" label="Recent transactions">
        {!d ? (
          <SkeletonText lines={3} />
        ) : d.recent.length === 0 ? (
          <p className="text-[14px] text-ink-3">No transactions yet.</p>
        ) : (
          <ul>
            {d.recent.slice(0, 8).map((tx) => (
              <li key={tx.id} className="flex items-baseline justify-between gap-3 border-b border-rule py-2 text-[14px] last:border-b-0">
                <span className="min-w-0">
                  <span className="block truncate text-ink">{tx.payee}</span>
                  <span className="block text-[12px] text-ink-3">
                    {formatDay(tx.date)} · {tx.accountName}
                  </span>
                </span>
                <Money value={tx.amount} tone={tx.amount > 0n ? "pos" : "ink"} />
              </li>
            ))}
          </ul>
        )}
      </InspectorCard>

      {onSetHidden && c.kind === "normal" && (
        <button type="button" onClick={() => onSetHidden(!isHidden)} className="min-h-11 px-1 text-[13px] text-ink-3 hover:text-accent">
          {isHidden ? "Unhide this category" : "Hide this category"}
        </button>
      )}
    </div>
  );
}
