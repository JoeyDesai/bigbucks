/**
 * Investments typed in by hand (River Bitcoin, a stock at another broker, anything SimpleFIN can't see):
 * one account per asset, off budget. Each day gets a `holdings` row (symbol, quantity, that day's price)
 * and a `balances` row, so the account has history and graphs like any synced one.
 *
 * Where the price comes from is stored in `accounts.external_id` as `quote:<provider>:<symbol>`
 * (`coinbase` for crypto, `yahoo` for stocks/ETFs/funds, `none` for something valued by hand). Prices
 * are passed in by the caller (web action / worker job). Quantities are bigint units of 10⁻⁸
 * (satoshis for Bitcoin), values milliunits. No floats.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { accounts, balances, holdings, type Tx } from "@homebase/db";
import { parseMilli, type ISODate, type Milli } from "@homebase/shared";
import { withTx, type Ctx, type DbLike } from "../context";
import { writeAudit } from "../audit";
import { ValidationError } from "../errors";
import { createAccount } from "../transactions/accounts";

export const QUOTE_PROVIDERS = ["coinbase", "yahoo", "none"] as const;
export type QuoteProvider = (typeof QUOTE_PROVIDERS)[number];

/** 1 share / coin = 10⁸ units (Bitcoin's satoshi), so 8 decimal places. */
export const UNIT_SCALE = 100_000_000n;

export interface PricePoint {
  date: ISODate;
  /** Milliunits per 1 share / coin. */
  price: Milli;
}

export interface ManualAsset {
  provider: QuoteProvider;
  /** Ticker as the provider knows it: BTC (Coinbase), VOO / FXAIX / BRK-B (Yahoo). */
  symbol: string;
  name: string;
}

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-^=]{0,19}$/;

export function quoteExternalId(a: Pick<ManualAsset, "provider" | "symbol">): string {
  return `quote:${a.provider}:${a.symbol}`;
}

export function parseQuoteExternalId(ext: string | null): { provider: QuoteProvider; symbol: string } | null {
  const m = /^quote:(coinbase|yahoo|none):(.+)$/.exec(ext ?? "");
  return m ? { provider: m[1] as QuoteProvider, symbol: m[2]! } : null;
}

export function validateAsset(a: ManualAsset): ManualAsset {
  const symbol = a.symbol.trim().toUpperCase();
  if (!QUOTE_PROVIDERS.includes(a.provider)) throw new ValidationError("Unknown price source.");
  if (!SYMBOL.test(symbol)) throw new ValidationError("That ticker doesn't look right.");
  const name = a.name.trim().slice(0, 120) || symbol;
  return { provider: a.provider, symbol, name };
}

/** "0.05", "12.5 shares", "25,000,000 sats" → units of 10⁻⁸. More than 8 decimals or ≤ 0 is rejected. */
export function parseUnits(input: string): bigint {
  const s = input.trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
  const sats = /^(\d+) ?(sats?|satoshis?)$/.exec(s);
  if (sats) {
    const v = BigInt(sats[1]!);
    if (v <= 0n) throw new ValidationError("Enter more than 0.");
    return v;
  }
  const m = /^(\d*)(?:\.(\d*))?(?: ?(btc|shares?|coins?|units?))?$/.exec(s);
  if (!m || (m[1] === "" && !m[2])) throw new ValidationError("Enter an amount like 0.25 or 12.5.");
  const frac = m[2] ?? "";
  if (frac.length > 8) throw new ValidationError("Use at most 8 decimal places.");
  const v = BigInt(m[1] || "0") * UNIT_SCALE + BigInt(frac.padEnd(8, "0") || "0");
  if (v <= 0n) throw new ValidationError("Enter more than 0.");
  return v;
}

/** Units → "0.0523" (trailing zeros dropped). */
export function unitsToDecimal(units: bigint): string {
  const i = units / UNIT_SCALE;
  const f = (units % UNIT_SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return f ? `${i}.${f}` : `${i}`;
}

/** Value of `units` at `price` (milli per whole unit), rounded half up. */
export function unitsValue(units: bigint, price: Milli): Milli {
  return (units * price + UNIT_SCALE / 2n) / UNIT_SCALE;
}

/** How many units `value` buys at `price`, rounded half up. */
export function unitsForValue(value: Milli, price: Milli): bigint {
  if (price <= 0n) throw new ValidationError("No price to work that out with.");
  return (value * UNIT_SCALE + price / 2n) / price;
}

/** Milli → plain decimal string for the numeric `price` column. */
function milliToDecimal(m: Milli): string {
  return `${m / 1000n}.${(m % 1000n).toString().padStart(3, "0")}`;
}

/** One price per day from the first to the last point, carrying the last known price over gaps. */
export function dailyPrices(points: readonly PricePoint[], addDay: (d: ISODate) => ISODate): PricePoint[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return [];
  const by = new Map(sorted.map((p) => [p.date, p.price]));
  const out: PricePoint[] = [];
  let price = sorted[0]!.price;
  for (let d = sorted[0]!.date; d <= sorted.at(-1)!.date; d = addDay(d)) {
    price = by.get(d) ?? price;
    out.push({ date: d, price });
  }
  return out;
}

async function writeDay(tx: Tx, accountId: string, asset: { symbol: string; name: string }, units: bigint, costBasis: Milli | null, p: PricePoint): Promise<void> {
  const value = unitsValue(units, p.price);
  await tx.delete(holdings).where(and(eq(holdings.accountId, accountId), eq(holdings.asOf, p.date)));
  await tx.insert(holdings).values({ accountId, asOf: p.date, symbol: asset.symbol, name: asset.name, quantity: unitsToDecimal(units), price: milliToDecimal(p.price), marketValueMilli: value, costBasisMilli: costBasis });
  await tx
    .insert(balances)
    .values({ accountId, asOf: p.date, currentMilli: value, source: "manual" })
    .onConflictDoUpdate({ target: [balances.accountId, balances.asOf], set: { currentMilli: value, source: "manual", updatedAt: new Date() } });
}

/**
 * New hand-entered investment holding `units` of `asset`, with a row for every day in `prices`
 * (oldest = "held since", newest = today). Crypto lands as a crypto account, anything else as brokerage.
 */
export async function addManualInvestment(
  ctx: Ctx,
  input: { name: string; institution: string | null; crypto: boolean; asset: ManualAsset; units: bigint; costBasis: Milli | null; prices: PricePoint[] },
): Promise<{ accountId: string }> {
  const asset = validateAsset(input.asset);
  if (!input.prices.length) throw new ValidationError("No price to value it with.");
  if (input.prices.length > 9000) throw new ValidationError("That start date is too far back.");
  return withTx(ctx, async (tx, c) => {
    const a = await createAccount(c, { name: input.name, kind: input.crypto ? "crypto" : "brokerage", onBudget: false, institution: input.institution, source: "manual" });
    await tx.update(accounts).set({ externalId: quoteExternalId(asset) }).where(eq(accounts.id, a.id));
    for (const p of input.prices) await writeDay(tx, a.id, asset, input.units, input.costBasis, p);
    await writeAudit(tx, c, { action: "investment.add", entity: "account", entityId: a.id, after: { symbol: asset.symbol, provider: asset.provider, units: input.units.toString(), since: input.prices[0]!.date, days: input.prices.length } });
    return { accountId: a.id };
  });
}

export interface ManualHolding {
  id: string;
  provider: QuoteProvider;
  symbol: string;
  name: string;
  units: bigint;
  costBasis: Milli | null;
  asOf: ISODate;
  /** Price on `asOf`, milli per unit. */
  price: Milli;
}

/** The latest snapshot of a hand-entered investment, or null when the account isn't one. */
export async function manualHolding(db: DbLike, accountId: string): Promise<ManualHolding | null> {
  const [a] = await db.select({ id: accounts.id, kind: accounts.kind, source: accounts.source, externalId: accounts.externalId }).from(accounts).where(eq(accounts.id, accountId));
  if (!a || a.source !== "manual") return null;
  const [last] = await db.select({ asOf: holdings.asOf }).from(holdings).where(eq(holdings.accountId, accountId)).orderBy(desc(holdings.asOf)).limit(1);
  if (!last) return null;
  const rows = await db.select().from(holdings).where(and(eq(holdings.accountId, accountId), eq(holdings.asOf, last.asOf)));
  if (rows.length !== 1) return null;
  const r = rows[0]!;
  // Bitcoin accounts added before quote sources were stored: BTC priced from Coinbase.
  const q = parseQuoteExternalId(a.externalId) ?? (a.kind === "crypto" && r.symbol === "BTC" ? { provider: "coinbase" as const, symbol: "BTC" } : null);
  if (!q || q.symbol !== r.symbol) return null;
  const units = parseUnits(String(r.quantity).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
  const price = r.price === null ? 0n : parseMilli(String(r.price));
  return { id: a.id, provider: q.provider, symbol: r.symbol, name: r.name ?? r.symbol, units, costBasis: r.costBasisMilli, asOf: last.asOf, price };
}

/** Every open hand-entered investment. */
export async function manualHoldings(db: DbLike): Promise<ManualHolding[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.source, "manual"), eq(accounts.closed, false), isNull(accounts.deletedAt)));
  const out: ManualHolding[] = [];
  for (const r of rows) {
    const h = await manualHolding(db, r.id);
    if (h) out.push(h);
  }
  return out;
}

/** Change how much is held from `price.date` on (earlier days keep their amount). */
export async function setManualAmount(ctx: Ctx, input: { accountId: string; units: bigint; costBasis?: Milli | null; price: PricePoint }): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const prev = await manualHolding(tx, input.accountId);
    if (!prev) throw new ValidationError("That isn't an investment you enter by hand.");
    const cost = input.costBasis === undefined ? prev.costBasis : input.costBasis;
    await writeDay(tx, input.accountId, prev, input.units, cost, input.price);
    await writeAudit(tx, c, { action: "investment.set_amount", entity: "account", entityId: input.accountId, before: { units: prev.units.toString(), price: prev.price.toString() }, after: { units: input.units.toString(), price: input.price.price.toString(), asOf: input.price.date } });
  });
}

/** Re-price hand-entered investments: `prices` is keyed by `provider:symbol`; missing keys are skipped. */
export async function repriceManual(ctx: Ctx, date: ISODate, prices: ReadonlyMap<string, Milli>): Promise<number> {
  const held = (await manualHoldings(ctx.db)).filter((h) => prices.has(`${h.provider}:${h.symbol}`));
  if (!held.length) return 0;
  await withTx(ctx, async (tx) => {
    for (const h of held) await writeDay(tx, h.id, h, h.units, h.costBasis, { date, price: prices.get(`${h.provider}:${h.symbol}`)! });
  });
  return held.length;
}
