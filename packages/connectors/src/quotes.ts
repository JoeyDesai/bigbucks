/**
 * Public market prices for hand-entered investments. Read-only GETs, no keys.
 *  - coinbase: crypto spot price and daily closes (`getCoinbaseSpotPrice`, `getCoinbaseDailyCloses`).
 *  - yahoo: stocks, ETFs and mutual funds from Yahoo Finance's chart and search endpoints. Unofficial
 *    but long-lived; a failure only means that asset isn't re-priced this hour.
 */
import { z } from "zod";
import { instantToLocalDate, normalizeDecimal, toMilli } from "./normalize";
import { createHttpClient, type HttpClientOptions } from "./http";
import { getCoinbaseDailyCloses, getCoinbaseSpotPrice } from "./coinbase";
import { ConnectorError } from "./types";

export type QuoteSource = "coinbase" | "yahoo";
export const YAHOO_HOST = "query1.finance.yahoo.com";
const UA = { "user-agent": "Mozilla/5.0 (Macintosh) BigBucks/1.0" };

const Chart = z.looseObject({
  chart: z.looseObject({
    result: z
      .array(
        z.looseObject({
          meta: z.looseObject({ regularMarketPrice: z.number().nullish(), currency: z.string().nullish(), longName: z.string().nullish(), shortName: z.string().nullish() }),
          timestamp: z.array(z.number()).nullish(),
          indicators: z.looseObject({ quote: z.array(z.looseObject({ close: z.array(z.number().nullable()).nullish() })) }),
        }),
      )
      .nullish(),
    error: z.unknown().nullish(),
  }),
});

async function yahooChart(symbol: string, q: string, httpOpts: HttpClientOptions) {
  const http = createHttpClient({ ...httpOpts, provider: "yahoo" });
  const j = Chart.parse(await http.getJson(`https://${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`, { headers: UA }));
  const r = j.chart.result?.[0];
  if (!r) throw new ConnectorError("parse", `No price data for ${symbol}`, { provider: "yahoo" });
  if (r.meta.currency && r.meta.currency !== "USD") throw new ConnectorError("invalid_input", `${symbol} is priced in ${r.meta.currency}, not USD`, { provider: "yahoo" });
  return r;
}

/** Latest price (milli per share / coin). */
export async function getQuote(source: QuoteSource, symbol: string, httpOpts: HttpClientOptions = {}): Promise<bigint> {
  if (source === "coinbase") return (await getCoinbaseSpotPrice(`${symbol}-USD`, httpOpts)).price;
  const r = await yahooChart(symbol, "range=5d&interval=1d", httpOpts);
  const p = r.meta.regularMarketPrice ?? [...(r.indicators.quote[0]?.close ?? [])].reverse().find((c) => c !== null);
  if (p === null || p === undefined) throw new ConnectorError("parse", `No price for ${symbol}`, { provider: "yahoo" });
  return toMilli(normalizeDecimal(p));
}

/** Daily closes from `from` to `to` (America/New_York dates), oldest first. */
export async function getDailyCloses(source: QuoteSource, symbol: string, from: string, to: string, httpOpts: HttpClientOptions = {}): Promise<{ date: string; price: bigint }[]> {
  if (source === "coinbase") return getCoinbaseDailyCloses(`${symbol}-USD`, from, to, httpOpts);
  const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000) + 86_400;
  const r = await yahooChart(symbol, `period1=${p1}&period2=${p2}&interval=1d`, httpOpts);
  const ts = r.timestamp ?? [];
  const closes = r.indicators.quote[0]?.close ?? [];
  const out = new Map<string, bigint>();
  ts.forEach((t, i) => {
    const c = closes[i];
    if (c === null || c === undefined) return;
    const d = instantToLocalDate(new Date(t * 1000).toISOString());
    if (d >= from && d <= to) out.set(d, toMilli(normalizeDecimal(c)));
  });
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, price]) => ({ date, price }));
}

export interface AssetSearchHit {
  source: QuoteSource;
  symbol: string;
  name: string;
  type: "crypto" | "etf" | "fund" | "stock";
}

const Search = z.looseObject({
  quotes: z.array(z.looseObject({ symbol: z.string(), quoteType: z.string().nullish(), shortname: z.string().nullish(), longname: z.string().nullish(), exchange: z.string().nullish() })).nullish(),
});

/** Yahoo's symbol search, US-priced stocks / ETFs / mutual funds / crypto only. */
export async function searchAssets(query: string, httpOpts: HttpClientOptions = {}): Promise<AssetSearchHit[]> {
  const http = createHttpClient({ ...httpOpts, provider: "yahoo" });
  const j = Search.parse(await http.getJson(`https://${YAHOO_HOST}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`, { headers: UA }));
  const out: AssetSearchHit[] = [];
  for (const q of j.quotes ?? []) {
    const type = q.quoteType === "ETF" ? "etf" : q.quoteType === "MUTUALFUND" ? "fund" : q.quoteType === "EQUITY" ? "stock" : q.quoteType === "CRYPTOCURRENCY" ? "crypto" : null;
    if (!type) continue;
    // US listings only (no ".L", ".TO" …); crypto as XYZ-USD, priced through Yahoo too
    if (type !== "crypto" && q.symbol.includes(".")) continue;
    if (type === "crypto" && !q.symbol.endsWith("-USD")) continue;
    out.push({ source: "yahoo", symbol: q.symbol, name: q.longname ?? q.shortname ?? q.symbol, type });
  }
  return out;
}
