/**
 * Coinbase App API (§7.3). CDP Secret API key (ECDSA P-256, view scope); a fresh ES256 JWT per request.
 * Docs: https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication
 * JWT signing is local (node:crypto); every HTTP call is GET.
 */
import { createPrivateKey, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "./http";
import { blankToUndef, instantToLocalDate, normalizeDecimal, toMilli } from "./normalize";
import { ConnectorError, type Connector, type ExternalAccount, type ExternalHolding, type ExternalTxn, type FetchTxnOpts } from "./types";

export const COINBASE_HOST = "api.coinbase.com";
export const COINBASE_ACCOUNT_ID = "coinbase";
const MAX_PAGES = 200;

export interface CoinbaseCreds {
  /** organizations/{org_id}/apiKeys/{key_id} */
  keyName: string;
  /** EC private key PEM (SEC1 "EC PRIVATE KEY" or PKCS#8); literal "\n" escapes are accepted. */
  privateKeyPem: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function loadCoinbaseKey(pem: string): KeyObject {
  const text = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: "pem" });
  } catch (e) {
    throw new ConnectorError("invalid_input", "Coinbase key is not a valid PEM private key", { provider: "coinbase", cause: e });
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== "ec" || (curve !== "prime256v1" && curve !== "P-256")) {
    throw new ConnectorError("invalid_input", "Coinbase key must be ECDSA P-256 (Ed25519 keys are not supported)", { provider: "coinbase" });
  }
  return key;
}

/** Build the ES256 JWT for one request. `path` excludes the query string. */
export function signCoinbaseJwt(o: {
  keyName: string;
  key: KeyObject | string;
  method: string;
  host?: string;
  path: string;
  nowSeconds?: number;
  nonce?: string;
}): string {
  const key = typeof o.key === "string" ? loadCoinbaseKey(o.key) : o.key;
  const now = o.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: o.keyName, nonce: o.nonce ?? randomBytes(16).toString("hex"), typ: "JWT" };
  const claims = { iss: "cdp", sub: o.keyName, nbf: now, exp: now + 120, uri: `${o.method.toUpperCase()} ${o.host ?? COINBASE_HOST}${o.path}` };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = cryptoSign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

const MoneySchema = z.looseObject({ amount: z.string(), currency: z.string() });
const CurrencySchema = z.union([z.string(), z.looseObject({ code: z.string(), name: z.string().nullish() })]);

export const CoinbaseAccountSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  primary: z.boolean().nullish(),
  type: z.string().nullish(),
  currency: CurrencySchema,
  balance: MoneySchema,
  native_balance: MoneySchema.nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});
export type CoinbaseAccount = z.infer<typeof CoinbaseAccountSchema>;

export const CoinbaseTransactionSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  amount: MoneySchema,
  native_amount: MoneySchema.nullish(),
  description: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  details: z.looseObject({ title: z.string().nullish(), subtitle: z.string().nullish(), header: z.string().nullish() }).nullish(),
  network: z.looseObject({ status: z.string().nullish(), hash: z.string().nullish() }).nullish(),
});
export type CoinbaseTransaction = z.infer<typeof CoinbaseTransactionSchema>;

const ListResponse = z.looseObject({
  pagination: z.looseObject({ next_uri: z.string().nullish(), next_starting_after: z.string().nullish() }).nullish(),
  data: z.array(z.unknown()),
});

export const currencyCode = (c: CoinbaseAccount["currency"]): string => (typeof c === "string" ? c : c.code);

export interface CoinbaseClient {
  listAccounts(): Promise<CoinbaseAccount[]>;
  listTransactions(accountId: string): Promise<CoinbaseTransaction[]>;
}

export function createCoinbaseClient(creds: CoinbaseCreds, httpOpts: HttpClientOptions = {}, o: { now?: () => number; base?: string } = {}): CoinbaseClient {
  const key = loadCoinbaseKey(creds.privateKeyPem);
  const base = o.base ?? `https://${COINBASE_HOST}`;
  const http: HttpClient = createHttpClient({
    ...httpOpts,
    provider: "coinbase",
    secrets: [...(httpOpts.secrets ?? []), creds.privateKeyPem],
    // Fresh JWT per request (including retries), bound to the method + host + path.
    beforeRequest: async (req) => {
      await httpOpts.beforeRequest?.(req);
      const nowSeconds = o.now ? Math.floor(o.now() / 1000) : undefined;
      req.headers.authorization = `Bearer ${signCoinbaseJwt({ keyName: creds.keyName, key, method: req.method, host: req.url.host, path: req.url.pathname, ...(nowSeconds !== undefined ? { nowSeconds } : {}) })}`;
    },
  });

  async function paginate(path: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let next: string | null | undefined = path;
    const seen = new Set<string>();
    for (let i = 0; i < MAX_PAGES && next; i++) {
      if (seen.has(next)) break;
      seen.add(next);
      const r = ListResponse.parse(await http.getJson(`${base}${next}`));
      out.push(...r.data);
      next = r.pagination?.next_uri ?? null;
    }
    return out;
  }

  return {
    listAccounts: async () => (await paginate("/v2/accounts?limit=100")).map((a) => CoinbaseAccountSchema.parse(a)),
    listTransactions: async (accountId) => (await paginate(`/v2/accounts/${encodeURIComponent(accountId)}/transactions?limit=100`)).map((t) => CoinbaseTransactionSchema.parse(t)),
  };
}

/** Public (unauthenticated) spot price, e.g. BTC-USD → { amount: milli per 1 unit }. */
export async function getCoinbaseSpotPrice(pair: string, httpOpts: HttpClientOptions = {}): Promise<{ base: string; currency: string; price: bigint }> {
  const http = createHttpClient({ ...httpOpts, provider: "coinbase" });
  const j = z.looseObject({ data: z.looseObject({ amount: z.string(), base: z.string(), currency: z.string() }) }).parse(await http.getJson(`https://${COINBASE_HOST}/v2/prices/${encodeURIComponent(pair)}/spot`));
  return { base: j.data.base, currency: j.data.currency, price: toMilli(j.data.amount) };
}

export const COINBASE_EXCHANGE_HOST = "api.exchange.coinbase.com";

/**
 * Public daily closing prices (UTC days) from the Coinbase Exchange candles endpoint, oldest first.
 * At most 300 candles per request, so long ranges are fetched in chunks.
 */
export async function getCoinbaseDailyCloses(pair: string, from: string, to: string, httpOpts: HttpClientOptions = {}): Promise<{ date: string; price: bigint }[]> {
  const http = createHttpClient({ ...httpOpts, provider: "coinbase" });
  const Candles = z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]).rest(z.unknown()));
  const out = new Map<string, bigint>();
  const DAY = 86_400_000;
  for (let start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); start <= end; start += 299 * DAY) {
    const chunkEnd = Math.min(end, start + 298 * DAY);
    const q = `granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(chunkEnd + DAY - 1000).toISOString()}`;
    const rows = Candles.parse(await http.getJson(`https://${COINBASE_EXCHANGE_HOST}/products/${encodeURIComponent(pair)}/candles?${q}`));
    for (const [t, , , , close] of rows) out.set(new Date(t * 1000).toISOString().slice(0, 10), toMilli(normalizeDecimal(close)));
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, price]) => ({ date, price }));
}

const SKIP_STATUSES = new Set(["canceled", "cancelled", "expired", "failed"]);
const PENDING_STATUSES = new Set(["pending", "waiting_for_clearing", "waiting_for_signature"]);

/** USD value of a Coinbase wallet (native_balance when USD; USD wallets value at face). */
export function coinbaseUsdValue(a: CoinbaseAccount): bigint | undefined {
  if (a.native_balance && a.native_balance.currency === "USD") return toMilli(a.native_balance.amount);
  if (a.balance.currency === "USD") return toMilli(a.balance.amount);
  return undefined;
}

export function mapCoinbaseHoldings(accounts: CoinbaseAccount[], asOf: string): ExternalHolding[] {
  const out: ExternalHolding[] = [];
  for (const a of accounts) {
    const shares = normalizeDecimal(a.balance.amount);
    if (shares === "0") continue;
    const h: ExternalHolding = { accountExternalId: COINBASE_ACCOUNT_ID, externalId: a.id, symbol: currencyCode(a.currency).toUpperCase(), shares, currency: "USD", asOf, raw: a };
    if (a.name) h.description = a.name;
    const mv = coinbaseUsdValue(a);
    if (mv !== undefined) h.marketValue = mv;
    out.push(h);
  }
  return out;
}

/** Map a Coinbase transaction to the single "Coinbase" tracking account; amount is the USD native amount. */
export function mapCoinbaseTransaction(t: CoinbaseTransaction): ExternalTxn | null {
  if (SKIP_STATUSES.has(t.status)) return null;
  const pending = PENDING_STATUSES.has(t.status);
  const usd = t.native_amount && t.native_amount.currency === "USD" ? t.native_amount.amount : t.amount.currency === "USD" ? t.amount.amount : "0";
  const title = blankToUndef(t.details?.title);
  const subtitle = blankToUndef(t.details?.subtitle);
  const out: ExternalTxn = {
    externalId: t.id,
    accountExternalId: COINBASE_ACCOUNT_ID,
    date: instantToLocalDate(t.created_at),
    postedAt: pending ? null : new Date(t.created_at).toISOString(),
    amount: toMilli(usd),
    description: [title ?? t.type, subtitle].filter(Boolean).join(" — "),
    pending,
    asset: { symbol: t.amount.currency.toUpperCase(), quantity: normalizeDecimal(t.amount.amount) },
    raw: t,
  };
  const memo = blankToUndef(t.description);
  if (memo) out.memo = memo;
  return out;
}

export function createCoinbaseConnector(o: { http?: HttpClientOptions; now?: () => number; base?: string } = {}): Connector<CoinbaseCreds> {
  const now = o.now ?? (() => Date.now());
  const client = (c: CoinbaseCreds) => createCoinbaseClient(c, o.http, { ...(o.now ? { now: o.now } : {}), ...(o.base ? { base: o.base } : {}) });
  return {
    provider: "coinbase",
    async test(creds) {
      try {
        const a = await client(creds).listAccounts();
        return { ok: true, message: `Connected: ${a.length} Coinbase wallets` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async listAccounts(creds) {
      const wallets = await client(creds).listAccounts();
      let total = 0n;
      for (const w of wallets) total += coinbaseUsdValue(w) ?? 0n;
      return [{ externalId: COINBASE_ACCOUNT_ID, name: "Coinbase", kindGuess: "crypto", currency: "USD", balance: total, asOf: new Date(now()).toISOString(), institution: "Coinbase", raw: { walletCount: wallets.length } } satisfies ExternalAccount];
    },
    async fetchHoldings(creds) {
      return mapCoinbaseHoldings(await client(creds).listAccounts(), new Date(now()).toISOString());
    },
    async fetchTransactions(creds, opts: FetchTxnOpts) {
      const c = client(creds);
      const wallets = await c.listAccounts();
      const out: ExternalTxn[] = [];
      for (const w of wallets) {
        if (opts.accountIds && !opts.accountIds.includes(COINBASE_ACCOUNT_ID) && !opts.accountIds.includes(w.id)) continue;
        for (const t of await c.listTransactions(w.id)) {
          const m = mapCoinbaseTransaction(t);
          if (m && m.date >= opts.since && m.date <= opts.until) out.push(m);
        }
      }
      return out;
    },
  };
}
