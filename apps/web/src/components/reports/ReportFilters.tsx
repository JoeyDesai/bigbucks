"use client";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cx } from "@/lib/cx";
import { Button, IconButton } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { addMonths, toSearch, type PeriodKind, type ReportEntity, type ReportLevel, type UrlParams } from "./url";

export interface FilterAccount {
  id: string;
  name: string;
  /** Section heading in the picker (entity name). */
  section: string;
}

export interface ReportFiltersProps {
  slug: string;
  params: UrlParams;
  /** The report's URL defaults (core `reportDefaults`). */
  defaults: { period: PeriodKind; level: ReportLevel };
  /** Resolved period (for the stepper label and the custom range defaults). */
  period: { label: string; from: string; to: string; anchor: string };
  currentMonth: string;
  show: { level: boolean; accounts: boolean; entity: boolean };
  accounts?: FilterAccount[];
  /** Category detail: category (or group) picker. */
  subjectOptions?: { id: string; label: string; group: string | null }[];
  subjectId?: string | null;
  /** Investment growth: single-account picker. */
  investmentAccounts?: { id: string; name: string }[];
  children: ReactNode;
}

const PERIODS: { value: PeriodKind; label: string }[] = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "ytd", label: "YTD" },
  { value: "last12", label: "12 mo" },
  { value: "custom", label: "Custom" },
];

const selectCls =
  "min-h-10 w-full appearance-none rounded-sm border border-rule-strong bg-paper py-2 pl-3 pr-8 text-[14px] text-ink hover:border-accent focus-visible:border-accent lg:w-auto lg:min-w-[260px]";

/**
 * The shared filter bar for every report (period, custom range, entity, level, accounts) plus
 * per-report pickers. Changes navigate (the page re-renders on the server); the report below dims
 * while the new one loads.
 */
export function ReportFilters({ slug, params, defaults, period, currentMonth, show, accounts = [], subjectOptions, subjectId, investmentAccounts, children }: ReportFiltersProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [customOpen, setCustomOpen] = useState(params.period === "custom");
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [acctOpen, setAcctOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(params.accountIds ?? []);

  const go = (patch: Partial<UrlParams>) => {
    const next: UrlParams = { ...params, ...patch };
    start(() => router.push(`/reports/${slug}${toSearch(next, defaults)}`, { scroll: false }));
  };

  const onPeriod = (p: PeriodKind) => {
    if (p === "custom") {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    go({ period: p, month: undefined, from: undefined, to: undefined });
  };

  const stepper = params.period === "month" || params.period === "quarter";
  const step = (dir: -1 | 1) => go({ month: addMonths(period.anchor, params.period === "quarter" ? dir * 3 : dir) });
  const atEnd = period.anchor >= currentMonth || (params.period === "quarter" && addMonths(period.anchor, 3) > currentMonth);
  const acctLabel = !params.accountIds?.length ? "All accounts" : params.accountIds.length === 1 ? (accounts.find((a) => a.id === params.accountIds![0])?.name ?? "1 account") : `${params.accountIds.length} accounts`;
  const sections = [...new Set(accounts.map((a) => a.section))];

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-rule pb-4 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-6">
        <SegmentedControl<PeriodKind> label="Period" size="sm" value={customOpen ? "custom" : params.period} onChange={onPeriod} options={PERIODS} block className="lg:inline-flex lg:w-auto" />
        {customOpen ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (from && to && from <= to) go({ period: "custom", from, to, month: undefined });
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="eyebrow">From</span>
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="min-h-10 rounded-sm border border-rule-strong bg-paper px-2 text-[14px]" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="eyebrow">To</span>
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="min-h-10 rounded-sm border border-rule-strong bg-paper px-2 text-[14px]" />
            </label>
            <Button type="submit" size="sm" variant="primary" className="min-h-10" disabled={!from || !to || from > to}>
              Apply
            </Button>
          </form>
        ) : stepper ? (
          <div className="flex items-center gap-1" aria-label="Change period">
            <IconButton label={params.period === "quarter" ? "Previous quarter" : "Previous month"} onClick={() => step(-1)} className="-ml-3 lg:ml-0">
              <ChevronLeft size={18} strokeWidth={1.75} />
            </IconButton>
            <span className="display min-w-[9.5rem] text-center text-[17px] text-ink" aria-live="polite">
              {period.label}
            </span>
            <IconButton label={params.period === "quarter" ? "Next quarter" : "Next month"} onClick={() => step(1)} disabled={atEnd}>
              <ChevronRight size={18} strokeWidth={1.75} />
            </IconButton>
          </div>
        ) : (
          <span className="display text-[17px] text-ink">{period.label}</span>
        )}
        {(show.entity || show.level || show.accounts) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 lg:ml-auto">
            {show.entity && (
              <SegmentedControl<ReportEntity>
                label="Entity"
                size="sm"
                value={params.entity}
                onChange={(v) => go({ entity: v, accountIds: undefined })}
                options={[
                  { value: "household", label: "Household" },
                  { value: "business", label: "Business" },
                  { value: "all", label: "Both" },
                ]}
              />
            )}
            {show.level && (
              <SegmentedControl<ReportLevel>
                label="Level"
                size="sm"
                value={params.level}
                onChange={(v) => go({ level: v, categoryId: undefined })}
                options={[
                  { value: "category", label: "Categories" },
                  { value: "group", label: "Groups" },
                ]}
              />
            )}
            {show.accounts && accounts.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setPicked(params.accountIds ?? []);
                  setAcctOpen(true);
                }}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-rule-strong px-3 text-[13px] font-medium text-ink-2 hover:border-accent hover:text-ink"
              >
                {acctLabel}
                <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </div>
        )}
      </div>

      {(subjectOptions || investmentAccounts) && (
        <div className="mt-4">
          {subjectOptions && (
            <label className="relative block lg:inline-block">
              <span className="sr-only">{params.level === "group" ? "Group" : "Category"}</span>
              <select className={selectCls} value={subjectId ?? ""} onChange={(e) => go({ categoryId: e.target.value || undefined })}>
                {params.level === "group"
                  ? subjectOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))
                  : [...new Set(subjectOptions.map((o) => o.group ?? ""))].map((g) => (
                      <optgroup key={g} label={g}>
                        {subjectOptions
                          .filter((o) => (o.group ?? "") === g)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                      </optgroup>
                    ))}
              </select>
              <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3" />
            </label>
          )}
          {investmentAccounts && (
            <label className="relative block lg:inline-block">
              <span className="sr-only">Account</span>
              <select className={selectCls} value={params.accountId ?? ""} onChange={(e) => go({ accountId: e.target.value || undefined })}>
                <option value="">All investment accounts</option>
                {investmentAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3" />
            </label>
          )}
        </div>
      )}

      <div aria-busy={pending} className={cx("transition-opacity duration-200", pending && "pointer-events-none opacity-45")}>
        {children}
      </div>

      <Sheet
        open={acctOpen}
        onClose={() => setAcctOpen(false)}
        title="Accounts"
        description="Limit the report to these accounts."
        footer={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="flex-1"
              onClick={() => {
                setAcctOpen(false);
                go({ accountIds: undefined });
              }}
            >
              All accounts
            </Button>
            <Button
              variant="primary"
              className="flex-1"
              onClick={() => {
                setAcctOpen(false);
                go({ accountIds: picked.length ? picked : undefined });
              }}
            >
              Apply
            </Button>
          </div>
        }
      >
        {sections.map((sec) => (
          <fieldset key={sec} className="mb-5">
            <legend className="eyebrow mb-1">{sec}</legend>
            <ul className="divide-y divide-rule border-y border-rule">
              {accounts
                .filter((a) => a.section === sec)
                .map((a) => (
                  <li key={a.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--ink)]"
                        checked={picked.includes(a.id)}
                        onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))}
                      />
                      {a.name}
                    </label>
                  </li>
                ))}
            </ul>
          </fieldset>
        ))}
      </Sheet>
    </>
  );
}
