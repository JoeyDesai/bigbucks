/**
 * Fidelity Positions CSV importer (§7.5 fallback). File: Portfolio_Positions_*.csv
 * Strips $ , % and ignores the footer disclaimer lines. Account numbers are reduced to last-4 for display.
 */
import { parse } from "csv-parse/sync";
import type { AccountKind, Milli } from "@homebase/shared";
import { blankToUndef, normalizeDecimal, sha256Hex, toMilliOpt } from "./normalize";
import { ConnectorError, type ExternalAccount, type ExternalHolding } from "./types";

export interface FidelityPosition {
  accountNumber: string;
  accountName: string;
  symbol: string;
  description?: string;
  investmentType?: string;
  quantity?: string;
  lastPrice?: Milli;
  currentValue?: Milli;
  costBasisTotal?: Milli;
  averageCostBasis?: Milli;
  type?: string;
  isCash: boolean;
  isPending: boolean;
  raw: Record<string, string>;
}

export interface FidelityParseResult {
  positions: FidelityPosition[];
  accounts: ExternalAccount[];
  holdings: ExternalHolding[];
  /** From the footer "Date downloaded …" line when present. */
  downloadedAt?: string;
  warnings: string[];
}

const clean = (s: string | undefined) => (s ?? "").replace(/^﻿/, "").trim();
/** "$1,234.56" / "+$12.34" / "-$5.00" / "12.34%" / "--" → milli or undefined. */
export function fidelityMoney(s: string | undefined): Milli | undefined {
  const t = clean(s).replace(/%$/, "");
  return toMilliOpt(t);
}

const H = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function guessFidelityKind(accountName: string): AccountKind {
  const n = accountName.toLowerCase();
  if (/\bhsa\b|health savings/.test(n)) return "hsa";
  if (/401\s?\(?k\)?|403\s?\(?b\)?|457|\bira\b|roth|rollover|sep|simple|brokeragelink|retirement|pension/.test(n)) return "retirement";
  return "brokerage";
}

/** Fidelity export footers include "Date downloaded Oct-22-2026 10:15 a.m ET". */
function parseDownloaded(line: string): string | undefined {
  const m = /Date downloaded\s+([A-Za-z]{3})-(\d{1,2})-(\d{4})/i.exec(line);
  if (!m) return undefined;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const mi = months.indexOf(m[1]!.toLowerCase());
  if (mi < 0) return undefined;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

export function parseFidelityPositionsCsv(text: string, o: { asOf?: string } = {}): FidelityParseResult {
  const rows = parse(text.replace(/^﻿/, ""), { relax_column_count: true, relax_quotes: true, skip_empty_lines: false, trim: true, bom: true }) as string[][];
  const headerIdx = rows.findIndex((r) => r.some((c) => H(c) === "accountnumber") && r.some((c) => H(c) === "symbol"));
  if (headerIdx < 0) throw new ConnectorError("parse", "Not a Fidelity positions CSV (no Account Number/Symbol header)", { provider: "fidelity_csv" });
  const header = rows[headerIdx]!.map(clean);
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => H(h) === H(n)));
  const c = {
    acct: col("Account Number"),
    name: col("Account Name"),
    invType: col("Investment Type"),
    symbol: col("Symbol"),
    desc: col("Description"),
    qty: col("Quantity"),
    last: col("Last Price"),
    value: col("Current Value"),
    cbTotal: col("Cost Basis Total"),
    cbAvg: col("Average Cost Basis"),
    type: col("Type"),
  };
  const warnings: string[] = [];
  const positions: FidelityPosition[] = [];
  let downloadedAt: string | undefined;
  for (const r of rows.slice(headerIdx + 1)) {
    const joined = r.join(" ").trim();
    if (!joined) continue;
    const dl = parseDownloaded(joined);
    if (dl) downloadedAt = dl;
    const get = (i: number) => (i >= 0 ? clean(r[i]) : "");
    const acct = get(c.acct);
    const symbol = get(c.symbol);
    // Footer / disclaimer lines: a single long cell or no account number pattern.
    const nonEmpty = r.filter((x) => clean(x) !== "").length;
    if (nonEmpty < 3 || !/^[A-Z0-9-]{4,}$/i.test(acct) || !symbol) continue;
    try {
      const isPending = /pending activity/i.test(symbol);
      const isCash = /\*\*$/.test(symbol) || /money market|core position|cash/i.test(get(c.desc)) || /^cash$/i.test(get(c.type));
      const p: FidelityPosition = { accountNumber: acct, accountName: get(c.name), symbol: symbol.replace(/\*+$/, ""), isCash, isPending, raw: Object.fromEntries(header.map((h, i) => [h, clean(r[i])])) };
      const desc = blankToUndef(get(c.desc));
      if (desc) p.description = desc;
      const it = blankToUndef(get(c.invType));
      if (it) p.investmentType = it;
      const q = get(c.qty).replace(/,/g, "");
      if (q && q !== "--") p.quantity = normalizeDecimal(q);
      const lp = fidelityMoney(get(c.last));
      if (lp !== undefined) p.lastPrice = lp;
      const cv = fidelityMoney(get(c.value));
      if (cv !== undefined) p.currentValue = cv;
      const cbt = fidelityMoney(get(c.cbTotal));
      if (cbt !== undefined) p.costBasisTotal = cbt;
      const cba = fidelityMoney(get(c.cbAvg));
      if (cba !== undefined) p.averageCostBasis = cba;
      const ty = blankToUndef(get(c.type));
      if (ty) p.type = ty;
      positions.push(p);
    } catch (e) {
      warnings.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const asOf = o.asOf ?? (downloadedAt ? `${downloadedAt}T12:00:00.000Z` : new Date().toISOString());
  const acctIdOf = (n: string) => `fidelity:${sha256Hex(n).slice(0, 16)}`;
  const byAcct = new Map<string, { name: string; number: string; total: Milli }>();
  const holdings: ExternalHolding[] = [];
  for (const p of positions) {
    const a = byAcct.get(p.accountNumber) ?? { name: p.accountName, number: p.accountNumber, total: 0n };
    a.total += p.currentValue ?? 0n;
    byAcct.set(p.accountNumber, a);
    if (p.isPending) continue;
    const h: ExternalHolding = {
      accountExternalId: acctIdOf(p.accountNumber),
      externalId: `${acctIdOf(p.accountNumber)}:${p.symbol}`,
      symbol: p.symbol.toUpperCase(),
      shares: p.quantity ?? (p.isCash && p.currentValue !== undefined ? fromMilliDecimal(p.currentValue) : "0"),
      currency: "USD",
      asOf,
      // Account numbers stay out of persisted raw payloads.
      raw: Object.fromEntries(Object.entries(p.raw).filter(([k]) => !/account number/i.test(k))),
    };
    if (p.description) h.description = p.description;
    if (p.currentValue !== undefined) h.marketValue = p.currentValue;
    if (p.costBasisTotal !== undefined) h.costBasis = p.costBasisTotal;
    holdings.push(h);
  }
  const accounts: ExternalAccount[] = [...byAcct.values()].map((a) => ({
    externalId: acctIdOf(a.number),
    name: `${a.name || "Fidelity"} (${a.number.slice(-4)})`,
    kindGuess: guessFidelityKind(a.name),
    currency: "USD",
    balance: a.total,
    asOf,
    institution: "Fidelity",
    raw: { accountName: a.name, last4: a.number.slice(-4) },
  }));
  const res: FidelityParseResult = { positions, accounts, holdings, warnings };
  if (downloadedAt) res.downloadedAt = downloadedAt;
  return res;
}

function fromMilliDecimal(m: Milli): string {
  const neg = m < 0n;
  const a = (neg ? -m : m).toString().padStart(4, "0");
  return normalizeDecimal(`${neg ? "-" : ""}${a.slice(0, -3)}.${a.slice(-3)}`);
}
