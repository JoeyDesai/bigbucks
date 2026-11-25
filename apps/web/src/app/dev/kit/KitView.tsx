"use client";
import { useState, type ReactNode } from "react";
import { addDays, formatMilli, parseMilli } from "@homebase/shared";
import { bucketBar } from "@homebase/core/buckets";
import { cx } from "@/lib/cx";
import { BRAND } from "@/lib/brand";
import { rowDisplay } from "@/lib/bucket-display";
import type { CategoryChoice } from "@/lib/tx";
import { ACCENTS, type AccentId } from "@/components/settings/AccentPicker";
import { BalanceChart, type ChartPoint } from "@/components/glow/BalanceChart";
import { BucketBar } from "@/components/glow/BucketBar";
import { BucketPicker } from "@/components/glow/BucketPicker";
import { SHORTCUTS } from "@/components/glow/ShortcutSheet";
import { Sparkline } from "@/components/glow/Sparkline";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { Mark } from "@/components/shell/Mark";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

const $ = parseMilli;

const BUCKETS = [
  { name: "Groceries", icon: "shopping-basket", budget: "950", spent: "594.20" },
  { name: "Gas", icon: "fuel", budget: "220", spent: "196.40" },
  { name: "Internet", icon: "wifi", budget: "79.99", spent: "79.99" },
  { name: "Eating Out", icon: "utensils", budget: "320", spent: "412.75" },
  { name: "Misc", icon: "shapes", budget: "550", spent: "1380" },
  { name: "Car", icon: "car", budget: null, spent: "45" },
] as const;

const CHOICES: CategoryChoice[] = [
  { id: "g", name: "Groceries", groupName: "Needs", icon: "shopping-basket" },
  { id: "gas", name: "Gas", groupName: "Needs", icon: "fuel" },
  { id: "gi", name: "Gifts", groupName: "Wants", icon: "gift" },
  { id: "eo", name: "Eating Out", groupName: "Wants", icon: "utensils" },
  { id: "hp", name: "House Projects", groupName: "Savings", icon: "hammer" },
  { id: "m", name: "Misc", groupName: "Needs", icon: "shapes" },
];

function series(days: number, start: number, seed = 7): ChartPoint[] {
  let v = start;
  let s = seed;
  const out: ChartPoint[] = [];
  for (let i = 0; i < days; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    v += (r - 0.52) * 180 + (i % 14 === 0 ? 2400 : 0);
    out.push({ date: addDays("2025-10-23", i), balance: $(v.toFixed(2)) });
  }
  return out;
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="display text-[20px] text-ink">{title}</h2>
      {note && <p className="mt-1 max-w-[640px] text-[13px] text-ink-3">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Panel({ theme, accent }: { theme: "light" | "dark"; accent: AccentId }) {
  const [replay, setReplay] = useState(0);
  const [sheet, setSheet] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const toast = useToast();
  const custom = accent.startsWith("#") ? { ["--accent-l" as string]: accent, ["--accent-d" as string]: `color-mix(in srgb, ${accent} 74%, #fff)` } : undefined;
  return (
    <div data-theme={theme} data-accent={custom ? "custom" : accent} style={{ ...custom, background: "var(--canvas)" }} className="min-w-0 rounded-[24px] p-5 text-ink sm:p-7">
      <div className="flex items-center gap-2">
        <Mark size={24} className="rounded-[7px]" />
        <span className="display text-[17px]">{BRAND.name} · {theme}</span>
      </div>

      <Section title="Type" note="Geist for everything, tabular numerals for money, tight tracking on headlines.">
        <p className="display text-[48px] leading-none">$1,225 left</p>
        <p className="mt-2 text-[15px] text-ink-2">Body copy in Geist. Secondary ink for supporting text.</p>
        <p className="eyebrow mt-3">Group header</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {["↑", "↓", "Enter", "1", "x", "?"].map((k) => (
            <kbd key={k} className="kbd">
              {k}
            </kbd>
          ))}
        </div>
      </Section>

      <Section title="Bucket bars" note="The bar is what's left. Spent it all: empty. Over: the accent drains, then red fills back up. Amber from 85% spent. Bars fill with a staggered spring on mount.">
        <Button size="sm" onClick={() => setReplay((n) => n + 1)}>
          Replay animation
        </Button>
        <ul className="card mt-4 p-2" key={replay}>
          {BUCKETS.map((b, i) => {
            const budget = b.budget ? $(b.budget) : null;
            const spent = $(b.spent);
            const bar = bucketBar(budget, spent);
            const d = rowDisplay({ bar, budget, spent, remaining: bar.remaining, goal: budget ? { type: "need_set_aside", targetAmount: budget, amount: budget, kind: "monthly", cadence: "monthly", label: "", simple: true } : null, available: 0n, name: b.name });
            return (
              <li key={b.name} className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-3 px-3 py-3">
                <span className="row-span-2 flex h-10 w-10 items-center justify-center rounded-[12px] bg-accent-soft">
                  <CategoryIcon icon={b.icon} name={b.name} size={19} tone="accent" />
                </span>
                <div className="flex items-baseline justify-between">
                  <span className="text-[15px] font-medium">{b.name}</span>
                  <span className={cx("num text-[15px] font-semibold", d.tone === "over" ? "text-over" : d.tone === "warn" ? "text-warn" : d.tone === "muted" ? "text-ink-3" : "text-ink")}>
                    {d.done ? "Done" : `${formatMilli(d.amount, { cents: false })} ${d.amountSuffix}`}
                  </span>
                </div>
                <div className="col-start-2 mt-2">
                  {d.bar.state === "none" ? <div className="h-[10px] rounded-full border border-dashed border-rule-strong" /> : <BucketBar bar={d.bar} index={i} label={d.label} />}
                  <div className="mt-1.5 text-[12px] text-ink-3">{d.detail}</div>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Charts" note="Daily balance: range chips, draw-in, glow, hover or touch to scrub. Sparkline for the sidebar.">
        <BalanceChart points={series(366, 18000)} title="Checking balance" />
        <div className="card mt-4 flex items-center justify-between p-4">
          <span className="text-[13px] text-ink-3">Cash &amp; credit, 60 days</span>
          <Sparkline values={series(60, 40000, 3).map((p) => Number(p.balance) / 1000)} width={140} height={40} />
        </div>
      </Section>

      <Section title="Bucket picker" note="Type to filter (fuzzy: “gro”, “eo” for Eating Out). Suggestions are tagged Suggested.">
        <div className="card w-[320px] overflow-hidden">
          <BucketPicker choices={CHOICES} suggestions={[{ categoryId: "m", confidence: 0.82, source: "ai" }, { categoryId: "hp", confidence: 0.12, source: "ai" }]} recentIds={["g", "gas"]} onPick={(c) => setPicked(c.name)} onClose={() => setPicked(null)} maxHeight={260} />
        </div>
        {picked && <p className="mt-2 text-[13px] text-ink-2">Picked {picked}</p>}
      </Section>

      <Section title="Sheet and toast">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setSheet(true)}>Open sheet</Button>
          <Button onClick={() => toast.show({ message: "Kroger → Groceries", action: { label: "Undo", onAction: () => {} }, secondary: { label: "All 3 from Kroger", onAction: () => {} } })}>Toast with Undo</Button>
          <Button variant="primary">Primary</Button>
        </div>
        <Sheet open={sheet} onClose={() => setSheet(false)} title="Groceries">
          <p className="text-[14px] text-ink-2">Bottom sheet on phones, side panel on desktop.</p>
        </Sheet>
      </Section>

      <Section title="Shortcuts">
        <ul className="grid gap-1.5 text-[13px] text-ink-2 sm:grid-cols-2">
          {SHORTCUTS.flatMap((g) => g.items).map((it) => (
            <li key={it.label} className="flex items-center justify-between gap-2">
              {it.label}
              <span className="flex gap-1">
                {it.keys.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/** /dev/kit: the glow components in light and dark side by side, for any accent. */
export function KitView() {
  const [accent, setAccent] = useState<AccentId>("blue");
  return (
    <div className="min-h-dvh px-4 py-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="display text-[24px]">UI kit</h1>
        <span className="ml-auto flex gap-1.5" role="radiogroup" aria-label="Preview accent">
          {[...ACCENTS, { id: "#ff8a3d" as const, label: "Custom", color: "#ff8a3d" }].map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={accent === a.id} aria-label={`Preview ${a.label} accent`} onClick={() => setAccent(a.id)} className={cx("h-7 w-7 rounded-full", accent === a.id && "ring-2 ring-ink ring-offset-2 ring-offset-paper")} style={{ background: a.color }} />
          ))}
        </span>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel theme="light" accent={accent} />
        <Panel theme="dark" accent={accent} />
      </div>
    </div>
  );
}
