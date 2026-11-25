/**
 * price.manual (hourly): re-value hand-entered investments (River Bitcoin, a stock held elsewhere) at
 * the latest public price: Coinbase for crypto, Yahoo Finance for stocks / ETFs / funds. Writes today's
 * holdings + balances row; the amount held only changes from the app. One failed symbol is skipped.
 */
import { getQuote, type QuoteSource } from "@homebase/connectors";
import { manualHoldings, repriceManual, systemCtx } from "@homebase/core";
import { todayOf, type WorkerContext } from "../context";

export async function priceManual(ctx: Pick<WorkerContext, "db" | "now" | "log">): Promise<{ accounts: number; priced: number; failed: string[] }> {
  const held = (await manualHoldings(ctx.db)).filter((h) => h.provider !== "none");
  const prices = new Map<string, bigint>();
  const failed: string[] = [];
  for (const key of new Set(held.map((h) => `${h.provider}:${h.symbol}`))) {
    const [provider, symbol] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    try {
      prices.set(key, await getQuote(provider as QuoteSource, symbol));
    } catch (e) {
      failed.push(symbol);
      ctx.log.warn({ symbol, err: e instanceof Error ? e.message : String(e) }, "manual investment price");
    }
  }
  const date = todayOf(ctx);
  const n = prices.size ? await repriceManual(systemCtx(ctx.db, date), date, prices) : 0;
  return { accounts: held.length, priced: n, failed };
}
