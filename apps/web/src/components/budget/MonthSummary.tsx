"use client";
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatMilli, formatMonth } from "@homebase/shared";
import { cx } from "@/lib/cx";
import type { MonthSummaryVM } from "@/lib/view-models";
import { InfoTip } from "@/components/ui/InfoTip";
import { Money } from "@/components/ui/Money";
import { AUTO_ASSIGN_OPTIONS } from "./auto-assign";

const monthName = (m: string) => formatMonth(m).split(" ")[0] ?? "";

/** White rounded inspector card with an optional collapsible header. */
export function InspectorCard({ title, info, children, action, collapsible, defaultOpen = true, className, label }: { title: ReactNode; info?: ReactNode; children: ReactNode; action?: ReactNode; collapsible?: boolean; defaultOpen?: boolean; className?: string; label?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={label} className={cx("card px-4 py-3.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex min-h-8 items-center gap-1 text-[15px] font-bold text-ink">
          {collapsible ? (
            <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="-ml-1 flex min-h-8 items-center gap-1 rounded-md px-1 text-left">
              <ChevronDown size={16} strokeWidth={2.4} aria-hidden className={cx("text-ink-3 transition-transform", !open && "-rotate-90")} />
              {title}
            </button>
          ) : (
            title
          )}
          {info}
        </h3>
        {action}
      </div>
      {(!collapsible || open) && <div className="mt-2">{children}</div>}
    </section>
  );
}

function Rows({ rows }: { rows: [string, bigint][] }) {
  return (
    <dl className="text-[14px]">
      {rows.map(([label, v]) => (
        <div key={label} className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="text-ink-2">{label}</dt>
          <dd>
            <Money value={v} animate className="font-semibold" />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Month summary rows (spec §12.1), used in the inspector and the phone summary sheet. */
export function MonthSummary({ summary, className }: { summary: MonthSummaryVM; bare?: boolean; className?: string }) {
  const name = monthName(summary.month);
  return (
    <div className={className} aria-label="Month summary">
      <Rows
        rows={[
          ["Left Over from Last Month", summary.leftOverFromLastMonth],
          [`Assigned in ${name}`, summary.assignedThisMonth],
          ["Activity", summary.activity],
          ["Available", summary.available],
        ]}
      />
    </div>
  );
}

export function CostToBeMe({ summary }: { summary: MonthSummaryVM }) {
  const name = monthName(summary.month);
  const income = summary.income ?? 0n;
  const pct = summary.costToBeMe > 0n ? Math.min(100, Number((income * 100n) / summary.costToBeMe)) : 0;
  return (
    <InspectorCard
      label="Cost to Be Me"
      title="Cost to Be Me"
      info={
        <InfoTip label="What is Cost to Be Me?" align="start">
          What all your targets ask for this month, added up. Compare it with what you earn to see whether your plan fits your income.
        </InfoTip>
      }
    >
      <div className="flex items-baseline justify-between gap-3 text-[14px]">
        <span className="text-ink-2">{name}&rsquo;s Targets</span>
        <Money value={summary.costToBeMe} className="text-[17px] font-bold" />
      </div>
      {summary.costToBeMe > 0n && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-track">
            <div className={cx("h-full rounded-full", pct >= 100 ? "bg-pos-bar" : "bg-accent")} style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-[12.5px] text-ink-3">
            {formatMilli(income)} of income so far in {name}
            {pct >= 100 ? " — enough to cover your targets." : "."}
          </p>
        </div>
      )}
    </InspectorCard>
  );
}

/** Inspector with nothing selected (YNAB): summary, Cost to Be Me, Auto-Assign, future months, Age of Money. */
export function MonthInspector({ summary, underfunded, onAutoAssign, footer }: { summary: MonthSummaryVM; underfunded: bigint; onAutoAssign: (mode: string) => void; footer?: ReactNode }) {
  const name = monthName(summary.month);
  return (
    <div className="space-y-3">
      <InspectorCard title={`${name}’s Summary`} collapsible label={`${name}'s summary`}>
        <MonthSummary summary={summary} />
      </InspectorCard>
      <CostToBeMe summary={summary} />
      <InspectorCard
        label="Auto-Assign"
        collapsible
        title="Auto-Assign"
        info={
          <InfoTip label="What is Auto-Assign?" align="start">
            One click to fill categories from Ready to Assign: fund what your targets still need, copy last month, and more. Every change can be undone.
          </InfoTip>
        }
      >
        <ul className="-mx-2">
          {AUTO_ASSIGN_OPTIONS.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => onAutoAssign(o.id)} className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-[14px] text-ink-2 hover:bg-accent-soft hover:text-ink">
                <span>{o.label}</span>
                <span className="flex items-center gap-1">
                  {o.id === "underfunded" && <Money value={underfunded} className="font-semibold text-ink" />}
                  <ChevronRight size={15} strokeWidth={2} aria-hidden className="text-ink-3" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </InspectorCard>
      <InspectorCard title="Assigned in Future Months" label="Assigned in future months">
        <Money value={summary.assignedInFutureMonths} className="text-[17px] font-bold" />
      </InspectorCard>
      <InspectorCard
        label="Age of Money"
        title="Age of Money"
        info={<AgeOfMoneyTip />}
      >
        <span className="num text-[17px] font-bold">{summary.ageOfMoneyDays === null ? "Not enough history yet" : `${summary.ageOfMoneyDays} days`}</span>
      </InspectorCard>
      {footer}
    </div>
  );
}

export function AgeOfMoneyTip({ align = "start" }: { align?: "start" | "end" | "center" }) {
  return (
    <InfoTip label="What is Age of Money?" align={align}>
      How many days, on average, a dollar sits before you spend it. Higher means you&rsquo;re spending last month&rsquo;s money instead of this week&rsquo;s paycheck. 30+ days is a great cushion.
    </InfoTip>
  );
}
