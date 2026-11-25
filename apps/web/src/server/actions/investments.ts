"use server";
/**
 * Investments: hand-entered investments (River Bitcoin, a stock held elsewhere, anything SimpleFIN can't
 * see) priced from public quotes, and hiding accounts from the tab.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDailyCloses, getQuote, searchAssets, type QuoteSource } from "@homebase/connectors";
import { ValidationError, addManualInvestment, dailyPrices, getSetting, manualHolding, parseUnits, setManualAmount, setSetting, unitsForValue, UNIT_SCALE, type PricePoint } from "@homebase/core";
import { addDays, parseMilli, today as localToday } from "@homebase/shared";
import type { AssetOption } from "@/lib/assets";
import { getDb } from "../db";
import { env } from "../env";
import { log } from "../log";
import { requireUser } from "../auth";
import { run, type ActionResult } from "../ctx";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Asset = z.object({
  source: z.enum(["coinbase", "yahoo", "none"]),
  symbol: z.string().trim().min(1).max(20),
  name: z.string().trim().max(120),
  type: z.enum(["crypto", "etf", "fund", "stock", "other"]),
});
export type NewInvestmentAsset = z.input<typeof Asset>;

function dollarsIn(s: string | undefined, what: string): bigint | null {
  if (!s?.trim()) return null;
  let v: bigint;
  try {
    v = parseMilli(s);
  } catch {
    throw new ValidationError(`${what} should be a dollar amount, like 4,500.`);
  }
  if (v < 0n) throw new ValidationError(`${what} can't be negative.`);
  return v;
}

async function quote(source: QuoteSource, symbol: string): Promise<bigint> {
  try {
    return await getQuote(source, symbol);
  } catch (e) {
    log.warn({ symbol, err: e instanceof Error ? e.message : String(e) }, "investment price");
    throw new ValidationError(`Couldn't get a price for ${symbol} right now. Try again in a minute.`);
  }
}

function noDemo() {
  if (env().HOMEBASE_DEMO === "1") throw new ValidationError("Adding accounts is turned off in the demo.");
}

/** Units from "how many" or from a dollar value at `price`. */
function unitsOf(amount: string, kind: "units" | "usd", price: bigint): bigint {
  if (kind === "units") return parseUnits(z.string().max(40).parse(amount));
  const v = dollarsIn(amount, "The value");
  if (!v) throw new ValidationError("Enter what it's worth.");
  return unitsForValue(v, price);
}

/** Ticker for something with no public price: letters from its name. */
function ownSymbol(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "OTHER";
}

function done() {
  revalidatePath("/investments");
  revalidatePath("/", "layout");
}

/** Live symbol search for the picker (stocks, ETFs, funds, crypto). Empty in the demo (no internet). */
export async function searchAssetsAction(q: string): Promise<AssetOption[]> {
  await requireUser();
  const query = q.trim().slice(0, 60);
  if (query.length < 2 || env().HOMEBASE_DEMO === "1") return [];
  try {
    return (await searchAssets(query)).slice(0, 8);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "asset search");
    return [];
  }
}

/**
 * New hand-entered investment: what it is, how much (shares/coins, or a dollar value today), optionally
 * since when (history back to then) and what was paid in total.
 */
export async function addInvestmentAction(input: {
  asset: NewInvestmentAsset;
  name: string;
  institution?: string;
  amount: string;
  amountKind: "units" | "usd";
  since?: string;
  paid?: string;
}): Promise<ActionResult<{ accountId: string }>> {
  return run("investment.add", async (ctx) => {
    noDemo();
    const asset = Asset.parse(input.asset);
    const name = z.string().trim().max(80).parse(input.name) || asset.name || asset.symbol;
    const institution = z.string().trim().max(80).parse(input.institution ?? "") || null;
    const today = localToday();
    const paid = dollarsIn(input.paid, "What you paid");

    if (asset.source === "none") {
      const value = dollarsIn(input.amount, "The value");
      if (!value) throw new ValidationError("Enter what it's worth.");
      const r = await addManualInvestment(ctx, { name, institution, crypto: false, asset: { provider: "none", symbol: ownSymbol(asset.name || name), name: asset.name || name }, units: UNIT_SCALE, costBasis: paid, prices: [{ date: today, price: value }] });
      done();
      return r;
    }

    const since = input.since ? Day.parse(input.since) : today;
    if (since > today) throw new ValidationError("The start date can't be in the future.");
    if (since < "2000-01-01") throw new ValidationError("Pick a start date after 2000.");
    const now: PricePoint = { date: today, price: await quote(asset.source, asset.symbol) };
    let history: PricePoint[] = [];
    if (since < today) {
      try {
        history = (await getDailyCloses(asset.source, asset.symbol, since, addDays(today, -1))).filter((p) => p.date >= since && p.date < today);
      } catch (e) {
        log.warn({ symbol: asset.symbol, err: e instanceof Error ? e.message : String(e) }, "investment price history");
        throw new ValidationError(`Couldn't get ${asset.symbol}'s price history. Try again, or leave the start date empty.`);
      }
      // the first day must exist even when the market was closed that day
      if (!history.length || history[0]!.date !== since) history.unshift({ date: since, price: history[0]?.price ?? now.price });
    }
    const units = unitsOf(input.amount, input.amountKind, now.price);
    const prices = dailyPrices([...history, now], (d) => addDays(d, 1));
    const r = await addManualInvestment(ctx, { name, institution, crypto: asset.type === "crypto", asset: { provider: asset.source, symbol: asset.symbol, name: asset.name || asset.symbol }, units, costBasis: paid, prices });
    done();
    return r;
  });
}

/** Change how much is held (bought more, sold some), from today on. For something valued by hand, its value. */
export async function setInvestmentAmountAction(input: { accountId: string; amount: string; amountKind: "units" | "usd" }): Promise<ActionResult> {
  return run("investment.set_amount", async (ctx) => {
    noDemo();
    const accountId = z.string().uuid().parse(input.accountId);
    const h = await manualHolding(getDb(), accountId);
    if (!h) throw new ValidationError("That isn't an investment you enter by hand.");
    const today = localToday();
    if (h.provider === "none") {
      const value = dollarsIn(input.amount, "The value");
      if (!value) throw new ValidationError("Enter what it's worth.");
      await setManualAmount(ctx, { accountId, units: UNIT_SCALE, price: { date: today, price: value } });
    } else {
      const price = await quote(h.provider, h.symbol);
      await setManualAmount(ctx, { accountId, units: unitsOf(input.amount, input.amountKind, price), price: { date: today, price } });
    }
    done();
    return {};
  });
}

/** Hide an account from the Investments tab, or show it again. Nothing else about the account changes. */
export async function setInvestmentHiddenAction(input: { accountId: string; hidden: boolean }): Promise<ActionResult> {
  return run("investment.hide", async (ctx) => {
    const accountId = z.string().uuid().parse(input.accountId);
    const cur = (await getSetting(getDb(), "investments_hidden")).account_ids;
    const next = input.hidden ? [...new Set([...cur, accountId])] : cur.filter((id) => id !== accountId);
    await setSetting(ctx, "investments_hidden", { account_ids: next });
    revalidatePath("/investments");
    return {};
  });
}
