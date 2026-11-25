/**
 * Mercury direct API (§7.2). Read-only token; GET only.
 * Docs: https://docs.mercury.com/reference/getaccounts, /reference/listtransactions
 */
import { z } from "zod";
import type { AccountKind, ISODate } from "@homebase/shared";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "./http";
import { blankToUndef, instantToLocalDate, toMilli } from "./normalize";
import { ConnectorError, type Connector, type ExternalAccount, type ExternalTxn, type FetchTxnOpts } from "./types";

export const MERCURY_BASE_URL = "https://api.mercury.com/api/v1";
const MAX_PAGES = 500;

const PageSchema = z.looseObject({ nextPage: z.string().nullish(), previousPage: z.string().nullish() }).nullish();

export const MercuryAccountSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  nickname: z.string().nullish(),
  status: z.string(),
  type: z.string().nullish(),
  kind: z.string().nullish(),
  currentBalance: z.number(),
  availableBalance: z.number().nullish(),
  createdAt: z.string().nullish(),
  legalBusinessName: z.string().nullish(),
});
export type MercuryAccount = z.infer<typeof MercuryAccountSchema>;

export const MercuryTransactionSchema = z.looseObject({
  id: z.string(),
  accountId: z.string().nullish(),
  amount: z.number(),
  status: z.string(),
  kind: z.string().nullish(),
  createdAt: z.string(),
  postedAt: z.string().nullish(),
  counterpartyName: z.string().nullish(),
  counterpartyNickname: z.string().nullish(),
  bankDescription: z.string().nullish(),
  mercuryCategory: z.string().nullish(),
  note: z.string().nullish(),
  externalMemo: z.string().nullish(),
  merchant: z.looseObject({ categoryCode: z.string().nullish() }).nullish(),
});
export type MercuryTransaction = z.infer<typeof MercuryTransactionSchema>;

const AccountsResponse = z.looseObject({ accounts: z.array(MercuryAccountSchema), page: PageSchema });
const TransactionsResponse = z.looseObject({ transactions: z.array(z.unknown()), page: PageSchema, total: z.number().nullish() });

/** Map Mercury status → pending flag, or null to skip (§7.2). */
export function mapMercuryStatus(status: string): { pending: boolean } | null {
  switch (status) {
    case "pending":
      return { pending: true };
    case "sent":
      return { pending: false };
    case "failed":
    case "cancelled":
    case "blocked":
    case "reversed":
      return null;
    default:
      return { pending: false };
  }
}

export function mercuryAuthHeader(token: string): string {
  const t = token.trim();
  return `Bearer ${t.startsWith("secret-token:") ? t : `secret-token:${t}`}`;
}

export function guessMercuryKind(a: MercuryAccount): AccountKind {
  const k = `${a.kind ?? ""} ${a.name}`.toLowerCase();
  if (/saving/.test(k)) return "savings";
  if (/treasury|invest/.test(k)) return "brokerage";
  if (/credit/.test(k)) return "credit_card";
  return "checking";
}

export function mapMercuryAccount(a: MercuryAccount, asOf: string): ExternalAccount {
  const out: ExternalAccount = {
    externalId: a.id,
    name: a.nickname?.trim() || a.name,
    kindGuess: guessMercuryKind(a),
    currency: "USD",
    balance: toMilli(a.currentBalance),
    asOf,
    institution: "Mercury",
    raw: { ...a, accountNumber: undefined, routingNumber: undefined },
  };
  if (a.availableBalance !== null && a.availableBalance !== undefined) out.availableBalance = toMilli(a.availableBalance);
  return out;
}

/** Map one transaction, or null for failed/cancelled/blocked. Date = createdAt (≈ transacted) in local time. */
export function mapMercuryTransaction(t: MercuryTransaction, fallbackAccountId?: string): ExternalTxn | null {
  const st = mapMercuryStatus(t.status);
  if (!st) return null;
  const accountId = t.accountId ?? fallbackAccountId;
  if (!accountId) throw new ConnectorError("parse", `Mercury transaction ${t.id} has no accountId`, { provider: "mercury" });
  const description = blankToUndef(t.bankDescription) ?? blankToUndef(t.counterpartyName) ?? t.kind ?? "Mercury transaction";
  const out: ExternalTxn = {
    externalId: t.id,
    accountExternalId: accountId,
    date: instantToLocalDate(t.createdAt),
    postedAt: t.postedAt && !st.pending ? new Date(t.postedAt).toISOString() : null,
    amount: toMilli(t.amount),
    description,
    pending: st.pending,
    raw: t,
  };
  const payee = blankToUndef(t.counterpartyNickname) ?? blankToUndef(t.counterpartyName);
  if (payee) out.payee = payee;
  const memo = [blankToUndef(t.note), blankToUndef(t.externalMemo)].filter(Boolean).join(" · ");
  if (memo) out.memo = memo;
  const mcc = blankToUndef(t.merchant?.categoryCode);
  if (mcc) out.mcc = mcc;
  return out;
}

export interface MercuryCreds {
  token: string;
}

export interface MercuryClient {
  listAccounts(): Promise<MercuryAccount[]>;
  listTransactions(o: { start: ISODate; end: ISODate; accountIds?: string[] }): Promise<MercuryTransaction[]>;
}

export function createMercuryClient(creds: MercuryCreds, httpOpts: HttpClientOptions = {}, baseUrl = MERCURY_BASE_URL): MercuryClient {
  const http: HttpClient = createHttpClient({
    ...httpOpts,
    provider: "mercury",
    secrets: [...(httpOpts.secrets ?? []), creds.token],
    headers: { ...(httpOpts.headers ?? {}), authorization: mercuryAuthHeader(creds.token) },
  });

  async function paginate<T>(path: string, query: Record<string, string | number | string[] | undefined>, pick: (j: unknown) => { items: T[]; next?: string | null | undefined }): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await http.getJson(`${baseUrl}${path}`, { query: { ...query, ...(cursor ? { start_after: cursor } : {}) } });
      const { items, next } = pick(json);
      out.push(...items);
      if (!next || items.length === 0 || seen.has(next)) return out;
      seen.add(next);
      cursor = next;
    }
    throw new ConnectorError("parse", `Mercury pagination exceeded ${MAX_PAGES} pages`, { provider: "mercury" });
  }

  return {
    listAccounts: () =>
      paginate(`/accounts`, { limit: 1000 }, (j) => {
        const r = AccountsResponse.parse(j);
        return { items: r.accounts, next: r.page?.nextPage };
      }),
    async listTransactions(o) {
      const raw = await paginate<unknown>(`/transactions`, { start: o.start, end: o.end, limit: 1000, order: "asc", accountId: o.accountIds }, (j) => {
        const r = TransactionsResponse.parse(j);
        return { items: r.transactions, next: r.page?.nextPage };
      });
      return raw.map((t) => MercuryTransactionSchema.parse(t));
    },
  };
}

export function createMercuryConnector(o: { http?: HttpClientOptions; baseUrl?: string; now?: () => Date } = {}): Connector<MercuryCreds> {
  const now = o.now ?? (() => new Date());
  const client = (c: MercuryCreds) => createMercuryClient(c, o.http, o.baseUrl);
  return {
    provider: "mercury",
    async test(creds) {
      try {
        const accts = await client(creds).listAccounts();
        return { ok: true, message: `Connected: ${accts.filter((a) => a.status === "active").length} active Mercury accounts` };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async listAccounts(creds) {
      const asOf = now().toISOString();
      return (await client(creds).listAccounts()).filter((a) => a.status !== "deleted").map((a) => mapMercuryAccount(a, asOf));
    },
    async fetchTransactions(creds, opts: FetchTxnOpts) {
      const txns = await client(creds).listTransactions({ start: opts.since, end: opts.until, ...(opts.accountIds ? { accountIds: opts.accountIds } : {}) });
      const out: ExternalTxn[] = [];
      for (const t of txns) {
        const m = mapMercuryTransaction(t);
        if (m) out.push(m);
      }
      return out;
    },
  };
}
