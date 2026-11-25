"use client";
import { BRAND } from "@/lib/brand";
import { useState, useTransition } from "react";
import Link from "next/link";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { formatDay } from "@/lib/format";
import { mortgageScenarioAction, setHomeValueAction, type ScenarioVM } from "@/server/actions/wealth";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { LineChart, StackedBarChart } from "@/components/charts/CartesianCharts";
import { DonutChart, DonutLegend } from "@/components/charts/DonutChart";
import { fmtMonthTick } from "@/components/charts/util";
import { AmountInput } from "@/components/ui/AmountInput";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { Money } from "@/components/ui/Money";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useToast } from "@/components/ui/Toast";

const monthTick = (d: string) => fmtMonthTick(`${d.slice(0, 7)}-01`);
const yearTick = (d: string) => d.slice(0, 4);
const CLASS_LABEL: Record<string, string> = { us_stock: "US stock", intl_stock: "International stock", target_date: "Target date", bond: "Bonds", cash: "Cash", crypto: "Crypto", other: "Other" };

export interface HoldingRow {
  symbol: string;
  name: string | null;
  quantity: string;
  price: string | null;
  marketValue: bigint;
  gain: bigint | null;
  weightBps: number;
}

export function AccountDetail({
  invest,
  history,
  holdings,
  growth,
  registerHref,
}: {
  invest: boolean;
  history: { date: string; value: bigint }[];
  holdings: { asOf: string | null; total: bigint; positions: HoldingRow[]; allocation: { assetClass: string; marketValue: bigint; weightBps: number }[] } | null;
  growth: { month: string; contributions: bigint; market: bigint; known: boolean }[];
  registerHref?: string;
}) {
  const allocation = holdings?.allocation.map((a) => ({ label: CLASS_LABEL[a.assetClass] ?? a.assetClass, value: a.marketValue })) ?? [];
  return (
    <div className="mt-8 space-y-12">
      {registerHref && (
        <Link href={registerHref} className="inline-flex min-h-11 items-center text-[14px] text-accent underline-offset-4 hover:underline">
          Open the register
        </Link>
      )}
      {history.length > 1 ? (
        <ChartFrame title="Value over time" subtitle="Month-end balances, last 12 months" summary="Account value by month" height={220}>
          <LineChart data={history} xKey="date" xFormat={monthTick} series={[{ key: "value", label: "Value" }]} />
        </ChartFrame>
      ) : (
        <p className="text-[14px] text-ink-3">Not enough balance history for a chart yet.</p>
      )}

      {invest && growth.length > 0 && (
        <div>
          <ChartFrame title="Monthly growth" subtitle="Contributions vs market change" summary="Monthly contributions and market change" height={220}>
            <StackedBarChart
              data={growth.map((g) => ({ month: g.month, contributions: g.contributions, market: g.market }))}
              xKey="month"
              series={[
                { key: "contributions", label: "Contributions" },
                { key: "market", label: "Market change", color: "var(--chart-3)" },
              ]}
            />
          </ChartFrame>
          {growth.some((g) => !g.known) && (
            <p className="mt-2 text-[12px] text-ink-3">No contribution source is set for some months, so their market change includes contributions. Set a monthly contribution in Settings → Accounts.</p>
          )}
        </div>
      )}

      {invest && holdings && (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section aria-label="Holdings" className="min-w-0">
            <h2 className="display mb-1 text-[20px]">Holdings</h2>
            {holdings.asOf && <p className="mb-3 text-[12px] text-ink-3">As of {formatDay(holdings.asOf, { withYear: true })}</p>}
            <DataTable
              caption="Holdings"
              rows={holdings.positions}
              rowKey={(h) => h.symbol}
              columns={[
                {
                  key: "sym",
                  header: "Fund",
                  render: (h) => (
                    <span>
                      <span className="font-medium">{h.symbol}</span>
                      {h.name && <span className="block text-[12px] text-ink-3">{h.name}</span>}
                    </span>
                  ),
                },
                { key: "qty", header: "Shares", numeric: true, desktopOnly: true, render: (h) => Number(h.quantity).toLocaleString("en-US", { maximumFractionDigits: 4 }) },
                { key: "w", header: "Weight", numeric: true, desktopOnly: true, render: (h) => `${(h.weightBps / 100).toFixed(1)}%` },
                { key: "val", header: "Value", numeric: true, render: (h) => <Money value={h.marketValue} /> },
                { key: "gain", header: "Gain", numeric: true, render: (h) => (h.gain === null ? <span className="text-ink-3">—</span> : <Money value={h.gain} tone="signed" sign="always" />) },
              ]}
            />
          </section>
          {allocation.length > 0 && (
            <ChartFrame title="Allocation" summary="Allocation by asset class" height={200} footer={<DonutLegend data={allocation} />}>
              <DonutChart data={allocation} centerLabel="Invested" />
            </ChartFrame>
          )}
        </div>
      )}
    </div>
  );
}

// ── Home ────────────────────────────────────────────────────────────────────

export function HomeDetailView({
  assetId,
  latest,
  valuations,
  equitySeries,
  equity,
  mortgageBalance,
  purchasePrice,
  purchaseDate,
  appreciation,
}: {
  assetId: string;
  latest: { value: bigint; low: bigint | null; high: bigint | null; asOf: string; source: string; comps: Record<string, unknown>[] } | null;
  valuations: { date: string; value: bigint; low: bigint | null; high: bigint | null }[];
  equitySeries: { date: string; value: bigint; mortgage: bigint; equity: bigint }[];
  equity: bigint | null;
  mortgageBalance: bigint;
  purchasePrice: bigint | null;
  purchaseDate: string | null;
  appreciation: bigint | null;
}) {
  const toast = useToast();
  const [override, setOverride] = useState<bigint | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mt-6 space-y-12">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-[14px] lg:grid-cols-4">
        <div>
          <dt className="eyebrow">Estimate range</dt>
          <dd className="num mt-1">{latest?.low != null && latest.high != null ? `${formatMilli(latest.low, { cents: false })} – ${formatMilli(latest.high, { cents: false })}` : "—"}</dd>
        </div>
        <div>
          <dt className="eyebrow">Equity</dt>
          <dd className="num mt-1 text-pos">{equity !== null ? formatMilli(equity, { cents: false }) : "—"}</dd>
        </div>
        <div>
          <dt className="eyebrow">Mortgage owed</dt>
          <dd className="num mt-1 text-neg">{formatMilli(-mortgageBalance, { cents: false })}</dd>
        </div>
        <div>
          <dt className="eyebrow">Since purchase</dt>
          <dd className="num mt-1">
            {appreciation !== null ? formatMilli(appreciation, { sign: "always", cents: false }) : "—"}
            {purchaseDate && <span className="block text-[12px] text-ink-3">bought {formatDay(purchaseDate, { withYear: true })}{purchasePrice ? ` for ${formatMilli(purchasePrice, { cents: false })}` : ""}</span>}
          </dd>
        </div>
      </dl>
      {latest && <p className="text-[12px] text-ink-3">Latest estimate {formatDay(latest.asOf, { withYear: true })} · {latest.source === "manual" ? "entered by hand" : "RentCast"}</p>}

      <ChartFrame title="Value history" subtitle="Estimate with its low–high range" summary="Home value estimates with range" height={220}>
        <LineChart
          data={valuations.map((v) => ({ date: v.date, value: v.value, low: v.low ?? v.value, high: v.high ?? v.value }))}
          xKey="date"
          xFormat={monthTick}
          series={[
            { key: "high", label: "High", color: "var(--rule-strong)" },
            { key: "value", label: "Estimate" },
            { key: "low", label: "Low", color: "var(--rule-strong)" },
          ]}
        />
      </ChartFrame>

      <ChartFrame title="Equity" subtitle="Value minus what's owed" summary="Home equity over time" height={200}>
        <LineChart data={equitySeries.map((e) => ({ date: e.date, equity: e.equity }))} xKey="date" xFormat={monthTick} series={[{ key: "equity", label: "Equity", color: "var(--pos-bar)" }]} />
      </ChartFrame>

      {latest && latest.comps.length > 0 && (
        <section aria-label="Comparable homes">
          <h2 className="display mb-2 text-[20px]">Comparables</h2>
          <ul className="border-t border-rule text-[14px]">
            {latest.comps.map((c, i) => (
              <li key={i} className="flex justify-between gap-3 border-b border-rule py-2">
                <span>
                  {String(c.address ?? c.formattedAddress ?? "Comparable")}
                  {typeof c.distance_mi === "number" && <span className="text-ink-3"> · {c.distance_mi} mi</span>}
                </span>
                <span className="num">{typeof c.price === "number" ? `$${c.price.toLocaleString("en-US")}` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Manual value" className="max-w-sm">
        <h2 className="display mb-1 text-[20px]">Set the value yourself</h2>
        <p className="mb-3 text-[13px] text-ink-2">An appraisal or a better estimate replaces RentCast’s number from today on.</p>
        <div className="flex items-end gap-2">
          <AmountInput tapToEdit={false} hideLabel={false} allowNegative={false} label="Home value" value={override ?? latest?.value ?? 0n} onCommit={setOverride} className="flex-1" />
          <Button
            busy={pending}
            disabled={override === null}
            onClick={() =>
              start(async () => {
                const r = await setHomeValueAction({ assetId, value: override! });
                toast.show(r.ok ? { message: `Home value set to ${formatMilli(override!, { cents: false })}` } : { message: r.error, tone: "error" });
                if (r.ok) setOverride(null);
              })
            }
          >
            Save
          </Button>
        </div>
      </section>
    </div>
  );
}

// ── Mortgage ────────────────────────────────────────────────────────────────

type Mode = "extra" | "lump" | "recast";

export function MortgageDetailView(p: {
  accountId: string;
  today: string;
  servicer: string | null;
  ratePct: string;
  payment: bigint;
  escrow: bigint;
  owed: bigint;
  scheduledBalance: bigint;
  drift: bigint | null;
  driftFlagged: boolean;
  payoffDate: string | null;
  interestPaid: bigint;
  principalPaid: bigint;
  remainingInterest: bigint;
  nextPayment: { date: string; principal: bigint; interest: bigint; escrow: bigint; total: bigint } | null;
  base: { date: string; balance: bigint }[];
  totalInterest: bigint;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("extra");
  const [amount, setAmount] = useState<bigint>(500_000n);
  const [scenario, setScenario] = useState<ScenarioVM | null>(null);
  const [pending, start] = useTransition();

  const runScenario = () =>
    start(async () => {
      const s = mode === "extra" ? { extraMonthly: amount } : mode === "lump" ? { lumpSum: { date: p.today, amount } } : { recast: { date: p.today, lumpSum: amount } };
      const r = await mortgageScenarioAction(p.accountId, s);
      if (!r.ok) return void toast.show({ message: r.error, tone: "error" });
      setScenario(r.scenario);
    });

  const byDate = new Map(scenario?.series.map((s) => [s.date.slice(0, 4), s.balance]) ?? []);
  const chart = p.base.map((b) => ({ date: b.date, current: b.balance, ...(scenario ? { scenario: byDate.get(b.date.slice(0, 4)) ?? 0n } : {}) }));

  return (
    <div className="mt-6 space-y-12">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-[14px] lg:grid-cols-4">
        <div>
          <dt className="eyebrow">Paid off</dt>
          <dd className="mt-1">{p.payoffDate ? formatDay(p.payoffDate, { withYear: true }) : "—"}</dd>
        </div>
        <div>
          <dt className="eyebrow">Rate</dt>
          <dd className="num mt-1">{Number(p.ratePct).toFixed(3)}%</dd>
        </div>
        <div>
          <dt className="eyebrow">Payment</dt>
          <dd className="num mt-1">
            {formatMilli(p.payment)} <span className="text-[12px] text-ink-3">+ {formatMilli(p.escrow)} escrow</span>
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Interest paid so far</dt>
          <dd className="num mt-1">{formatMilli(p.interestPaid, { cents: false })}</dd>
        </div>
      </dl>
      {p.nextPayment && (
        <p className="text-[13px] text-ink-2">
          Next payment {formatDay(p.nextPayment.date, { withYear: true })}: <span className="num">{formatMilli(p.nextPayment.principal)}</span> principal,{" "}
          <span className="num">{formatMilli(p.nextPayment.interest)}</span> interest. Interest left on the schedule: <span className="num">{formatMilli(p.remainingInterest, { cents: false })}</span>.
        </p>
      )}
      {p.driftFlagged && p.drift !== null && (
        <p className="border-l-2 border-warn-bar pl-3 text-[13px] text-warn">
          The servicer’s balance differs from the amortization schedule by {formatMilli(p.drift, { sign: "always" })}. An extra payment or a rate change may be missing from the loan events.
        </p>
      )}

      <ChartFrame title="Amortization" subtitle={scenario ? "Current schedule vs your scenario" : "Remaining balance by year"} summary="Mortgage balance over time" height={240}>
        <LineChart
          data={chart}
          xKey="date"
          xFormat={yearTick}
          series={[{ key: "current", label: "Current schedule", color: "var(--ink-3)" }, ...(scenario ? [{ key: "scenario", label: "With scenario", color: "var(--pos-bar)" }] : [])]}
        />
      </ChartFrame>

      <section aria-label="Extra payment simulator" className="max-w-xl">
        <h2 className="display text-[20px]">What if…</h2>
        <SegmentedControl
          className="mt-3"
          label="Scenario"
          block
          value={mode}
          onChange={(m) => {
            setMode(m);
            setScenario(null);
          }}
          options={[
            { value: "extra", label: "Extra monthly" },
            { value: "lump", label: "One-time" },
            { value: "recast", label: "Recast" },
          ]}
        />
        <div className="mt-4 flex items-end gap-2">
          <AmountInput tapToEdit={false} hideLabel={false} allowNegative={false} label={mode === "extra" ? "Extra principal each month" : mode === "lump" ? "Lump sum today" : "Lump sum, then recast"} value={amount} onCommit={setAmount} className="flex-1" />
          <Button variant="primary" busy={pending} onClick={runScenario}>
            Run
          </Button>
        </div>
        {scenario && (
          <dl className="mt-5 border-t border-rule text-[14px]">
            {[
              ["Paid off", scenario.payoffDate ? formatDay(scenario.payoffDate, { withYear: true }) : "—"],
              ["Months sooner", String(scenario.monthsSaved)],
              ["Interest saved", formatMilli(scenario.interestSaved, { cents: false })],
              ...(scenario.newPayment ? [["New payment", formatMilli(scenario.newPayment)]] : []),
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-rule py-2">
                <dt className="text-ink-2">{k}</dt>
                <dd className={cx("num", k === "Interest saved" && "text-pos")}>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-3 text-[12px] text-ink-3">A simulation only. Nothing is sent to the servicer; {BRAND.name} never moves money.</p>
      </section>
    </div>
  );
}
