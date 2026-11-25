"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { formatMonth, type Month } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { dollars, monthParam, pct } from "@/lib/format";
import { bucketStats, colorSlots, donutSlices, monthBuckets, monthSummary, slotColor } from "@/lib/reflect";
import { MonthNav } from "@/components/glow/MonthNav";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { MonthBars, TipRow, shortMonth } from "@/components/reflect/MonthBars";
import { SpendDonut } from "@/components/reflect/SpendDonut";
import { UserMenu } from "@/components/shell/UserMenu";
import type { ReflectPage } from "@/server/queries/glow";

const LEGEND_ROWS = 8;

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

function Stat({ label, value, note, tone, testId }: { label: string; value: bigint; note?: React.ReactNode; tone?: "pos" | "over"; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId} data-value={value.toString()}>
      <div className="text-[13px] font-medium text-ink-3">{label}</div>
      <div className={cx("num display mt-1 text-[30px] leading-none sm:text-[36px]", tone === "pos" ? "text-pos" : tone === "over" ? "text-over" : "text-ink")}>
        {dollars(value < 0n ? -value : value)}
      </div>
      {note && <div className="mt-2 text-[12.5px] text-ink-3">{note}</div>}
    </div>
  );
}

/** Reflect: where the money went this month, how every month compares, and any one bucket over time. */
export function ReflectView({ data, currentMonth, initialBucket }: { data: ReflectPage; currentMonth: Month; initialBucket: string | null }) {
  const router = useRouter();
  const i = data.months.length - 1;
  const month = data.months[i]!;
  const current = month === currentMonth;
  const monthName = formatMonth(month).split(" ")[0]!;
  const slots = useMemo(() => colorSlots(data.buckets), [data.buckets]);
  const rows = useMemo(() => monthBuckets(data, i, slots), [data, i, slots]);
  const { slices, total } = useMemo(() => donutSlices(rows), [rows]);
  const sum = monthSummary(data, i);
  const [active, setActive] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const byTotal = useMemo(() => [...data.buckets].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0)), [data.buckets]);
  const [bucketId, setBucketId] = useState<string | null>(() => (initialBucket && data.buckets.some((b) => b.id === initialBucket) ? initialBucket : (rows[0]?.id ?? byTotal[0]?.id ?? null)));
  const bucket = data.buckets.find((b) => b.id === bucketId) ?? null;
  const stats = bucket ? bucketStats(bucket, data.months, i) : null;
  const goal = bucket ? (data.goals[bucket.id] ?? null) : null;
  const historyRef = useRef<HTMLDivElement>(null);

  const pick = (id: string) => {
    if (id === "other") return setShowAll(true);
    setBucketId(id);
    requestAnimationFrame(() =>
      historyRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    );
  };
  // switching months keeps the bucket that's open in Bucket history
  const hrefFor = useCallback((m: Month) => `/reflect?m=${monthParam(m)}${bucketId ? `&b=${bucketId}` : ""}`, [bucketId]);
  const goMonth = (k: number) => router.push(hrefFor(data.months[k]!), { scroll: false });

  const diff = sum.usual !== null ? sum.spent - sum.usual : null;
  const legend = showAll ? rows : rows.slice(0, LEGEND_ROWS);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pb-6 pt-3 sm:px-6 lg:px-10 lg:pt-8">
      <header className="mb-4 flex items-center gap-2 lg:mb-6">
        <h1 className="display flex-1 text-[28px] leading-tight text-ink lg:text-[32px]">Reflect</h1>
        <MonthNav month={month} hrefFor={hrefFor} currentMonth={currentMonth} min={data.first} max={currentMonth} className="hidden sm:flex" />
        <div className="-mr-2 lg:hidden">
          <UserMenu />
        </div>
      </header>
      <MonthNav month={month} hrefFor={hrefFor} currentMonth={currentMonth} min={data.first} max={currentMonth} className="-mx-1 mb-3 justify-center sm:hidden" />

      <div className="hb-rise grid grid-cols-[minmax(0,1fr)] gap-5 lg:gap-6">
        <section aria-label={`${formatMonth(month)} at a glance`} className="card relative overflow-hidden p-5 sm:p-6">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-20 -top-28 h-64 w-64 rounded-full opacity-50 blur-3xl"
            style={{
              background: "radial-gradient(closest-side, var(--accent-glow), transparent)",
            }}
          />
          <div className="relative grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
            <Stat
              label={current ? "Spent so far" : `Spent in ${monthName}`}
              value={sum.spent}
              testId="reflect-spent"
              note={
                diff !== null && sum.usual !== null && sum.usual > 0n ? (
                  <>
                    <span className={cx("num font-semibold", diff > 0n ? "text-over" : "text-pos")}>{dollars(diff < 0n ? -diff : diff)}</span> {diff > 0n ? "more" : "less"} than your usual{" "}
                    {dollars(sum.usual)}
                  </>
                ) : undefined
              }
            />
            <Stat label="Came in" value={sum.income} testId="reflect-income" />
            <Stat
              label={sum.kept >= 0n ? "Kept" : "Spent more than came in"}
              value={sum.kept}
              tone={sum.kept >= 0n ? "pos" : "over"}
              testId="reflect-kept"
              note={sum.income > 0n && sum.kept > 0n ? `${pct(Number((sum.kept * 1000n) / sum.income) / 1000)} of what came in` : undefined}
            />
          </div>
          {data.uncategorized[i]! > 0n && <p className="relative mt-4 text-[12.5px] text-ink-3">Plus {dollars(data.uncategorized[i]!)} not in a bucket yet, not counted above.</p>}
        </section>

        <Card title="Where it went" aside={<span className="text-[12.5px] text-ink-3">Tap a bucket to see its history</span>}>
          {rows.length === 0 ? (
            <p className="py-10 text-center text-[14px] text-ink-3">No spending in {monthName} yet.</p>
          ) : (
            <div className="grid items-center gap-6 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)] lg:gap-10">
              <SpendDonut slices={slices} total={total} active={active} onActive={setActive} onSelect={pick} monthLabel={monthName} />
              <div>
                <ul className="-mx-2 grid gap-x-6 lg:grid-cols-2" data-testid="reflect-legend">
                  {legend.map((r) => {
                    const sliceId = r.slot !== null ? r.id : "other";
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => pick(r.id)}
                          onPointerEnter={() => setActive(sliceId)}
                          onPointerLeave={() => setActive(null)}
                          onFocus={() => setActive(sliceId)}
                          onBlur={() => setActive(null)}
                          aria-pressed={bucketId === r.id}
                          className={cx(
                            "grid w-full grid-cols-[10px_18px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-paper-hover",
                            bucketId === r.id && "bg-paper-hover",
                          )}
                        >
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: slotColor(r.slot) }} aria-hidden />
                          <CategoryIcon icon={r.icon} name={r.name} size={16} />
                          <span className="truncate text-[14px] text-ink">{r.name}</span>
                          <span className="num text-right text-[13.5px]">
                            <span className="font-semibold text-ink">{dollars(r.spent)}</span>
                            <span className="ml-2 inline-block w-9 text-ink-3">{pct(r.share)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {rows.length > LEGEND_ROWS && (
                  <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
                    {showAll ? "Show fewer" : `Show all ${rows.length} buckets`}
                    <ChevronDown size={14} className={cx("transition-transform", showAll && "rotate-180")} aria-hidden />
                  </button>
                )}
              </div>
            </div>
          )}
        </Card>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-6">
          <Card title="Every month" aside={<span className="text-[12.5px] text-ink-3">Tap a month to open it</span>}>
            <MonthBars
              months={data.months}
              values={data.spent}
              selected={i}
              onSelect={goMonth}
              marker={{ values: data.income, label: "Came in" }}
              label={`Spending per month, ${shortMonth(data.months[0]!, true)} to ${shortMonth(month, true)}`}
              testId="reflect-months"
              tooltip={(k) => (
                <>
                  <TipRow label="Spent" value={data.spent[k]!} />
                  <TipRow label="Came in" value={data.income[k]!} />
                  <TipRow label={data.income[k]! - data.spent[k]! >= 0n ? "Kept" : "Short"} value={data.income[k]! - data.spent[k]!} tone={data.income[k]! - data.spent[k]! >= 0n ? "pos" : "over"} />
                </>
              )}
            />
          </Card>
          {data.places.length > 0 && (
            <Card title={`Top places in ${monthName}`}>
              <ol className="grid gap-x-8" data-testid="reflect-places">
                {data.places.map((p, k) => (
                  <li key={p.name} className="flex items-center gap-3 border-b border-rule py-2.5 last:border-0">
                    <span className="num w-5 text-[13px] font-semibold text-ink-3">{k + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-ink">{p.name}</span>
                      <span className="text-[12px] text-ink-3">
                        {p.count} {p.count === 1 ? "purchase" : "purchases"}
                      </span>
                    </span>
                    <span className="num text-[14px] font-semibold text-ink">{dollars(p.spent)}</span>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>

        <div ref={historyRef} className="scroll-mt-4">
          <Card
            title="Bucket history"
            aside={
              <label className="relative inline-flex items-center">
                <span className="sr-only">Bucket</span>
                <select
                  value={bucketId ?? ""}
                  onChange={(e) => setBucketId(e.target.value)}
                  className="h-10 appearance-none rounded-full border border-rule-strong bg-paper pl-4 pr-9 text-[14px] font-medium text-ink outline-none transition-colors hover:border-accent/60 focus-visible:border-accent"
                  data-testid="reflect-bucket"
                >
                  {byTotal.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} className="pointer-events-none absolute right-3 text-ink-3" aria-hidden />
              </label>
            }
          >
            {bucket && stats ? (
              <>
                <div className="mb-5 flex flex-wrap items-center gap-x-8 gap-y-4">
                  <div className="flex items-center gap-3">
                    <span
                      className="flex h-11 w-11 items-center justify-center rounded-[13px]"
                      style={{
                        background: `color-mix(in srgb, ${slotColor(slots.get(bucket.id))} 18%, transparent)`,
                      }}
                    >
                      <CategoryIcon icon={bucket.icon} name={bucket.name} size={20} tone="inherit" className="text-ink" />
                    </span>
                    <div>
                      <div className="text-[16px] font-semibold text-ink">{bucket.name}</div>
                      <div className="text-[12.5px] text-ink-3">{bucket.groupName}</div>
                    </div>
                  </div>
                  <dl className="grid grid-cols-3 gap-x-8 gap-y-1 text-[12.5px]">
                    <div>
                      <dt className="text-ink-3">{monthName}</dt>
                      <dd className="num text-[18px] font-semibold text-ink">{dollars(bucket.spent[i]!)}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-3">Average month</dt>
                      <dd className="num text-[18px] font-semibold text-ink">{dollars(stats.average)}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-3">
                        Highest
                        {stats.highest ? ` (${shortMonth(stats.highest.month)})` : ""}
                      </dt>
                      <dd className="num text-[18px] font-semibold text-ink">{dollars(stats.highest?.spent ?? 0n)}</dd>
                    </div>
                  </dl>
                </div>
                <MonthBars
                  key={bucket.id}
                  months={data.months}
                  values={bucket.spent}
                  selected={i}
                  onSelect={goMonth}
                  color={slotColor(slots.get(bucket.id))}
                  goal={goal ? { value: goal, label: `Goal ${dollars(goal)}` } : null}
                  label={`${bucket.name} spending per month`}
                  testId="reflect-bucket-chart"
                  tooltip={(k) => (
                    <>
                      <TipRow label="Spent" value={bucket.spent[k]!} />
                      {goal ? <TipRow label={bucket.spent[k]! > goal ? "Over goal" : "Under goal"} value={bucket.spent[k]! - goal} tone={bucket.spent[k]! > goal ? "over" : "pos"} /> : null}
                    </>
                  )}
                />
                <p className="mt-3 text-[12.5px] text-ink-3">
                  {dollars(stats.total)} over these {data.months.length} months.
                </p>
              </>
            ) : (
              <p className="py-10 text-center text-[14px] text-ink-3">No spending in these months yet.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
