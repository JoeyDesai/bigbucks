"use client";
import { BRAND } from "@/lib/brand";
import { useState, useTransition } from "react";
import { formatMilli, parseMilli } from "@homebase/shared";
import { clearAnthropicKeyAction, saveAiBudgetAction, saveAiModelsAction, saveApprovalPolicyAction, setAnthropicKeyAction } from "@/server/settings/actions/admin";
import { setAlwaysReviewAction } from "@/server/settings/actions/household";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { StackedBarChart } from "@/components/charts/CartesianCharts";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cx } from "@/lib/cx";
import { SettingsSection } from "./SettingsFrame";
import { FormStatus, TextField, ToggleRow } from "./fields";

export interface AiSettingsProps {
  key_: { source: "settings" | "env" | null; last4: string | null; error?: string };
  models: { chat: string; deep: string; categorize: string; merchant_lookup: string; digest: string };
  budget: { monthly_cap_usd: number; warn_at_fraction: number; web_lookup_enabled: boolean };
  policy: { auto_approve_rule_history_min_confidence: number; auto_approve_ai_min_confidence: number; auto_approve_ai_max_abs_milli: string; auto_categorize_min_confidence: number; income_review_over_milli: string; income_review_first_n: number };
  spentMicro: string;
  capMicro: string;
  usage: { month: string; byPurpose: Record<string, string>; total: string }[];
  byModel: { model: string; calls: number; inputTokens: number; outputTokens: number; micro: string }[];
  accuracy: { month: string; live: { accepted: number; corrected: number; pending: number }; shadow: { accepted: number; corrected: number } }[];
  categories: { id: string; name: string; group: string; alwaysReview: boolean; defaultReview: boolean }[];
  anyFlagged: boolean;
}

type R = { ok: true } | { ok: false; error: string } | null;
const usd = (micro: string | bigint, digits = 2) => `$${(Number(BigInt(micro)) / 1_000_000).toFixed(digits)}`;
const PURPOSES = [
  ["chat", "Ask"],
  ["categorize", "Categorize"],
  ["batch_categorize", "Batch"],
  ["merchant_lookup", "Merchant lookup"],
  ["digest", "Digest"],
  ["report", "Reports"],
] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mlabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ’${m.slice(2, 4)}`;

function KeyForm({ k }: { k: AiSettingsProps["key_"] }) {
  const [key, setKey] = useState("");
  const [r, setR] = useState<R>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <p className="mb-3 text-[14px] text-ink-2">
        {k.source === "settings" ? (
          <>
            Stored encrypted, ending <span className="num font-mono">••••{k.last4}</span>.
          </>
        ) : k.source === "env" ? (
          "Using ANTHROPIC_API_KEY from the server environment. A key saved here takes precedence."
        ) : (
          "No key yet. Ask, AI categorization and merchant lookups are off until you add one."
        )}
        {k.error ? <span className="block text-neg">{k.error}</span> : null}
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const res = await setAnthropicKeyAction(key);
            setR(res);
            if (res.ok) setKey("");
          });
        }}
      >
        <TextField label={k.source === "settings" ? "Replace key" : "API key"} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" spellCheck={false} className="min-w-[240px] flex-1" />
        <Button type="submit" variant="primary" disabled={!key.trim()} busy={pending}>
          Save key
        </Button>
        {k.source === "settings" && (
          <Button variant="ghost" onClick={() => start(async () => setR(await clearAnthropicKeyAction()))}>
            Remove
          </Button>
        )}
      </form>
      <div className="mt-2">
        <FormStatus result={r} />
      </div>
      <p className="mt-2 text-[12px] text-ink-3">Also set a workspace spend limit in the Anthropic Console as a second safety net.</p>
    </div>
  );
}

function ModelsForm({ models }: { models: AiSettingsProps["models"] }) {
  const [m, setM] = useState(models);
  const [r, setR] = useState<R>(null);
  const [pending, start] = useTransition();
  const rows: [keyof typeof m, string, string][] = [
    ["chat", "Ask (chat)", "Default for every question"],
    ["deep", "Deep analysis", "When the Deep analysis box is ticked"],
    ["categorize", "Categorization", "Real-time and nightly batch"],
    ["merchant_lookup", "Merchant lookup", "With web search, once per merchant"],
    ["digest", "Weekly digest", "Sunday evening summary"],
  ];
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setR(await saveAiModelsAction(m)));
      }}
    >
      {rows.map(([k, label, hint]) => (
        <TextField key={k} label={label} hint={hint} value={m[k]} onChange={(e) => setM((x) => ({ ...x, [k]: e.target.value }))} spellCheck={false} inputClassName="font-mono text-[14px]" />
      ))}
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" busy={pending}>
          Save models
        </Button>
        <FormStatus result={r} />
      </div>
    </form>
  );
}

function BudgetForm({ budget, spentMicro }: { budget: AiSettingsProps["budget"]; spentMicro: string }) {
  const [cap, setCap] = useState(String(budget.monthly_cap_usd));
  const [warn, setWarn] = useState(String(Math.round(budget.warn_at_fraction * 100)));
  const [web, setWeb] = useState(budget.web_lookup_enabled);
  const [r, setR] = useState<R>(null);
  const [pending, start] = useTransition();
  const save = (webOverride?: boolean) =>
    start(async () => {
      const c = Number(cap);
      const w = Number(warn) / 100;
      if (!Number.isFinite(c) || c < 0) return setR({ ok: false, error: "Enter a cap in dollars." });
      setR(await saveAiBudgetAction({ monthly_cap_usd: Math.round(c * 100) / 100, warn_at_fraction: Math.min(1, Math.max(0.1, w)), web_lookup_enabled: webOverride ?? web }));
    });
  return (
    <div>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextField label="Monthly cap ($)" hint={`Spent so far this month: ${usd(spentMicro)}. At 100% Ask pauses and categorization uses rules and history only.`} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
        <TextField label="Warn at (% of cap)" hint="Sends admins a push once per month." inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value.replace(/\D/g, ""))} />
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="primary" busy={pending}>
            Save budget
          </Button>
          <FormStatus result={r} />
        </div>
      </form>
      <div className="mt-6 border-t border-rule">
        <ToggleRow
          label="Merchant web lookup"
          description="Look up unfamiliar merchants with web search (only the merchant name and city are sent). About $0.01 per search."
          checked={web}
          onChange={(v) => {
            setWeb(v);
            save(v);
          }}
        />
      </div>
    </div>
  );
}

function PolicyForm({ policy }: { policy: AiSettingsProps["policy"] }) {
  const pct = (n: number) => String(Math.round(n * 100));
  const dol = (m: string) => formatMilli(BigInt(m), { sign: "never", cents: false }).replace(/[$,]/g, "");
  const [f, setF] = useState({
    rule: pct(policy.auto_approve_rule_history_min_confidence),
    ai: pct(policy.auto_approve_ai_min_confidence),
    aiMax: dol(policy.auto_approve_ai_max_abs_milli),
    cat: pct(policy.auto_categorize_min_confidence),
    incomeOver: dol(policy.income_review_over_milli),
    firstN: String(policy.income_review_first_n),
  });
  const [r, setR] = useState<R>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            setR(
              await saveApprovalPolicyAction({
                auto_approve_rule_history_min_confidence: Number(f.rule) / 100,
                auto_approve_ai_min_confidence: Number(f.ai) / 100,
                auto_approve_ai_max_abs_milli: parseMilli(f.aiMax || "0").toString(),
                auto_categorize_min_confidence: Number(f.cat) / 100,
                income_review_over_milli: parseMilli(f.incomeOver || "0").toString(),
                income_review_first_n: Number(f.firstN),
              }),
            );
          } catch {
            setR({ ok: false, error: "Amounts must be whole dollars." });
          }
        });
      }}
    >
      <TextField label="Auto-approve rule or history at (%)" inputMode="numeric" value={f.rule} onChange={set("rule")} hint="Default 95" />
      <TextField label="Auto-approve AI at (%)" inputMode="numeric" value={f.ai} onChange={set("ai")} hint="Default 95" />
      <TextField label="AI auto-approve only under ($)" inputMode="decimal" value={f.aiMax} onChange={set("aiMax")} hint="Default $150" />
      <TextField label="Auto-categorize, unapproved, at (%)" inputMode="numeric" value={f.cat} onChange={set("cat")} hint="Below this only suggestions are shown. Default 75" />
      <TextField label="Review income over ($)" inputMode="decimal" value={f.incomeOver} onChange={set("incomeOver")} hint="Default $500" />
      <TextField label="…the first N times per payee" inputMode="numeric" value={f.firstN} onChange={set("firstN")} hint="Default 3" />
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" busy={pending}>
          Save thresholds
        </Button>
        <FormStatus result={r} />
      </div>
    </form>
  );
}

function AlwaysReview({ categories, anyFlagged }: { categories: AiSettingsProps["categories"]; anyFlagged: boolean }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <div className={cx(pending && "opacity-80")}>
      {!anyFlagged && <p className="mb-3 text-[13px] text-ink-3">None are set, so the defaults apply: Misc, Uncategorized and anything in Savings (marked “default”). Turning one on replaces the defaults with your list.</p>}
      <div className="max-h-[420px] overflow-y-auto border-t border-rule">
        {categories.map((c) => (
          <ToggleRow
            key={c.id}
            label={c.name}
            description={`${c.group}${!anyFlagged && c.defaultReview ? " · default" : ""}`}
            checked={anyFlagged ? c.alwaysReview : c.defaultReview}
            onChange={(v) =>
              start(async () => {
                const r = await setAlwaysReviewAction(c.id, v);
                if (!r.ok) toast.show({ message: r.error, tone: "error" });
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

function AccuracyBars({ data }: { data: AiSettingsProps["accuracy"] }) {
  if (!data.length) return <p className="border-t border-rule py-4 text-[13px] text-ink-3">No categorization suggestions yet.</p>;
  const row = (label: string, a: number, c: number, tone: string) => {
    const n = a + c;
    const p = n ? Math.round((a / n) * 1000) / 10 : null;
    return (
      <div className="grid grid-cols-[56px_minmax(0,1fr)_64px] items-center gap-3 text-[12px]">
        <span className="text-ink-3">{label}</span>
        <span className="relative h-2.5 bg-track" aria-hidden>
          {p !== null && <span className={cx("absolute inset-y-0 left-0", tone)} style={{ width: `${p}%` }} />}
        </span>
        <span className="num text-right text-ink">{p === null ? "—" : `${p}%`}</span>
      </div>
    );
  };
  return (
    <figure>
      <ul className="border-t border-rule">
        {data.map((m) => (
          <li key={m.month} className="border-b border-rule py-2.5">
            <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
              <span className="text-ink">{mlabel(m.month)}</span>
              <span className="num text-[12px] text-ink-3">
                {m.live.accepted + m.live.corrected} reviewed{m.live.pending ? ` · ${m.live.pending} waiting` : ""}
                {m.shadow.accepted + m.shadow.corrected ? ` · ${m.shadow.accepted + m.shadow.corrected} shadow` : ""}
              </span>
            </div>
            <div className="space-y-1">
              {row("Live", m.live.accepted, m.live.corrected, "bg-pos-bar")}
              {m.shadow.accepted + m.shadow.corrected > 0 && row("Shadow", m.shadow.accepted, m.shadow.corrected, "bg-accent")}
            </div>
          </li>
        ))}
      </ul>
      <figcaption className="mt-2 text-[12px] text-ink-3">Share of suggestions kept as-is. Shadow compares {BRAND.name}&rsquo;s suggestion with YNAB&rsquo;s category during the parallel run.</figcaption>
    </figure>
  );
}

export function AiSettings(p: AiSettingsProps) {
  const series = PURPOSES.filter(([k]) => p.usage.some((u) => u.byPurpose[k])).map(([k, label]) => ({ key: k, label }));
  // Charts take milli-dollars: micro-USD / 1000.
  const rows = p.usage.map((u) => ({ month: u.month, ...Object.fromEntries(series.map((s) => [s.key, BigInt(u.byPurpose[s.key] ?? "0") / 1000n])) }));
  const capPct = BigInt(p.capMicro) > 0n ? Number((BigInt(p.spentMicro) * 1000n) / BigInt(p.capMicro)) / 10 : 0;
  return (
    <>
      <SettingsSection id="cost" title="This month" description="Every AI call is metered in ai_usage at exact token prices.">
        <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-3 border-t border-rule pt-4">
          <div>
            <div className="eyebrow">Spent</div>
            <div className="display num text-[32px] leading-none">{usd(p.spentMicro)}</div>
          </div>
          <div>
            <div className="eyebrow">Cap</div>
            <div className="display num text-[32px] leading-none text-ink-2">{usd(p.capMicro)}</div>
          </div>
          <div className="min-w-[160px] flex-1">
            <div className="relative h-2 bg-track" aria-hidden>
              <span className={cx("absolute inset-y-0 left-0", capPct >= 100 ? "bg-neg-bar" : capPct >= 80 ? "bg-warn-bar" : "bg-accent")} style={{ width: `${Math.min(100, capPct)}%` }} />
            </div>
            <div className="num mt-1 text-[12px] text-ink-3">{capPct}% of the cap</div>
          </div>
        </div>
        {series.length ? (
          <ChartFrame title="Cost by month" subtitle="By purpose, last six months" summary={`AI cost by month: ${p.usage.map((u) => `${mlabel(u.month)} ${usd(u.total)}`).join(", ")}`} height={200} footer={<Legend series={series} />}>
            <StackedBarChart data={rows} xKey="month" series={series} />
          </ChartFrame>
        ) : (
          <p className="text-[13px] text-ink-3">No AI usage recorded yet.</p>
        )}
        {p.byModel.length > 0 && (
          <table className="mt-6 w-full border-collapse text-[13px]">
            <caption className="sr-only">Usage by model this month</caption>
            <thead>
              <tr className="border-b border-rule-strong">
                <th className="eyebrow py-2 text-left">Model</th>
                <th className="eyebrow py-2 text-right">Calls</th>
                <th className="eyebrow hidden py-2 text-right sm:table-cell">Tokens in / out</th>
                <th className="eyebrow py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {p.byModel.map((m) => (
                <tr key={m.model} className="border-b border-rule">
                  <td className="py-2 font-mono text-[12px]">{m.model}</td>
                  <td className="num py-2 text-right">{m.calls}</td>
                  <td className="num hidden py-2 text-right sm:table-cell">
                    {m.inputTokens.toLocaleString()} / {m.outputTokens.toLocaleString()}
                  </td>
                  <td className="num py-2 text-right">{usd(m.micro, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsSection>
      <SettingsSection id="key" title="Anthropic API key">
        <KeyForm k={p.key_} />
      </SettingsSection>
      <SettingsSection id="budget" title="Budget and web lookup">
        <BudgetForm budget={p.budget} spentMicro={p.spentMicro} />
      </SettingsSection>
      <SettingsSection id="models" title="Models" description="Every model id is editable. Unknown ids are priced at the most expensive known model so the cap stays safe.">
        <ModelsForm models={p.models} />
      </SettingsSection>
      <SettingsSection id="policy" title="Approval thresholds" description="When a categorized transaction is approved automatically (§9.4).">
        <PolicyForm policy={p.policy} />
      </SettingsSection>
      <SettingsSection id="review" title="Always review" description="Transactions in these categories always wait for a person, whatever the confidence.">
        <AlwaysReview categories={p.categories} anyFlagged={p.anyFlagged} />
      </SettingsSection>
      <SettingsSection id="accuracy" title="Categorization accuracy">
        <AccuracyBars data={p.accuracy} />
      </SettingsSection>
    </>
  );
}

function Legend({ series }: { series: { key: string; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2" style={{ background: `var(--chart-${(i % 8) + 1})` }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
