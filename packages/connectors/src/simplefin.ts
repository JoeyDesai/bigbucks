/**
 * SimpleFIN Bridge connector (§7.1). Protocol: https://www.simplefin.org/protocol.html
 *
 * Read-only except the one-time claim POST (allowlisted in http.ts).
 */
import { z } from "zod";
import { addDays, today, LIABILITY_KINDS, type AccountKind, type ISODate, type Milli } from "@homebase/shared";
import { createHttpClient, type HttpClientOptions } from "./http";
import { blankToUndef, epochToIso, instantToLocalDate, localMidnightEpoch, mulMilliByDecimal, normalizeDecimal, toMilli, toMilliOpt } from "./normalize";
import { ConnectorError, type Connector, type ExternalAccount, type ExternalHolding, type ExternalTxn, type FetchTxnOpts } from "./types";

// ---------------------------------------------------------------------------------------------------------------------
// Constants & limits

/** Live Bridge warns above 45 days ("exceeds recommended range of 45 days"); protocol max is 90. */
export const SIMPLEFIN_DEFAULT_WINDOW_DAYS = 45;
export const SIMPLEFIN_MAX_WINDOW_DAYS = 90;
export const SIMPLEFIN_DAILY_REQUEST_BUDGET = 6;
export const SIMPLEFIN_MANUAL_DAILY_CAP = 2;
/** §7.1: normal syncs fetch the last 14 days. */
export const SIMPLEFIN_NORMAL_LOOKBACK_DAYS = 14;

// ---------------------------------------------------------------------------------------------------------------------
// Raw response schemas (lenient: unknown fields pass through, numbers or strings accepted)

const num = z.union([z.string(), z.number()]);

export const SimplefinTxnSchema = z.looseObject({
  id: z.string(),
  posted: z.coerce.number().default(0),
  amount: num,
  description: z.string().default(""),
  transacted_at: z.coerce.number().nullish(),
  pending: z.boolean().nullish(),
  payee: z.string().nullish(),
  memo: z.string().nullish(),
  mcc: z.union([z.string(), z.number()]).nullish(),
  extra: z.unknown().optional(),
});
export type SimplefinTxn = z.infer<typeof SimplefinTxnSchema>;

export const SimplefinAccountSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  conn_id: z.string().nullish(),
  currency: z.string().default("USD"),
  balance: num,
  "available-balance": num.nullish(),
  "balance-date": z.coerce.number(),
  transactions: z.array(z.unknown()).nullish(),
  holdings: z.array(z.unknown()).nullish(),
  org: z.looseObject({ name: z.string().nullish(), domain: z.string().nullish(), "sfin-url": z.string().nullish(), id: z.string().nullish() }).nullish(),
  extra: z.unknown().optional(),
});
export type SimplefinAccount = z.infer<typeof SimplefinAccountSchema>;

export const SimplefinErrorSchema = z.looseObject({
  code: z.string(),
  msg: z.string(),
  conn_id: z.string().nullish(),
  account_id: z.string().nullish(),
});
export type SimplefinErrorItem = z.infer<typeof SimplefinErrorSchema>;

export const SimplefinConnectionSchema = z.looseObject({
  conn_id: z.string(),
  name: z.string(),
  org_id: z.string().nullish(),
  org_name: z.string().nullish(),
  org_url: z.string().nullish(),
  sfin_url: z.string().nullish(),
});
export type SimplefinConnection = z.infer<typeof SimplefinConnectionSchema>;

const RawAccountSetSchema = z.looseObject({
  errlist: z.array(SimplefinErrorSchema).nullish(),
  errors: z.array(z.string()).nullish(),
  connections: z.array(SimplefinConnectionSchema).nullish(),
  accounts: z.array(z.unknown()).default([]),
});

/** Normalized (v2-shaped) account set. */
export interface SimplefinAccountSet {
  errlist: SimplefinErrorItem[];
  connections: SimplefinConnection[];
  accounts: SimplefinAccount[];
  /** Accounts that failed schema validation (kept for debugging, not mapped). */
  invalidAccounts: unknown[];
}

/** Parse a raw /accounts payload; accepts v2 and v1 (`errors` strings, per-account `org`) shapes. */
export function parseAccountSet(json: unknown): SimplefinAccountSet {
  const parsed = RawAccountSetSchema.safeParse(json);
  if (!parsed.success) throw new ConnectorError("parse", "SimpleFIN response is not an account set", { provider: "simplefin" });
  const raw = parsed.data;
  const errlist: SimplefinErrorItem[] = [...(raw.errlist ?? [])];
  if (!raw.errlist && raw.errors) for (const msg of raw.errors) errlist.push({ code: "gen.legacy", msg });
  const accounts: SimplefinAccount[] = [];
  const invalidAccounts: unknown[] = [];
  for (const a of raw.accounts) {
    const r = SimplefinAccountSchema.safeParse(a);
    if (r.success) accounts.push(r.data);
    else invalidAccounts.push(a);
  }
  const connections: SimplefinConnection[] = [...(raw.connections ?? [])];
  if (!raw.connections) {
    // v1: synthesize connections from per-account org objects.
    const seen = new Map<string, SimplefinConnection>();
    for (const a of accounts) {
      if (!a.org) continue;
      const id = a.org.id ?? a.org.domain ?? a.org.name ?? "org";
      const connId = `ORG:${id}`;
      if (!seen.has(connId)) {
        seen.set(connId, { conn_id: connId, name: a.org.name ?? a.org.domain ?? "Unknown institution", org_id: a.org.id ?? null, org_name: a.org.name ?? null, org_url: a.org.domain ?? null, sfin_url: a.org["sfin-url"] ?? null });
      }
      if (!a.conn_id) a.conn_id = connId;
    }
    connections.push(...seen.values());
  }
  return { errlist, connections, accounts, invalidAccounts };
}

// ---------------------------------------------------------------------------------------------------------------------
// Claim + access URL

/** Base64 setup token → claim URL. */
export function decodeSetupToken(setupToken: string): string {
  const cleaned = setupToken.trim();
  let url: string;
  try {
    url = Buffer.from(cleaned, "base64").toString("utf8").trim();
  } catch (e) {
    throw new ConnectorError("invalid_input", "SimpleFIN setup token is not valid base64", { provider: "simplefin", cause: e });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectorError("invalid_input", "SimpleFIN setup token does not decode to a URL", { provider: "simplefin" });
  }
  if (parsed.protocol !== "https:") throw new ConnectorError("invalid_input", "SimpleFIN claim URL must be https", { provider: "simplefin" });
  return parsed.toString();
}

export interface SimplefinAccess {
  /** Access URL with credentials stripped, e.g. https://host/simplefin */
  baseUrl: string;
  username: string;
  password: string;
}

/** Split an Access URL (https://user:pass@host/simplefin) into a credential-free base URL + basic auth. */
export function parseAccessUrl(accessUrl: string): SimplefinAccess {
  let u: URL;
  try {
    u = new URL(accessUrl.trim());
  } catch {
    throw new ConnectorError("invalid_input", "SimpleFIN access URL is not a URL", { provider: "simplefin" });
  }
  if (u.protocol !== "https:") throw new ConnectorError("invalid_input", "SimpleFIN access URL must be https", { provider: "simplefin" });
  if (!u.username) throw new ConnectorError("invalid_input", "SimpleFIN access URL has no credentials", { provider: "simplefin" });
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  return { baseUrl: u.toString().replace(/\/+$/, ""), username, password };
}

function basicAuth(a: SimplefinAccess): string {
  return `Basic ${Buffer.from(`${a.username}:${a.password}`, "utf8").toString("base64")}`;
}

/**
 * One-time claim: base64-decode the setup token, POST (no body) to the claim URL, return the Access URL.
 * 403 → already claimed / invalid token (possibly compromised).
 */
export async function claimSetupToken(setupToken: string, httpOpts: HttpClientOptions = {}): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
  const http = createHttpClient({ ...httpOpts, provider: "simplefin", retries: 0, secrets: [...(httpOpts.secrets ?? []), setupToken.trim()] });
  const res = await http.request(claimUrl, {
    method: "POST",
    allowWrite: "simplefin.claim",
    headers: { accept: "text/plain", "content-length": "0" },
    passStatuses: [403],
  });
  if (res.status === 403) {
    throw new ConnectorError(
      "already_claimed",
      "This SimpleFIN setup token was already claimed or is invalid. If you did not claim it yourself, your data may be exposed: revoke it in SimpleFIN Bridge and create a new token.",
      { provider: "simplefin", status: 403 },
    );
  }
  const accessUrl = (await res.text()).trim();
  parseAccessUrl(accessUrl); // validate shape
  return accessUrl;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fetch

export interface SimplefinFetchOptions {
  /** Epoch seconds, inclusive. */
  startDate?: number;
  /** Epoch seconds, exclusive. */
  endDate?: number;
  /** Include pending. When false the `pending` param is omitted entirely (some bridges treat presence as "on"). */
  pending?: boolean;
  accountIds?: string[];
  balancesOnly?: boolean;
}

/** Build the GET /accounts URL (credential-free). Always version=2. */
export function buildAccountsUrl(baseUrl: string, o: SimplefinFetchOptions = {}): string {
  const u = new URL(`${baseUrl.replace(/\/+$/, "")}/accounts`);
  u.searchParams.set("version", "2");
  if (o.startDate !== undefined) u.searchParams.set("start-date", String(Math.floor(o.startDate)));
  if (o.endDate !== undefined) u.searchParams.set("end-date", String(Math.floor(o.endDate)));
  if (o.pending) u.searchParams.set("pending", "1");
  for (const id of o.accountIds ?? []) u.searchParams.append("account", id);
  if (o.balancesOnly) u.searchParams.set("balances-only", "1");
  return u.toString();
}

/** GET /accounts. 402 → subscription lapsed, 403 → access revoked. */
export async function fetchAccountSet(accessUrl: string, o: SimplefinFetchOptions = {}, httpOpts: HttpClientOptions = {}): Promise<SimplefinAccountSet> {
  const access = parseAccessUrl(accessUrl);
  const http = createHttpClient({ ...httpOpts, provider: "simplefin", secrets: [...(httpOpts.secrets ?? []), access.password, access.username, accessUrl] });
  const res = await http.get(buildAccountsUrl(access.baseUrl, o), { headers: { authorization: basicAuth(access) }, passStatuses: [402, 403] });
  if (res.status === 402) throw new ConnectorError("subscription_lapsed", "SimpleFIN Bridge subscription has lapsed (HTTP 402). Renew it at beta-bridge.simplefin.org.", { provider: "simplefin", status: 402 });
  if (res.status === 403) throw new ConnectorError("revoked", "SimpleFIN access was revoked or the credentials are wrong (HTTP 403). Create a new setup token and reconnect.", { provider: "simplefin", status: 403 });
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch (e) {
    throw new ConnectorError("parse", "SimpleFIN returned invalid JSON", { provider: "simplefin", cause: e });
  }
  return parseAccountSet(json);
}

// ---------------------------------------------------------------------------------------------------------------------
// Windows & request budget

export interface EpochWindow {
  /** Epoch seconds, local midnight of `from` (inclusive). */
  start: number;
  /** Epoch seconds, local midnight of the day after `to` (exclusive). */
  end: number;
  from: ISODate;
  to: ISODate;
}

/** Split [since, until] (local dates, inclusive) into windows of ≤ maxDays days (default 45). */
export function dateWindows(since: ISODate, until: ISODate, maxDays = SIMPLEFIN_DEFAULT_WINDOW_DAYS): EpochWindow[] {
  if (maxDays < 1 || maxDays > SIMPLEFIN_MAX_WINDOW_DAYS) throw new ConnectorError("invalid_input", `Window must be 1–${SIMPLEFIN_MAX_WINDOW_DAYS} days`);
  if (until < since) return [];
  const out: EpochWindow[] = [];
  let from = since;
  while (from <= until) {
    let to = addDays(from, maxDays - 1);
    if (to > until) to = until;
    out.push({ from, to, start: localMidnightEpoch(from), end: localMidnightEpoch(addDays(to, 1)) });
    from = addDays(to, 1);
  }
  return out;
}

export interface SimplefinUsage {
  /** Requests already made today (scheduled + manual), local day. */
  usedToday: number;
  /** Of which manual "Sync now". */
  manualToday: number;
}

export interface BudgetDecision {
  allowed: boolean;
  remaining: number;
  reason?: string;
}

/**
 * Pure request-budget check (§7.1): ≤ 6 requests/day total, manual capped at 2/day.
 * `cost` is the number of requests the sync would make (one per window).
 */
export function checkSimplefinBudget(
  usage: SimplefinUsage,
  kind: "scheduled" | "manual",
  cost = 1,
  limits: { daily?: number; manual?: number } = {},
): BudgetDecision {
  const daily = limits.daily ?? SIMPLEFIN_DAILY_REQUEST_BUDGET;
  const manualCap = limits.manual ?? SIMPLEFIN_MANUAL_DAILY_CAP;
  const remaining = Math.max(0, daily - usage.usedToday);
  if (cost < 0 || !Number.isInteger(cost)) return { allowed: false, remaining, reason: "invalid cost" };
  if (usage.usedToday + cost > daily) return { allowed: false, remaining, reason: `Daily SimpleFIN budget of ${daily} requests reached` };
  if (kind === "manual" && usage.manualToday + cost > manualCap) return { allowed: false, remaining, reason: `Manual sync is limited to ${manualCap} per day` };
  return { allowed: true, remaining: remaining - cost };
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors → connection status

export type SimplefinIssueStatus = "needs_attention" | "retry_later" | "info";
export interface SimplefinIssue {
  code: string;
  msg: string;
  status: SimplefinIssueStatus;
  connId?: string;
  accountId?: string;
  /** User-facing banner text (only for needs_attention). */
  banner?: string;
}

/** Map errlist items to issues. `con.auth` → needs_attention ("Reconnect <bank> in SimpleFIN"). Unknown subcodes fall back to prefix. */
export function mapErrlist(errlist: SimplefinErrorItem[], connections: SimplefinConnection[] = []): SimplefinIssue[] {
  const byId = new Map(connections.map((c) => [c.conn_id, c]));
  return errlist.map((e) => {
    const base: SimplefinIssue = { code: e.code, msg: e.msg, status: "info" };
    if (e.conn_id) base.connId = e.conn_id;
    if (e.account_id) base.accountId = e.account_id;
    const prefix = e.code.split(".")[0];
    if (e.code === "con.auth" || (prefix === "con" && /auth|login|credential|mfa/i.test(e.code))) {
      const conn = e.conn_id ? byId.get(e.conn_id) : undefined;
      const name = conn?.org_name ?? conn?.name ?? "your bank";
      return { ...base, status: "needs_attention", banner: `Reconnect ${name} in SimpleFIN` };
    }
    if (e.code === "gen.auth") return { ...base, status: "needs_attention", banner: "SimpleFIN rejected our credentials; reconnect SimpleFIN" };
    if (prefix === "act" || prefix === "con") return { ...base, status: "retry_later" };
    return base;
  });
}

/** conn_ids that should be marked needs_attention. */
export function connectionsNeedingAttention(issues: SimplefinIssue[]): string[] {
  return [...new Set(issues.filter((i) => i.status === "needs_attention" && i.connId).map((i) => i.connId!))];
}

// ---------------------------------------------------------------------------------------------------------------------
// Mapping

/** Per-account sign override (Settings → `balance_sign`). */
export type BalanceSign = "auto" | "positive_is_debt" | "negative_is_debt";

/**
 * Normalize a liability balance to app convention (owed = negative).
 * - Assets: unchanged.
 * - positive_is_debt: negate (SimpleFIN protocol convention).
 * - negative_is_debt: unchanged (what some banks actually send on the live Bridge, seen 2026-10).
 * - auto: credit cards/LOCs: a positive balance is treated as owed (negated), ≤ 0 is kept;
 *         mortgages/loans: always −|balance|.
 */
export function normalizeLiabilityBalance(balance: Milli, kind: AccountKind, sign: BalanceSign = "auto"): Milli {
  if (!LIABILITY_KINDS.includes(kind)) return balance;
  if (sign === "positive_is_debt") return -balance;
  if (sign === "negative_is_debt") return balance;
  if (kind === "mortgage" || kind === "loan") return balance > 0n ? -balance : balance;
  return balance > 0n ? -balance : balance;
}

/** Heuristic account kind from SimpleFIN account + institution names. Nothing is put on budget automatically. */
export function guessSimplefinKind(name: string, institution = ""): AccountKind {
  const n = `${name} ${institution}`.toLowerCase();
  const nm = name.toLowerCase();
  if (/mortgage|home loan|heloc/.test(nm)) return /heloc/.test(nm) ? "line_of_credit" : "mortgage";
  if (/\b(401\s?\(?k\)?|403\s?\(?b\)?|457|ira|roth|retirement|pension|tsp)\b/.test(nm)) return "retirement";
  if (/\bhsa\b|health savings/.test(nm)) return "hsa";
  if (/credit card|\bcard\b|visa|mastercard|amex|american express|signature|rewards card/.test(nm)) return "credit_card";
  if (/line of credit|\bloc\b/.test(nm)) return "line_of_credit";
  if (/\bloan\b|auto loan|student/.test(nm)) return "loan";
  if (/bitcoin|\bbtc\b|crypto|coinbase|river/.test(n)) return "crypto";
  if (/brokerage|individual|joint wros|investment|cash management|trading/.test(nm)) return "brokerage";
  if (/saving|money market|\bmmA\b|\bcd\b/i.test(nm)) return "savings";
  if (/checking|banking|chequing|share draft|spend/.test(nm)) return "checking";
  // Card-only issuers: their accounts are cards even when the name says nothing ("Cash Back", "Card (0004)").
  if (/\b(american express|amex|barclays|discover|synchrony)\b/.test(institution.toLowerCase())) return "credit_card";
  if (/fidelity|vanguard|schwab|e\*?trade|robinhood/.test(institution.toLowerCase())) return "brokerage";
  return "other";
}

/** Map one SimpleFIN transaction. Date = transacted_at if > 0 else posted, in America/New_York (§6.1). */
export function mapSimplefinTxn(t: SimplefinTxn, accountId: string): ExternalTxn {
  const posted = t.posted ?? 0;
  const transacted = t.transacted_at ?? 0;
  const when = transacted > 0 ? transacted : posted;
  if (!(when > 0)) throw new ConnectorError("parse", `SimpleFIN transaction ${t.id} has no date`, { provider: "simplefin" });
  const pending = t.pending === true || posted === 0;
  const out: ExternalTxn = {
    externalId: t.id,
    accountExternalId: accountId,
    date: instantToLocalDate(when),
    postedAt: posted > 0 ? epochToIso(posted) : null,
    amount: toMilli(t.amount),
    description: (t.description ?? "").trim(),
    pending,
    raw: t,
  };
  const payee = blankToUndef(t.payee);
  const memo = blankToUndef(t.memo);
  const mcc = blankToUndef(t.mcc === null || t.mcc === undefined ? undefined : String(t.mcc));
  if (payee) out.payee = payee;
  if (memo) out.memo = memo;
  if (mcc) out.mcc = mcc;
  return out;
}

/** Institutions known to send holdings `cost_basis` as the position total instead of per share. */
export const TOTAL_COST_BASIS_INSTITUTIONS = /fidelity|vanguard|schwab|e\*?trade/i;

export interface CostBasisInput {
  costBasis: Milli;
  shares: string;
  marketValue?: Milli | undefined;
  institution?: string | undefined;
}

/**
 * Normalize SimpleFIN `cost_basis` to a position total.
 * The protocol says per-share; Fidelity/Vanguard/Schwab(/E*Trade) send the total.
 * For other institutions, fall back to a magnitude check against market value.
 */
export function normalizeCostBasis(i: CostBasisInput): { total: Milli; method: "institution_total" | "per_share" | "heuristic_total" } {
  if (i.institution && TOTAL_COST_BASIS_INSTITUTIONS.test(i.institution)) return { total: i.costBasis, method: "institution_total" };
  const asTotal = mulMilliByDecimal(i.costBasis, i.shares);
  const mv = i.marketValue;
  if (mv !== undefined && mv > 0n && i.costBasis > 0n && asTotal > 0n) {
    // Distance from market value as a ratio ≥ 1, compared by cross-multiplication (no floats).
    // Read as a total only if the per-share reading is ≥ 3× off and the total reading is closer.
    const hi = (a: Milli, b: Milli) => (a > b ? a : b);
    const lo = (a: Milli, b: Milli) => (a > b ? b : a);
    const perShareOff3x = hi(asTotal, mv) >= lo(asTotal, mv) * 3n;
    const totalCloser = hi(i.costBasis, mv) * lo(asTotal, mv) < hi(asTotal, mv) * lo(i.costBasis, mv);
    if (perShareOff3x && totalCloser) return { total: i.costBasis, method: "heuristic_total" };
  }
  return { total: asTotal, method: "per_share" };
}

const SimplefinHoldingSchema = z.looseObject({
  id: z.string().nullish(),
  symbol: z.string().nullish(),
  description: z.string().nullish(),
  shares: num.nullish(),
  market_value: num.nullish(),
  cost_basis: num.nullish(),
  purchase_price: num.nullish(),
  currency: z.string().nullish(),
  created: z.coerce.number().nullish(),
});

/** Parse undocumented holdings[]. Each element is one lot. Never throws: bad rows go to `warnings`. */
export function parseSimplefinHoldings(account: SimplefinAccount, institution?: string): { holdings: ExternalHolding[]; warnings: string[] } {
  const holdings: ExternalHolding[] = [];
  const warnings: string[] = [];
  try {
    const rows = Array.isArray(account.holdings) ? account.holdings : [];
    const asOf = epochToIso(account["balance-date"]);
    rows.forEach((row, idx) => {
      try {
        const h = SimplefinHoldingSchema.parse(row);
        const symbol = blankToUndef(h.symbol) ?? blankToUndef(h.description);
        if (!symbol) throw new Error("holding without symbol/description");
        const shares = h.shares === null || h.shares === undefined || h.shares === "" ? "0" : normalizeDecimal(h.shares);
        const marketValue = toMilliOpt(h.market_value);
        const out: ExternalHolding = {
          accountExternalId: account.id,
          externalId: blankToUndef(h.id) ?? `${account.id}:${idx}`,
          symbol: symbol.toUpperCase(),
          shares,
          currency: blankToUndef(h.currency) ?? account.currency ?? "USD",
          asOf,
          raw: row,
        };
        const desc = blankToUndef(h.description);
        if (desc) out.description = desc;
        if (marketValue !== undefined) out.marketValue = marketValue;
        // A 0 cost basis on a position worth something means "unknown" (Fidelity via SimpleFIN sends 0).
        const known = (v: Milli | undefined) => (v === undefined || (v === 0n && marketValue !== undefined && marketValue !== 0n) ? undefined : v);
        const cb = known(toMilliOpt(h.cost_basis));
        if (cb !== undefined) {
          out.costBasis = normalizeCostBasis({ costBasis: cb, shares, marketValue, institution }).total;
        } else {
          const pp = known(toMilliOpt(h.purchase_price));
          if (pp !== undefined) out.costBasis = mulMilliByDecimal(pp, shares);
        }
        holdings.push(out);
      } catch (e) {
        warnings.push(`account ${account.id} holding #${idx}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  } catch (e) {
    warnings.push(`account ${account.id} holdings unreadable; degraded to balance-only: ${e instanceof Error ? e.message : String(e)}`);
    return { holdings: [], warnings };
  }
  return { holdings, warnings };
}

export interface SimplefinMapOptions {
  /** Known account kinds by SimpleFIN account id (from the DB); otherwise guessed. */
  kinds?: Record<string, AccountKind>;
  /** Per-account `balance_sign` override. */
  balanceSigns?: Record<string, BalanceSign>;
}

export interface SimplefinMapped {
  accounts: ExternalAccount[];
  transactions: ExternalTxn[];
  holdings: ExternalHolding[];
  issues: SimplefinIssue[];
  warnings: string[];
}

/** Map a full account set into normalized accounts / txns / holdings / issues. */
export function mapAccountSet(set: SimplefinAccountSet, opts: SimplefinMapOptions = {}): SimplefinMapped {
  const conns = new Map(set.connections.map((c) => [c.conn_id, c]));
  const out: SimplefinMapped = { accounts: [], transactions: [], holdings: [], issues: mapErrlist(set.errlist, set.connections), warnings: [] };
  if (set.invalidAccounts.length) out.warnings.push(`${set.invalidAccounts.length} account(s) failed validation and were skipped`);
  for (const a of set.accounts) {
    const conn = a.conn_id ? conns.get(a.conn_id) : undefined;
    const institution = conn?.org_name ?? conn?.name ?? a.org?.name ?? undefined;
    const kind = opts.kinds?.[a.id] ?? guessSimplefinKind(a.name, institution ?? "");
    const sign = opts.balanceSigns?.[a.id] ?? "auto";
    const balance = normalizeLiabilityBalance(toMilli(a.balance), kind, sign);
    const acct: ExternalAccount = {
      externalId: a.id,
      name: a.name,
      kindGuess: kind,
      currency: a.currency ?? "USD",
      balance,
      asOf: epochToIso(a["balance-date"]),
      raw: { ...a, transactions: undefined, holdings: undefined },
    };
    const avail = toMilliOpt(a["available-balance"] ?? undefined);
    if (avail !== undefined) acct.availableBalance = avail;
    if (a.conn_id) acct.connectionId = a.conn_id;
    if (institution) acct.institution = institution;
    out.accounts.push(acct);

    for (const rawTxn of a.transactions ?? []) {
      const r = SimplefinTxnSchema.safeParse(rawTxn);
      if (!r.success) {
        out.warnings.push(`account ${a.id}: skipped malformed transaction`);
        continue;
      }
      try {
        out.transactions.push(mapSimplefinTxn(r.data, a.id));
      } catch (e) {
        out.warnings.push(`account ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const h = parseSimplefinHoldings(a, institution);
    out.holdings.push(...h.holdings);
    out.warnings.push(...h.warnings);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Connector

export interface SimplefinCreds {
  /** Decrypted Access URL (https://user:pass@host/simplefin). */
  accessUrl: string;
}

export interface SimplefinConnectorOptions extends SimplefinMapOptions {
  http?: HttpClientOptions;
  /** Include pending transactions (default true). */
  pending?: boolean;
  windowDays?: number;
  /** Called with issues/warnings from every response (sync service records them). */
  onIssues?: (issues: SimplefinIssue[], warnings: string[]) => void;
}

export function createSimplefinConnector(o: SimplefinConnectorOptions = {}): Connector<SimplefinCreds> & {
  fetchAll(creds: SimplefinCreds, opts: FetchTxnOpts): Promise<SimplefinMapped>;
} {
  const pending = o.pending ?? true;
  const report = (m: SimplefinMapped) => o.onIssues?.(m.issues, m.warnings);

  async function fetchAll(creds: SimplefinCreds, opts: FetchTxnOpts): Promise<SimplefinMapped> {
    const merged: SimplefinMapped = { accounts: [], transactions: [], holdings: [], issues: [], warnings: [] };
    const seenTxn = new Set<string>();
    const windows = dateWindows(opts.since, opts.until, o.windowDays ?? SIMPLEFIN_DEFAULT_WINDOW_DAYS);
    for (const w of windows) {
      const set = await fetchAccountSet(creds.accessUrl, { startDate: w.start, endDate: w.end, pending, ...(opts.accountIds ? { accountIds: opts.accountIds } : {}) }, o.http);
      const m = mapAccountSet(set, o);
      report(m);
      merged.accounts = m.accounts; // latest window's balances win
      merged.holdings = m.holdings;
      merged.issues.push(...m.issues);
      merged.warnings.push(...m.warnings);
      for (const t of m.transactions) {
        const k = `${t.accountExternalId}|${t.externalId}`;
        if (seenTxn.has(k)) continue;
        seenTxn.add(k);
        merged.transactions.push(t);
      }
    }
    return merged;
  }

  return {
    provider: "simplefin",
    async test(creds) {
      try {
        const set = await fetchAccountSet(creds.accessUrl, { balancesOnly: true }, o.http);
        const issues = mapErrlist(set.errlist, set.connections);
        const attention = issues.filter((i) => i.status === "needs_attention");
        if (attention.length) return { ok: true, message: `Connected (${set.accounts.length} accounts); ${attention.map((i) => i.banner).join("; ")}` };
        return { ok: true, message: `Connected: ${set.accounts.length} accounts across ${set.connections.length} institutions` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async listAccounts(creds) {
      const set = await fetchAccountSet(creds.accessUrl, { balancesOnly: true }, o.http);
      const m = mapAccountSet(set, o);
      report(m);
      return m.accounts;
    },
    async fetchTransactions(creds, opts) {
      return (await fetchAll(creds, opts)).transactions;
    },
    async fetchHoldings(creds) {
      // Holdings are not guaranteed with balances-only=1, so fetch a one-day window instead.
      const d = today();
      return (await fetchAll(creds, { since: d, until: d })).holdings;
    },
    fetchAll,
  };
}
