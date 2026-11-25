"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { cx } from "@/lib/cx";
import { ASSET_TYPE_LABEL, matchAssets, type AssetOption } from "@/lib/assets";
import { addInvestmentAction, searchAssetsAction, setInvestmentAmountAction } from "@/server/actions/investments";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

const FIELD = "h-11 w-full rounded-[10px] border border-rule-strong bg-paper px-3 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-3 focus-visible:border-accent";
type Picked = AssetOption | { source: "none"; symbol: ""; name: string; type: "other" };

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx("block min-w-0", className)}>
      <span className="mb-1 block text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
}

/** Search box with a list: the built-in assets instantly, live search results as they arrive. */
function AssetPicker({ onPick }: { onPick: (a: Picked) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<AssetOption[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const local = matchAssets(q, 8);
  const seen = new Set(local.map((a) => `${a.source}:${a.symbol}`));
  const live = q.trim().length >= 2 ? remote : [];
  const options: Picked[] = [...local, ...live.filter((a) => !seen.has(`${a.source}:${a.symbol}`) && !local.some((l) => l.symbol === a.symbol.replace(/-USD$/, "")))].slice(0, 12);
  const all: Picked[] = [...options, { source: "none", symbol: "", name: q.trim(), type: "other" }];

  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) return;
    let live = true;
    const t = setTimeout(() => void searchAssetsAction(s).then((r) => live && setRemote(r)), 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open]);

  const choose = (a: Picked) => {
    setOpen(false);
    setQ("");
    onPick(a);
  };
  return (
    <div ref={wrap} className="relative">
      <label className="mb-1 block text-[13px] font-medium text-ink-2" htmlFor={`${listId}-q`}>
        What is it?
      </label>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          id={`${listId}-q`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(all.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && open) {
              e.preventDefault();
              choose(all[active]!);
            } else if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Search: Bitcoin, VOO, FXAIX, Apple…"
          autoComplete="off"
          className={`${FIELD} pl-9`}
        />
      </div>
      {open && (
        <ul id={listId} role="listbox" aria-label="Investments" className="absolute inset-x-0 top-full z-20 mt-1 max-h-[320px] overflow-y-auto rounded-[12px] border border-rule bg-paper-raised p-1 shadow-pop" data-testid="asset-options">
          {all.map((a, i) => {
            const other = a.source === "none";
            return (
              <li key={other ? "other" : `${a.source}:${a.symbol}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(a)}
                  className={cx("flex w-full items-center gap-3 rounded-[9px] px-2.5 py-2 text-left", i === active && "bg-paper-hover", other && "mt-1 border-t border-rule pt-2.5")}
                >
                  {other ? (
                    <span className="text-[13.5px] text-ink-2">
                      Something else{q.trim() ? `: “${q.trim()}”` : ""}
                      <span className="block text-[12px] text-ink-3">No ticker. Enter its value yourself.</span>
                    </span>
                  ) : (
                    <>
                      <span className="w-16 shrink-0 font-mono text-[13px] font-semibold text-ink">{a.symbol.replace(/-USD$/, "")}</span>
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-2">{a.name}</span>
                      <span className="shrink-0 text-[11.5px] text-ink-3">{ASSET_TYPE_LABEL[a.type as AssetOption["type"]]}</span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Add any investment SimpleFIN can't see: crypto (Bitcoin at River…), a stock, ETF or fund held
 * elsewhere, or something with no ticker. Priced every hour from public quotes.
 */
export function AddInvestmentForm({ today }: { today: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [asset, setAsset] = useState<Picked | null>(null);
  const [f, setF] = useState({ name: "", institution: "", amount: "", kind: "units" as "units" | "usd", since: "", paid: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const other = asset?.source === "none";
  const unit = asset?.type === "crypto" ? "coins" : "shares";

  if (!asset)
    return (
      <AssetPicker
        onPick={(a) => {
          setAsset(a);
          setF((x) => ({ ...x, name: a.source === "none" ? a.name : a.symbol === "BTC" ? "Bitcoin" : a.name, kind: a.source === "none" ? "usd" : "units" }));
        }}
      />
    );
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        start(async () => {
          const r = await addInvestmentAction({
            asset: { source: asset.source, symbol: asset.symbol || "OTHER", name: asset.source === "none" ? f.name : asset.name, type: asset.type },
            name: f.name,
            institution: f.institution,
            amount: f.amount,
            amountKind: other ? "usd" : f.kind,
            since: other ? undefined : f.since || undefined,
            paid: f.paid || undefined,
          });
          if (!r.ok) return setErr(r.error);
          toast.show({ message: `${f.name || asset.name} added` });
          setAsset(null);
          setF({ name: "", institution: "", amount: "", kind: "units", since: "", paid: "" });
          router.push(`/investments?a=${r.accountId}`, { scroll: false });
        });
      }}
    >
      <div className="flex items-center justify-between gap-3 rounded-[12px] border border-rule bg-paper px-3 py-2.5 sm:col-span-2">
        <span className="min-w-0">
          {!other && <span className="mr-2 font-mono text-[13px] font-semibold text-ink">{asset.symbol.replace(/-USD$/, "")}</span>}
          <span className="text-[13.5px] text-ink-2">{other ? "Something with no ticker" : asset.name}</span>
        </span>
        <button type="button" onClick={() => setAsset(null)} className="shrink-0 text-[13px] font-medium text-accent hover:underline">
          Change
        </button>
      </div>
      <Field label="Name">
        <input value={f.name} onChange={set("name")} maxLength={80} required={other} className={FIELD} placeholder={other ? "Like Farmland share" : ""} />
      </Field>
      <Field label="Where it's held (optional)">
        <input value={f.institution} onChange={set("institution")} maxLength={80} placeholder="River, Robinhood…" className={FIELD} />
      </Field>
      <div className="min-w-0">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-ink-2">{other || f.kind === "usd" ? "What it's worth today" : `How many ${unit}`}</span>
          {!other && (
            <button type="button" onClick={() => setF({ ...f, kind: f.kind === "units" ? "usd" : "units", amount: "" })} className="text-[12.5px] font-medium text-accent hover:underline">
              {f.kind === "units" ? "Enter $ instead" : `Enter ${unit} instead`}
            </button>
          )}
        </div>
        <input value={f.amount} onChange={set("amount")} inputMode="decimal" required placeholder={other || f.kind === "usd" ? "$" : asset.type === "crypto" ? "0.25" : "10"} className={`${FIELD} num`} autoComplete="off" aria-label="Amount" />
        {!other && f.kind === "usd" && <span className="mt-1 block text-[12px] text-ink-3">Worked out into {unit} at today&apos;s price</span>}
      </div>
      {!other ? (
        <Field label="Held since (optional)" hint="Fills in its history from that day's prices">
          <input type="date" value={f.since} onChange={set("since")} max={today} min="2000-01-01" className={`${FIELD} num`} />
        </Field>
      ) : (
        <div className="hidden sm:block" />
      )}
      <Field label="What you paid in total (optional)" hint="Shows your gain">
        <input value={f.paid} onChange={set("paid")} inputMode="decimal" placeholder="$" className={`${FIELD} num`} autoComplete="off" />
      </Field>
      {err && (
        <p role="alert" className="text-[13px] text-neg sm:col-span-2">
          {err}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" busy={pending}>
          Add {other ? "it" : asset.symbol.replace(/-USD$/, "")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setAsset(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Change the amount held (bought more, sold some) or, for something with no ticker, its value. */
export function ManualAmountForm({ accountId, manual, crypto }: { accountId: string; manual: { provider: string; symbol: string; units: string }; crypto: boolean }) {
  const toast = useToast();
  const none = manual.provider === "none";
  const unit = crypto ? "coins" : "shares";
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(none ? "" : manual.units);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shown = `${manual.units} ${manual.symbol.replace(/-USD$/, "")}`;
  if (!open)
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-2">
        {!none && <span className="num text-ink-2">{shown}</span>}
        <button type="button" onClick={() => setOpen(true)} className="font-medium text-accent hover:underline">
          {none ? "Update its value" : "Change amount"}
        </button>
      </span>
    );
  return (
    <form
      className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        start(async () => {
          const r = await setInvestmentAmountAction({ accountId, amount, amountKind: none ? "usd" : "units" });
          if (!r.ok) return setErr(r.error);
          toast.show({ message: none ? "Value updated" : `Now ${amount.trim()} ${unit} from today on` });
          setOpen(false);
        });
      }}
    >
      <label className="sr-only" htmlFor={`amt-${accountId}`}>
        {none ? "Value today" : `${unit} held`}
      </label>
      <input id={`amt-${accountId}`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus placeholder={none ? "$" : ""} className={`${FIELD} num h-10 w-40`} />
      {!none && <span className="text-ink-3">{unit}</span>}
      <Button type="submit" size="sm" variant="primary" busy={pending}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {err && (
        <span role="alert" className="w-full text-[13px] text-neg">
          {err}
        </span>
      )}
    </form>
  );
}
