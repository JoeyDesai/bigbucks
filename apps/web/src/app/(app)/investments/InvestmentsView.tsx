"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, Eye, EyeOff, MoreHorizontal } from "lucide-react";
import { formatMilli, type Milli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { dollars, formatDay } from "@/lib/format";
import { AddInvestmentForm, ManualAmountForm } from "@/components/invest/AddInvestment";
import { GrowthBars } from "@/components/invest/GrowthBars";
import { ValueChart } from "@/components/invest/ValueChart";
import { UserMenu } from "@/components/shell/UserMenu";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { useToast } from "@/components/ui/Toast";
import { setInvestmentHiddenAction } from "@/server/actions/investments";
import type { InvestAccountVM, InvestmentsPage, InvestPeriod } from "@/server/queries/investments";

const PERIODS: { key: InvestPeriod; label: string; long: string }[] = [
  { key: "1M", label: "1M", long: "past month" },
  { key: "3M", label: "3M", long: "past 3 months" },
  { key: "YTD", label: "YTD", long: "this year" },
  { key: "1Y", label: "1Y", long: "past year" },
  { key: "ALL", label: "All", long: "since we started tracking" },
];
const CLASS_LABEL: Record<string, string> = { us_stock: "US stocks", intl_stock: "International stocks", target_date: "Target date funds", bond: "Bonds", cash: "Cash", crypto: "Crypto", other: "Other" };
const CLASS_ORDER = ["us_stock", "intl_stock", "target_date", "bond", "cash", "crypto", "other"];
const classColor = (c: string) => (c === "other" ? "var(--cat-other)" : `var(--cat-${CLASS_ORDER.indexOf(c) + 1})`);
const acctColor = (slot: number) => `var(--cat-${slot + 1})`;

function signed(m: Milli): string {
  return m === 0n ? "$0" : `${m > 0n ? "+" : "-"}${dollars(m < 0n ? -m : m)}`;
}
/** Change as a percent of the starting value, one decimal: "+3.4%". */
function pctChange(change: Milli, start: Milli | null): string | null {
  if (!start || start <= 0n) return null;
  const bp = Number((change * 10_000n) / start);
  return `${bp >= 0 ? "+" : "-"}${(Math.abs(bp) / 100).toFixed(1)}%`;
}
function ago(iso: string | null): string {
  if (!iso) return "never updated";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins <= 1 ? "just now" : `${mins} min ago`}`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return formatDay(iso.slice(0, 10));
}
function how(a: InvestAccountVM): string {
  if (a.manual) return a.manual.provider === "none" ? "by hand" : "live price";
  if (a.source === "simplefin") return "SimpleFIN";
  if (a.source === "csv") return "CSV upload";
  if (a.source === "coinbase") return "Coinbase";
  if (a.source === "xpub" || a.source === "river_csv") return "River";
  if (a.source === "ynab_import") return "from YNAB";
  return "by hand";
}

function Card({ title, aside, children, className, id }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string; id?: string }) {
  return (
    <section aria-label={title} id={id} className={cx("card relative p-5 sm:p-6", className)}>
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.07em] text-ink-2">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** Investments: all brokerage / retirement / HSA / crypto accounts together, or one at a time. */
export function InvestmentsView({ data, demo }: { data: InvestmentsPage; demo: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const toast = useToast();
  const sel = data.accounts.find((a) => a.id === data.accountId) ?? null;
  const byValue = (a: InvestAccountVM, b: InvestAccountVM) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0);
  // empty accounts (closed plans, $0 wallets) and ones hidden by hand stay out of the way
  const visible = data.accounts.filter((a) => !a.hidden && !a.empty).sort(byValue);
  const tucked = data.accounts.filter((a) => a.hidden || a.empty).sort(byValue);
  const shown = sel ? [sel] : visible;
  const hide = (a: InvestAccountVM, hidden: boolean) =>
    start(async () => {
      const r = await setInvestmentHiddenAction({ accountId: a.id, hidden });
      if (!r.ok) return void toast.show({ message: r.error, tone: "error" });
      toast.show({
        message: hidden ? `${a.name} is hidden from Investments` : `${a.name} is back on Investments`,
        action: { label: "Undo", onAction: () => void setInvestmentHiddenAction({ accountId: a.id, hidden: !hidden }).then(() => router.refresh()) },
      });
      router.refresh();
    });
  const period = PERIODS.find((p) => p.key === data.period)!;
  const go = (next: { a?: string | null; p?: InvestPeriod }) => {
    const a = next.a === undefined ? data.accountId : next.a;
    const p = next.p ?? data.period;
    const q = new URLSearchParams();
    if (a) q.set("a", a);
    if (p !== "1Y") q.set("p", p);
    start(() => router.push(`/investments${q.size ? `?${q}` : ""}`, { scroll: false }));
  };

  const value = shown.reduce((s, a) => s + a.value, 0n);
  // Each account counts from its first balance in the range, so a newly connected account isn't "growth".
  const known = shown.filter((a) => (data.firstKnown?.[a.id] ?? -1) >= 0);
  const startVal = known.length ? known.reduce((s, a) => s + (a.start ?? 0n), 0n) : null;
  const change = startVal === null ? 0n : known.reduce((s, a) => s + a.value, 0n) - startVal;
  const pc = pctChange(change, startVal);
  const firstIdx = known.length ? Math.min(...known.map((a) => data.firstKnown[a.id]!)) : 0;
  const lateAccounts = known.filter((a) => data.firstKnown[a.id]! > firstIdx).length;
  const since = firstIdx > 0 ? `since ${formatDay(data.dates[firstIdx]!, { withYear: !data.dates[firstIdx]!.startsWith(data.today.slice(0, 4)) })}` : period.long;
  const layers = (sel ? [sel] : visible).map((a) => ({
    id: a.id,
    label: a.name,
    color: sel ? "var(--accent)" : acctColor(a.slot),
    values: (data.series[a.id] ?? []).slice(firstIdx),
  }));
  const chartDates = data.dates.slice(firstIdx);
  const g = data.growthTotals;
  const [fund, setFund] = useState<string | null>(null);
  const fundSym = fund && data.holdings.positions.some((p) => p.symbol === fund) ? fund : (data.holdings.positions[0]?.symbol ?? null);
  const pickFund = (sym: string) => {
    setFund(sym);
    requestAnimationFrame(() => document.getElementById("fund")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  if (data.accounts.length === 0) {
    return (
      <Shell>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2 lg:gap-6">
          <ConnectCard demo={demo} open />
          <InvestmentCard demo={demo} today={data.today} open />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="relative inline-flex min-w-0 max-w-full items-center">
          <span className="sr-only">Account</span>
          <select
            value={data.accountId ?? ""}
            onChange={(e) => go({ a: e.target.value || null })}
            data-testid="invest-account-select"
            className="h-11 min-w-0 max-w-full appearance-none truncate rounded-full border border-rule-strong bg-paper pl-4 pr-10 text-[15px] font-medium text-ink outline-none transition-colors hover:border-accent/60 focus-visible:border-accent"
          >
            <option value="">All accounts ({visible.length})</option>
            {[...new Set(visible.map((a) => a.institution ?? "Other"))].map((inst) => (
              <optgroup key={inst} label={inst}>
                {visible
                  .filter((a) => (a.institution ?? "Other") === inst)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {dollars(a.value)}
                    </option>
                  ))}
              </optgroup>
            ))}
            {tucked.length > 0 && (
              <optgroup label="Hidden or empty">
                {tucked.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {dollars(a.value)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <ChevronDown size={16} className="pointer-events-none absolute right-4 text-ink-3" aria-hidden />
        </label>
        {sel && (
          <button type="button" onClick={() => go({ a: null })} className="text-[14px] font-medium text-accent hover:underline">
            All accounts
          </button>
        )}
      </div>

      <div className={cx("hb-rise grid grid-cols-[minmax(0,1fr)] gap-5 transition-opacity lg:gap-6", pending && "opacity-70")}>
        <section aria-label={sel ? sel.name : "All investments"} className="card relative overflow-hidden p-5 sm:p-6">
          <div aria-hidden className="pointer-events-none absolute -left-20 -top-28 h-64 w-64 rounded-full opacity-50 blur-3xl" style={{ background: "radial-gradient(closest-side, var(--accent-glow), transparent)" }} />
          <div className="relative flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink-3">
                {sel ? [sel.institution, sel.kindLabel].filter(Boolean).join(" · ") : `All investments · ${visible.length} account${visible.length === 1 ? "" : "s"}`}
              </div>
              <div className="num display mt-1 text-[40px] leading-none text-ink sm:text-[48px]" data-testid="invest-total" data-value={value.toString()}>
                {dollars(value)}
              </div>
              <div className="mt-2 text-[14px]">
                <span className={cx("num font-semibold", change >= 0n ? "text-pos" : "text-over")}>
                  {signed(change)}
                  {pc ? ` (${pc})` : ""}
                </span>{" "}
                <span className="text-ink-3">{since}</span>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-[12.5px]">
              <div>
                <dt className="text-ink-3">Put in, 12 months</dt>
                <dd className="num text-[20px] font-semibold text-ink">{dollars(g.contributions)}</dd>
              </div>
              <div>
                <dt className="text-ink-3">Market, 12 months</dt>
                <dd className={cx("num text-[20px] font-semibold", g.marketChange >= 0n ? "text-pos" : "text-over")}>{signed(g.marketChange)}</dd>
              </div>
            </dl>
          </div>
          <div className="relative mt-5">
            <div className="mb-2 flex justify-end">
              <div role="group" aria-label="Time range" className="flex gap-0.5">
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => go({ p: p.key })}
                    aria-pressed={p.key === data.period}
                    className={cx(
                      "num min-h-9 min-w-10 rounded-[8px] px-2 text-[13px] font-semibold transition-colors",
                      p.key === data.period ? "bg-paper-hover text-ink" : "text-ink-3 hover:text-ink-2",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            {chartDates.length > 1 ? (
              <ValueChart key={`${data.accountId}-${data.period}`} dates={chartDates} layers={layers} label={`${sel ? sel.name : "All investments"} value, ${since}`} />
            ) : (
              <p className="py-10 text-center text-[14px] text-ink-3">The chart starts today. SimpleFIN sends each day&apos;s balance, so the history fills in from here.</p>
            )}
            {lateAccounts > 0 && chartDates.length > 1 && (
              <p className="mt-2 text-[12px] text-ink-3">
                {lateAccounts} account{lateAccounts === 1 ? " was" : "s were"} added later and count{lateAccounts === 1 ? "s" : ""} from the day {lateAccounts === 1 ? "it was" : "they were"} added.
              </p>
            )}
          </div>
        </section>

        {!sel && (
          <Card title="Accounts" aside={<span className="hidden text-[12.5px] text-ink-3 sm:inline">Tap one to open it. Right-click or ⋯ to hide it.</span>}>
            <ul className="-mx-2" data-testid="invest-accounts">
              {visible.map((a) => {
                const ch = a.start === null ? null : a.value - a.start;
                const share = value > 0n ? Number((a.value * 1000n) / value) / 10 : 0;
                return (
                  <li
                    key={a.id}
                    className="group relative flex items-center rounded-[10px] transition-colors hover:bg-paper-hover"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.currentTarget.querySelector<HTMLButtonElement>("[data-row-menu] button")?.click();
                    }}
                  >
                    <button type="button" onClick={() => go({ a: a.id })} className="grid min-w-0 flex-1 grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3 px-2 py-3 text-left">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: acctColor(a.slot) }} aria-hidden />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-medium text-ink">{a.name}</span>
                          {a.isNew && <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-accent">New</span>}
                        </span>
                        <span className="block truncate text-[12.5px] text-ink-3" suppressHydrationWarning>
                          {[a.institution, a.kindLabel].filter(Boolean).join(" · ")} · {how(a)}
                          {a.manual ? "" : `, ${ago(a.updatedAt)}`}
                        </span>
                        <span className="mt-1.5 block h-1 w-full max-w-[220px] overflow-hidden rounded-full bg-[var(--chart-grid)]" aria-hidden>
                          <span className="block h-full rounded-full" style={{ width: `${share}%`, background: acctColor(a.slot) }} />
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="num block text-[15px] font-semibold text-ink">{dollars(a.value)}</span>
                        {ch !== null && <span className={cx("num block text-[12.5px]", ch >= 0n ? "text-pos" : "text-over")}>{signed(ch)}</span>}
                      </span>
                    </button>
                    <span data-row-menu className="shrink-0 pr-1">
                      <ActionMenu
                        label={`More for ${a.name}`}
                        trigger={<MoreHorizontal size={18} aria-hidden />}
                        triggerClassName="flex h-10 w-10 items-center justify-center rounded-[10px] text-ink-3 hover:bg-paper hover:text-ink"
                        items={[
                          { id: "open", label: "Open", onSelect: () => go({ a: a.id }) },
                          { id: "hide", label: "Hide from Investments", icon: <EyeOff size={16} aria-hidden />, onSelect: () => hide(a, true) },
                        ]}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
            {tucked.length > 0 && (
              <details className="group mt-2 border-t border-rule pt-3" data-testid="invest-hidden">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13.5px] font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={15} className="transition-transform group-open:rotate-90" aria-hidden />
                  {tucked.length} hidden or empty account{tucked.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2">
                  {tucked.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 py-1.5 pl-5 text-[13.5px]">
                      <button type="button" onClick={() => go({ a: a.id })} className="min-w-0 flex-1 truncate text-left text-ink-2 hover:text-ink">
                        {a.name}
                        <span className="text-ink-3"> · {a.hidden ? "hidden" : "empty"}</span>
                      </button>
                      <span className="num text-ink-3">{dollars(a.value)}</span>
                      {a.hidden && (
                        <button type="button" onClick={() => hide(a, false)} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                          <Eye size={14} aria-hidden /> Show
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
        )}

        {sel && (
          <div className="-mt-1 flex flex-wrap gap-x-6 gap-y-1 px-1 text-[13.5px]">
            {sel.manual && <ManualAmountForm key={sel.manual.units} accountId={sel.id} manual={sel.manual} crypto={sel.kind === "crypto"} />}
            <span className="text-ink-3" suppressHydrationWarning>
              {sel.manual ? (sel.manual.provider === "none" ? "Value entered by hand" : "Value follows its price, checked every hour") : `Updated ${how(sel) === "by hand" ? "by hand" : `through ${how(sel)}`}, ${ago(sel.updatedAt)}`}
            </span>
            {!sel.manual && (
              <Link href={`/accounts/${sel.id}`} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                Transactions <ArrowUpRight size={14} aria-hidden />
              </Link>
            )}
            {sel.isNew && (
              <Link href="/activity" className="font-medium text-accent hover:underline">
                New from SimpleFIN: review it
              </Link>
            )}
            <button type="button" onClick={() => hide(sel, !sel.hidden)} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
              {sel.hidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
              {sel.hidden ? "Show on Investments" : "Hide from Investments"}
            </button>
          </div>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-6">
          <Card title="Month by month" aside={<span className="num text-[12.5px] text-ink-3">Last 12 months</span>}>
            <GrowthBars months={data.growth} label="Money put in and market change per month" />
            {data.growth.some((m) => !m.known) && !sel?.manual && (
              <p className="mt-3 text-[12.5px] text-ink-3">
                Some months have no record of what was put in, so their market number also includes deposits. Set a monthly contribution for the account in Settings → Accounts to split them.
              </p>
            )}
          </Card>
          <Holdings data={data} sel={sel} fund={fundSym} onFund={pickFund} />
        </div>

        {fundSym && <FundCard key={`${fundSym}-${data.accountId}-${data.period}`} data={data} symbol={fundSym} periodLong={period.long} multi={!sel && visible.length > 1} />}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2 lg:gap-6">
          <ConnectCard demo={demo} />
          <InvestmentCard demo={demo} today={data.today} />
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pb-6 pt-3 sm:px-6 lg:px-10 lg:pt-8">
      <header className="mb-3 flex items-center gap-2 lg:mb-5">
        <h1 className="display flex-1 text-[28px] leading-tight text-ink lg:text-[32px]">Investments</h1>
        <div className="-mr-2 lg:hidden">
          <UserMenu />
        </div>
      </header>
      {children}
    </div>
  );
}

function Holdings({ data, sel, fund, onFund }: { data: InvestmentsPage; sel: InvestAccountVM | null; fund: string | null; onFund: (symbol: string) => void }) {
  const h = data.holdings;
  const multi = !sel && data.accounts.filter((a) => !a.hidden && !a.empty).length > 1;
  const costKnown = h.positions.length > 0 && h.positions.every((p) => p.costBasis !== null);
  const cost = h.positions.reduce((s, p) => s + (p.costBasis ?? 0n), 0n);
  const gain = h.total - cost;
  const cash = h.allocation.find((a) => a.assetClass === "cash")?.weightBps ?? 0;
  return (
    <Card title="What it's in" aside={h.asOf ? <span className="text-[12.5px] text-ink-3">As of {formatDay(h.asOf, { withYear: true })}</span> : undefined}>
      {h.positions.length === 0 ? (
        <div className="py-4 text-[14px] text-ink-2">
          <p>No fund-by-fund detail for {sel ? "this account" : "these accounts"} yet.</p>
          <p className="mt-2 text-[13px] text-ink-3">
            SimpleFIN sends holdings for some banks and only a balance for others. For Fidelity, you can upload the Positions file instead: on Fidelity.com, open Positions and choose Download, then add it in{" "}
            <Link href="/settings/imports" className="font-medium text-accent hover:underline">
              Settings → Imports
            </Link>
            .
          </p>
        </div>
      ) : (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[12.5px] sm:grid-cols-4" data-testid="invest-stats">
            <div>
              <dt className="text-ink-3">Holdings</dt>
              <dd className="num text-[17px] font-semibold text-ink">{h.positions.length}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Paid in</dt>
              <dd className="num text-[17px] font-semibold text-ink">{costKnown ? dollars(cost) : "—"}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Gain</dt>
              <dd className={cx("num text-[17px] font-semibold", !costKnown ? "text-ink" : gain >= 0n ? "text-pos" : "text-over")}>
                {costKnown ? `${signed(gain)}` : "—"}
                {costKnown && pctChange(gain, cost) && <span className="ml-1 text-[12px] font-medium">{pctChange(gain, cost)}</span>}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">In cash</dt>
              <dd className="num text-[17px] font-semibold text-ink">{(cash / 100).toFixed(1)}%</dd>
            </div>
          </dl>
          <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label={`Mix: ${h.allocation.map((a) => `${CLASS_LABEL[a.assetClass]} ${(a.weightBps / 100).toFixed(0)}%`).join(", ")}`}>
            {h.allocation.map((a) => (
              <span key={a.assetClass} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${a.weightBps / 100}%`, background: classColor(a.assetClass) }} />
            ))}
          </div>
          <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-4 gap-y-1 text-[12.5px]">
            {h.allocation.map((a) => (
              <li key={a.assetClass} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: classColor(a.assetClass) }} aria-hidden />
                <span className="truncate text-ink-2">{CLASS_LABEL[a.assetClass]}</span>
                <span className="num ml-auto text-ink-3">{(a.weightBps / 100).toFixed(0)}%</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[12.5px] text-ink-3">Tap one to see its history.</p>
          <ul className="mt-1 border-t border-rule" data-testid="invest-holdings">
            {h.positions.map((p) => (
              <li key={p.symbol} className="border-b border-rule last:border-0">
                <button
                  type="button"
                  onClick={() => onFund(p.symbol)}
                  aria-pressed={fund === p.symbol}
                  className={cx("-mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-[10px] px-2 py-2.5 text-left transition-colors hover:bg-paper-hover", fund === p.symbol && "bg-paper-hover")}
                >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-[13px] font-semibold text-ink">{p.symbol}</span>
                    <span className="num text-[12px] text-ink-3">{(p.weightBps / 100).toFixed(1)}%</span>
                  </span>
                  <span className="block truncate text-[12.5px] text-ink-3">
                    {p.name ?? CLASS_LABEL[p.assetClass]}
                    {multi && p.accounts.length > 0 ? ` · ${p.accounts.length > 1 ? `${p.accounts.length} accounts` : p.accounts[0]}` : ""}
                  </span>
                </span>
                <span className="text-right">
                  <span className="num block text-[14px] font-semibold text-ink">{dollars(p.value)}</span>
                  {p.gain !== null && (
                    <span className={cx("num block text-[12px]", p.gain >= 0n ? "text-pos" : "text-over")} title={p.costBasis !== null ? `Cost ${formatMilli(p.costBasis)}` : undefined}>
                      {signed(p.gain)} gain
                    </span>
                  )}
                </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** One fund (or coin) across the shown account(s): value and price over the period, and its numbers. */
function FundCard({ data, symbol, periodLong, multi }: { data: InvestmentsPage; symbol: string; periodLong: string; multi: boolean }) {
  const [show, setShow] = useState<"value" | "price">("value");
  const p = data.holdings.positions.find((x) => x.symbol === symbol)!;
  const s = data.funds[symbol];
  const prices = s?.prices ?? [];
  const firstPrice = prices.find((x) => x !== null) ?? null;
  const lastPrice = [...prices].reverse().find((x) => x !== null) ?? null;
  const priceChange = firstPrice !== null && lastPrice !== null ? lastPrice - firstPrice : null;
  const qty = Number(p.quantity);
  const values = show === "value" ? (s?.values ?? []) : prices.map((x) => x ?? 0n);
  const held = values.findIndex((v) => v !== 0n);
  const from = held < 0 ? 0 : held;
  return (
    <section id="fund" aria-label={`${symbol} details`} className="card relative scroll-mt-4 p-5 sm:p-6" data-testid="invest-fund">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h2 className="font-mono text-[18px] font-semibold text-ink">{symbol}</h2>
            <span className="text-[12.5px] text-ink-3">{CLASS_LABEL[p.assetClass]}</span>
          </div>
          <p className="truncate text-[13.5px] text-ink-2">{p.name ?? symbol}</p>
          {multi && <p className="text-[12.5px] text-ink-3">In {p.accounts.join(", ")}</p>}
        </div>
        <div role="group" aria-label="Chart" className="flex gap-0.5">
          {(["value", "price"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setShow(k)}
              aria-pressed={show === k}
              className={cx("min-h-9 rounded-[8px] px-3 text-[13px] font-semibold transition-colors", show === k ? "bg-paper-hover text-ink" : "text-ink-3 hover:text-ink-2")}
            >
              {k === "value" ? "Your value" : "Price"}
            </button>
          ))}
        </div>
      </header>
      <dl className="mb-5 grid grid-cols-2 gap-x-6 gap-y-3 text-[12.5px] sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <dt className="text-ink-3">Value</dt>
          <dd className="num text-[17px] font-semibold text-ink">{dollars(p.value)}</dd>
        </div>
        <div>
          <dt className="text-ink-3">{p.assetClass === "crypto" ? "Coins" : "Shares"}</dt>
          <dd className="num text-[17px] font-semibold text-ink">{qty.toLocaleString("en-US", { maximumFractionDigits: p.assetClass === "crypto" ? 8 : 3 })}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Price</dt>
          <dd className="num text-[17px] font-semibold text-ink">{lastPrice !== null ? formatMilli(lastPrice) : "—"}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Price, {periodLong}</dt>
          <dd className={cx("num text-[17px] font-semibold", priceChange === null ? "text-ink" : priceChange >= 0n ? "text-pos" : "text-over")}>{priceChange !== null ? (pctChange(priceChange, firstPrice) ?? "—") : "—"}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Gain</dt>
          <dd className={cx("num text-[17px] font-semibold", p.gain === null ? "text-ink" : p.gain >= 0n ? "text-pos" : "text-over")}>
            {p.gain !== null ? signed(p.gain) : "—"}
            {p.gain !== null && p.costBasis ? <span className="ml-1 text-[12px] font-medium">{pctChange(p.gain, p.costBasis)}</span> : null}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Share of these accounts</dt>
          <dd className="num text-[17px] font-semibold text-ink">{(p.weightBps / 100).toFixed(1)}%</dd>
        </div>
      </dl>
      {s && values.length - from > 1 ? (
        <ValueChart
          key={show}
          dates={data.dates.slice(from)}
          layers={[{ id: symbol, label: show === "value" ? "Your value" : "Price", color: "var(--accent)", values: values.slice(from) }]}
          height={220}
          label={`${symbol} ${show === "value" ? "value" : "price"}, ${periodLong}`}
        />
      ) : (
        <p className="py-6 text-center text-[13.5px] text-ink-3">Not enough history for a chart yet. It fills in as the accounts sync each day.</p>
      )}
    </section>
  );
}

/** Anything SimpleFIN can't see (River Bitcoin, a stock held elsewhere): pick it, say how much. */
function InvestmentCard({ demo, today, open = false }: { demo: boolean; today: string; open?: boolean }) {
  return (
    <Card title="Add another investment" id="add-investment">
      <details open={open} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-ink-2 [&::-webkit-details-marker]:hidden">
          <span>Bitcoin at River, a stock or fund held somewhere else, or anything SimpleFIN can&apos;t see. Pick it and say how much you have; its value follows the price every hour.</span>
          <ChevronRight size={16} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
        </summary>
        <div className="mt-4">{demo ? <p className="text-[13px] text-ink-3">Adding accounts is turned off in the demo. The River (BTC) account above shows how it looks.</p> : <AddInvestmentForm today={today} />}</div>
      </details>
    </Card>
  );
}

/** How to add a Fidelity account (or any other brokerage) through SimpleFIN Bridge. */
function ConnectCard({ demo, open = false }: { demo: boolean; open?: boolean }) {
  return (
    <Card title="Add a Fidelity account" id="connect">
      <details open={open} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-ink-2 [&::-webkit-details-marker]:hidden">
          <span>Brokerage, Roth IRA and 401k accounts all come in the same way, through SimpleFIN. Add as many as you want.</span>
          <ChevronRight size={16} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
        </summary>
        <ol className="mt-4 grid gap-4 text-[14px] sm:grid-cols-3">
          {[
            {
              t: "Add Fidelity in SimpleFIN",
              b: (
                <>
                  Open{" "}
                  <a href="https://beta-bridge.simplefin.org" target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                    SimpleFIN Bridge
                  </a>
                  , choose Add institution and search Fidelity. A 401k through work may be listed as Fidelity NetBenefits; add that one too. Sign in on Fidelity&apos;s own page.
                </>
              ),
            },
            {
              t: "Let it sync",
              b: <>New accounts show up here on the next sync (four times a day), or right away with Sync now on Account registers. You don&apos;t need a new setup token.</>,
            },
            {
              t: "Check it once",
              b: (
                <>
                  New accounts are marked New. On{" "}
                  <Link href="/activity" className="font-medium text-accent hover:underline">
                    Account registers
                  </Link>
                  , tap Set up and pick Brokerage or Retirement, or Same as an existing one if you already track it by hand. No holdings showing? Upload Fidelity&apos;s Positions file in Settings → Imports.
                </>
              ),
            },
          ].map((s, i) => (
            <li key={s.t} className="flex gap-3">
              <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-rule-strong text-[13px] font-semibold text-ink-2">{i + 1}</span>
              <span>
                <span className="block font-semibold text-ink">{s.t}</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-2">{s.b}</span>
              </span>
            </li>
          ))}
        </ol>
        {demo && <p className="mt-4 text-[12.5px] text-ink-3">This is the demo, so nothing here connects to a real bank.</p>}
      </details>
    </Card>
  );
}
