"use client";
import { BRAND } from "@/lib/brand";
import { useState, useTransition, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import {
  dryRunCsvAction,
  importCsvAction,
  importFidelityAction,
  importOfxAction,
  importRiverAction,
  previewCsvAction,
  previewFidelityAction,
  previewOfxAction,
  previewRiverAction,
  runYnabDeltaAction,
} from "@/server/settings/actions/imports";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useToast } from "@/components/ui/Toast";
import { cx } from "@/lib/cx";
import { INPUT, SelectField, ToggleRow } from "./fields";

export interface ImportAccount {
  id: string;
  label: string;
  kind: string;
}
export interface YnabStatus {
  imported: { planName: string; importedAt: string; lastDeltaAt: string | null } | null;
  cutover: string | null;
}

type Tab = "csv" | "ofx" | "river" | "fidelity" | "ynab";
const MAX = 900_000;

function FilePick({ accept, onFile, label }: { accept: string; onFile: (name: string, text: string) => void; label: string }) {
  const toast = useToast();
  const [name, setName] = useState<string | null>(null);
  return (
    <label className="flex min-h-[72px] cursor-pointer items-center gap-3 border border-dashed border-rule-strong px-4 py-3 hover:border-accent">
      <Upload size={18} strokeWidth={1.6} aria-hidden className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] text-ink">{name ?? label}</span>
        <span className="block text-[12px] text-ink-3">{name ? "Choose another file to replace it" : "Stays on your server. Up to 900 KB."}</span>
      </span>
      <input
        type="file"
        accept={accept}
        className="sr-only"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (f.size > MAX) {
            toast.show({ message: "That file is over 900 KB. Export a shorter date range.", tone: "error" });
            return;
          }
          setName(f.name);
          onFile(f.name, await f.text());
          e.target.value = "";
        }}
      />
    </label>
  );
}

function Result({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="border-l-[3px] border-pos-bar py-1 pl-3 text-[14px] text-ink">
      {children}
    </div>
  );
}

const fail = (toast: ReturnType<typeof useToast>, e: string): void => {
  toast.show({ message: e, tone: "error" });
};

// ── CSV ─────────────────────────────────────────────────────────────────────

type Mapping = { date: string; amount: string; outflow: string; inflow: string; payee: string; description: string; memo: string; dateFormat: string; invertAmount: boolean };

function CsvImport({ accounts }: { accounts: ImportAccount[] }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [sample, setSample] = useState<string[][]>([]);
  const [split, setSplit] = useState(false);
  const [m, setM] = useState<Mapping>({ date: "", amount: "", outflow: "", inflow: "", payee: "", description: "", memo: "", dateFormat: "auto", invertAmount: false });
  const [account, setAccount] = useState("");
  const [check, setCheck] = useState<{ count: number; dateFormat: string; warnings: string[]; sample: { date: string; description: string; amount: string }[] } | null>(null);
  const [includeNear, setIncludeNear] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const mapping = () => {
    const pick = (v: string) => (v ? v : undefined);
    return {
      date: m.date,
      ...(split ? { outflow: pick(m.outflow), inflow: pick(m.inflow) } : { amount: pick(m.amount) }),
      payee: pick(m.payee),
      description: pick(m.description),
      memo: pick(m.memo),
      dateFormat: m.dateFormat,
      invertAmount: m.invertAmount,
    };
  };

  const onFile = (name: string, text: string) =>
    start(async () => {
      setCheck(null);
      setDone(null);
      const r = await previewCsvAction(text);
      if (!r.ok) return fail(toast, r.error);
      setFile({ name, text });
      setHeader(r.header ?? []);
      setSample(r.sample);
      const s = r.suggested as Partial<Record<keyof Mapping, string>>;
      setSplit(!!s.outflow);
      setM((x) => ({ ...x, date: String(s.date ?? ""), amount: String(s.amount ?? ""), outflow: String(s.outflow ?? ""), inflow: String(s.inflow ?? ""), payee: String(s.payee ?? ""), description: String(s.description ?? ""), memo: String(s.memo ?? "") }));
    });

  const col = (k: keyof Mapping, label: string, optional = true) => (
    <SelectField label={label} value={String(m[k])} onChange={(e) => setM((x) => ({ ...x, [k]: e.target.value }))}>
      <option value="">{optional ? "Not used" : "Choose a column"}</option>
      {header.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </SelectField>
  );

  return (
    <div className="space-y-6">
      <FilePick accept=".csv,text/csv" label="Choose a bank CSV" onFile={onFile} />
      {file && header.length > 0 && (
        <>
          <div className="overflow-x-auto border-y border-rule">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr>
                  {header.map((h) => (
                    <th key={h} className="eyebrow whitespace-nowrap border-b border-rule-strong px-2 py-2 text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sample.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-b border-rule last:border-0">
                    {header.map((_, j) => (
                      <td key={j} className="max-w-[220px] truncate whitespace-nowrap px-2 py-1.5 font-mono text-[11px]">
                        {r[j] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label="Into account" value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Choose an account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </SelectField>
            {col("date", "Date column", false)}
            <SelectField label="Date format" value={m.dateFormat} onChange={(e) => setM((x) => ({ ...x, dateFormat: e.target.value }))}>
              <option value="auto">Detect</option>
              {["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "YYYY/MM/DD", "MM-DD-YYYY", "DD.MM.YYYY", "YYYYMMDD", "MMM D, YYYY", "D MMM YYYY"].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </SelectField>
            <SelectField label="Amounts" value={split ? "split" : "one"} onChange={(e) => setSplit(e.target.value === "split")}>
              <option value="one">One signed column</option>
              <option value="split">Separate outflow and inflow columns</option>
            </SelectField>
            {split ? (
              <>
                {col("outflow", "Outflow column")}
                {col("inflow", "Inflow column")}
              </>
            ) : (
              col("amount", "Amount column", false)
            )}
            {col("payee", "Payee column")}
            {col("description", "Description column")}
            {col("memo", "Memo column")}
          </div>
          {!split && (
            <div className="border-t border-rule">
              <ToggleRow label="Purchases are positive in this file" description="Flip the sign so spending comes in as outflows." checked={m.invertAmount} onChange={(v) => setM((x) => ({ ...x, invertAmount: v }))} />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!account || !m.date || pending}
              busy={pending && !check}
              onClick={() =>
                start(async () => {
                  const r = await dryRunCsvAction(file.text, account, mapping());
                  if (!r.ok) return fail(toast, r.error);
                  setCheck(r);
                })
              }
            >
              Check
            </Button>
          </div>
          {check && (
            <div className="space-y-3">
              <p className="text-[14px]">
                <span className="num font-medium">{check.count}</span> transactions read (dates as {check.dateFormat}).
                {check.warnings.length ? <span className="text-warn"> {check.warnings.length} lines skipped.</span> : null}
              </p>
              <ul className="border-t border-rule text-[13px]">
                {check.sample.map((t, i) => (
                  <li key={i} className="flex gap-3 border-b border-rule py-1.5">
                    <span className="num w-24 shrink-0 text-ink-3">{t.date}</span>
                    <span className="min-w-0 flex-1 truncate">{t.description}</span>
                    <span className={cx("num", BigInt(t.amount) < 0n ? "text-ink" : "text-pos")}>{formatMilli(BigInt(t.amount))}</span>
                  </li>
                ))}
              </ul>
              {check.warnings.length > 0 && (
                <details className="text-[12px] text-ink-3">
                  <summary className="cursor-pointer">Skipped lines</summary>
                  <ul className="mt-1 font-mono">
                    {check.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="border-t border-rule">
                <ToggleRow label="Also import near-duplicates" description="Same amount within 3 days and a similar description. Off by default." checked={includeNear} onChange={setIncludeNear} />
              </div>
              <Button
                variant="primary"
                busy={pending}
                onClick={() =>
                  start(async () => {
                    const r = await importCsvAction({ text: file.text, accountId: account, mapping: mapping(), fileName: file.name, includeNear });
                    if (!r.ok) return fail(toast, r.error);
                    setDone(`Imported ${r.imported}. Skipped ${r.exact + r.skippedExisting} already in ${BRAND.name}${r.near && !includeNear ? ` and ${r.near} possible duplicates` : ""}. New rows wait in the review inbox${r.categorizeQueued ? " and are being categorized now" : " and are categorized on the next run"}.`);
                    setCheck(null);
                  })
                }
              >
                Import {check.count} transactions
              </Button>
            </div>
          )}
        </>
      )}
      {done && <Result>{done}</Result>}
    </div>
  );
}

// ── OFX ─────────────────────────────────────────────────────────────────────

function OfxImport({ accounts }: { accounts: ImportAccount[] }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [stmts, setStmts] = useState<{ id: string; last4: string; type: string; count: number; start: string | null; end: string | null }[]>([]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <FilePick
        accept=".ofx,.qfx,application/x-ofx"
        label="Choose an OFX or QFX file"
        onFile={(name, text) =>
          start(async () => {
            setDone(null);
            const r = await previewOfxAction(text);
            if (!r.ok) return fail(toast, r.error);
            setFile({ name, text });
            setStmts(r.statements);
            setMap({});
          })
        }
      />
      {stmts.length > 0 && (
        <ul className="border-t border-rule">
          {stmts.map((s) => (
            <li key={s.id} className="grid gap-2 border-b border-rule py-3 sm:grid-cols-[minmax(0,1fr)_260px] sm:items-center">
              <div>
                <div className="text-[15px]">
                  {s.type} ending {s.last4}
                </div>
                <div className="num text-[12px] text-ink-3">
                  {s.count} transactions{s.start ? ` · ${s.start} to ${s.end}` : ""}
                </div>
              </div>
              <select aria-label={`Account for statement ending ${s.last4}`} value={map[s.id] ?? ""} onChange={(e) => setMap((x) => ({ ...x, [s.id]: e.target.value }))} className={INPUT}>
                <option value="">Skip</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
      {file && stmts.length > 0 && (
        <Button
          variant="primary"
          busy={pending}
          disabled={!Object.values(map).some(Boolean)}
          onClick={() =>
            start(async () => {
              const r = await importOfxAction({ text: file.text, mapping: map, fileName: file.name });
              if (!r.ok) return fail(toast, r.error);
              setDone(`Imported ${r.imported}. Skipped ${r.exact + r.skippedExisting} already in ${BRAND.name}${r.near ? ` and ${r.near} possible duplicates` : ""}.`);
            })
          }
        >
          Import
        </Button>
      )}
      {done && <Result>{done}</Result>}
    </div>
  );
}

// ── River ───────────────────────────────────────────────────────────────────

function RiverImport({ accounts }: { accounts: ImportAccount[] }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [p, setP] = useState<{ headers: string[]; missing: string[]; rows: number; warnings: string[]; btcNetSats: string } | null>(null);
  const crypto = accounts.filter((a) => a.kind === "crypto");
  const [account, setAccount] = useState(crypto.find((a) => /river/i.test(a.label))?.id ?? "");
  const [done, setDone] = useState<string | null>(null);
  const btc = (sats: string) => {
    const s = BigInt(sats);
    const neg = s < 0n;
    const a = neg ? -s : s;
    return `${neg ? "−" : ""}${a / 100_000_000n}.${(a % 100_000_000n).toString().padStart(8, "0")} BTC`;
  };
  return (
    <div className="space-y-6">
      <FilePick
        accept=".csv,text/csv"
        label="Choose River's account activity CSV"
        onFile={(name, text) =>
          start(async () => {
            setDone(null);
            const r = await previewRiverAction(text);
            if (!r.ok) return fail(toast, r.error);
            setFile({ name, text });
            setP(r);
          })
        }
      />
      {p && (
        <div className="space-y-4">
          {p.missing.length ? (
            <p className="text-[14px] text-neg">This doesn&rsquo;t look like a River export: missing {p.missing.join(", ")}.</p>
          ) : (
            <p className="text-[14px]">
              <span className="num font-medium">{p.rows}</span> rows, net <span className="num">{btc(p.btcNetSats)}</span>.{p.warnings.length ? <span className="text-warn"> {p.warnings.length} warnings.</span> : null}
            </p>
          )}
          <SelectField label="Into account" value={account} onChange={(e) => setAccount(e.target.value)} hint={crypto.length ? undefined : "Create a crypto account for River first (Activity → add account)."}>
            <option value="">Choose an account</option>
            {(crypto.length ? crypto : accounts).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </SelectField>
          <Button
            variant="primary"
            busy={pending}
            disabled={!file || !account || p.missing.length > 0}
            onClick={() =>
              start(async () => {
                const r = await importRiverAction({ text: file!.text, accountId: account, fileName: file!.name });
                if (!r.ok) return fail(toast, r.error);
                setDone(`Imported ${r.imported} River transactions. Skipped ${r.exact + r.skippedExisting} already in ${BRAND.name}.`);
              })
            }
          >
            Import
          </Button>
        </div>
      )}
      {done && <Result>{done}</Result>}
    </div>
  );
}

// ── Fidelity ────────────────────────────────────────────────────────────────

function FidelityImport({ accounts }: { accounts: ImportAccount[] }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [p, setP] = useState<{ downloadedAt: string | null; accounts: { id: string; name: string; total: string; positions: number }[]; warnings: string[] } | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const invest = accounts.filter((a) => ["brokerage", "retirement", "hsa"].includes(a.kind));
  return (
    <div className="space-y-6">
      <FilePick
        accept=".csv,text/csv"
        label="Choose Fidelity's Positions CSV"
        onFile={(name, text) =>
          start(async () => {
            setDone(null);
            const r = await previewFidelityAction(text);
            if (!r.ok) return fail(toast, r.error);
            setFile({ name, text });
            setP(r);
            // Pre-map by name.
            setMap(Object.fromEntries(r.accounts.map((a) => [a.id, invest.find((i) => i.label.toLowerCase().includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(i.label.toLowerCase()))?.id ?? ""])));
          })
        }
      />
      {p && (
        <>
          <p className="text-[13px] text-ink-3">Positions as of {p.downloadedAt ?? "today"}. Each mapped account&rsquo;s holdings for that day are replaced.</p>
          <ul className="border-t border-rule">
            {p.accounts.map((a) => (
              <li key={a.id} className="grid gap-2 border-b border-rule py-3 sm:grid-cols-[minmax(0,1fr)_260px] sm:items-center">
                <div>
                  <div className="text-[15px]">{a.name}</div>
                  <div className="num text-[12px] text-ink-3">
                    {a.positions} positions · {formatMilli(BigInt(a.total))}
                  </div>
                </div>
                <select aria-label={`${BRAND.name} account for ${a.name}`} value={map[a.id] ?? ""} onChange={(e) => setMap((x) => ({ ...x, [a.id]: e.target.value }))} className={INPUT}>
                  <option value="">Skip</option>
                  {(invest.length ? invest : accounts).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          <Button
            variant="primary"
            busy={pending}
            disabled={!file || !Object.values(map).some(Boolean)}
            onClick={() =>
              start(async () => {
                const r = await importFidelityAction({ text: file!.text, mapping: map, fileName: file!.name });
                if (!r.ok) return fail(toast, r.error);
                setDone(`Saved ${r.positions} positions across ${r.accounts} account${r.accounts === 1 ? "" : "s"}.`);
              })
            }
          >
            Import positions
          </Button>
        </>
      )}
      {done && <Result>{done}</Result>}
    </div>
  );
}

// ── YNAB ────────────────────────────────────────────────────────────────────

function YnabImport({ status, isAdmin }: { status: YnabStatus; isAdmin: boolean }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className="space-y-5 text-[14px]">
      {status.imported ? (
        <dl className="border-t border-rule">
          {[
            ["Plan", status.imported.planName],
            ["Imported", fmt(status.imported.importedAt)],
            ["Last daily delta", status.imported.lastDeltaAt ? fmt(status.imported.lastDeltaAt) : "Not yet"],
            ["Cutover", status.cutover ?? "Not set (parallel run continues)"],
          ].map(([k, v]) => (
            <div key={k} className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-b border-rule py-2.5">
              <dt className="text-ink-3">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-ink-2">No YNAB import yet.</p>
      )}
      <div>
        <h3 className="eyebrow mb-2">Full import</h3>
        <p className="mb-2 text-ink-2">The first import runs on the server, where it also saves the raw export for the parity test and prints a Homebase-vs-YNAB comparison. Run it from the repo on the home server:</p>
        <pre className="overflow-x-auto border border-rule bg-paper-sunken px-3 py-2.5 font-mono text-[13px]">pnpm import:ynab</pre>
        <p className="mt-2 text-[12px] text-ink-3">It reads the YNAB token from Connections. Add --replace to re-import YNAB-sourced history.</p>
      </div>
      {status.imported && isAdmin && (
        <div>
          <h3 className="eyebrow mb-2">Daily delta</h3>
          <p className="mb-2 text-ink-2">During the parallel run the worker pulls YNAB changes every night at 04:30. You can ask for one now.</p>
          <Button
            busy={pending}
            onClick={() =>
              start(async () => {
                const r = await runYnabDeltaAction();
                toast.show(r.ok ? { message: "YNAB delta queued" } : { message: r.error, tone: "error" });
              })
            }
          >
            Run a delta now
          </Button>
        </div>
      )}
    </div>
  );
}

export function ImportsPanel({ accounts, ynab, isAdmin }: { accounts: ImportAccount[]; ynab: YnabStatus; isAdmin: boolean }) {
  const [tab, setTab] = useState<Tab>("csv");
  const intro: Record<Tab, string> = {
    csv: `Any bank's CSV export. Map the columns once, check the result, then import. Duplicates already in ${BRAND.name} are skipped.`,
    ofx: "OFX or QFX downloads (Quicken / Money format). Each statement in the file goes to the account you pick.",
    river: "River's account activity export. Amounts come in as the USD value of each BTC movement.",
    fidelity: "Fidelity's Positions download (Accounts → Positions → Download). Replaces that day's holdings for the accounts you map.",
    ynab: "The one-time migration from YNAB and the daily parallel-run deltas (§10).",
  };
  return (
    <div>
      <SegmentedControl
        variant="underline"
        label="Import type"
        value={tab}
        onChange={setTab}
        className="mb-4"
        options={[
          { value: "csv", label: "CSV" },
          { value: "ofx", label: "OFX / QFX" },
          { value: "river", label: "River" },
          { value: "fidelity", label: "Fidelity" },
          { value: "ynab", label: "YNAB" },
        ]}
      />
      <p className="mb-6 max-w-[62ch] text-[14px] text-ink-2">{intro[tab]}</p>
      {tab === "csv" && <CsvImport accounts={accounts} />}
      {tab === "ofx" && <OfxImport accounts={accounts} />}
      {tab === "river" && <RiverImport accounts={accounts} />}
      {tab === "fidelity" && <FidelityImport accounts={accounts} />}
      {tab === "ynab" && <YnabImport status={ynab} isAdmin={isAdmin} />}
    </div>
  );
}
