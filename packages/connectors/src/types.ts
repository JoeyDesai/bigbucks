import type { AccountKind, ISODate, Milli } from "@homebase/shared";

/** Every external data source a connector can talk to. */
export const PROVIDERS = [
  "simplefin",
  "mercury",
  "coinbase",
  "river_csv",
  "xpub",
  "fidelity_csv",
  "rentcast",
  "ynab",
  "gusto",
  "csv",
  "ofx",
  "yahoo",
] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Normalized account as reported by a provider. Balances follow app convention: liabilities are negative. */
export interface ExternalAccount {
  externalId: string;
  name: string;
  kindGuess: AccountKind;
  currency: string;
  /** Current balance, milliunits. Liabilities negative (owed). */
  balance: Milli;
  availableBalance?: Milli;
  /** ISO-8601 instant the balance is as of. */
  asOf: string;
  /** Provider connection / institution grouping (SimpleFIN conn_id, etc.). */
  connectionId?: string;
  institution?: string;
  raw: unknown;
}

/** Normalized transaction. */
export interface ExternalTxn {
  externalId: string;
  accountExternalId: string;
  /** Local budget date (America/New_York): transacted_at if known, else posted (§6.1). */
  date: ISODate;
  /** ISO-8601 instant the txn posted, null while pending / unknown. */
  postedAt: string | null;
  /** Milliunits; + inflow / − outflow. */
  amount: Milli;
  description: string;
  payee?: string;
  memo?: string;
  pending: boolean;
  mcc?: string;
  /** Non-cash asset movement (crypto, shares) when the provider reports one. Quantity is a signed decimal string. */
  asset?: { symbol: string; quantity: string };
  raw: unknown;
}

/** One holding row. Providers that report lots produce one row per lot; views sum per symbol. */
export interface ExternalHolding {
  accountExternalId: string;
  /** Stable id for the lot/position when the provider gives one. */
  externalId?: string;
  symbol: string;
  description?: string;
  /** Decimal string (never a float). */
  shares: string;
  marketValue?: Milli;
  /** Total cost basis for this row (normalized; never per-share). */
  costBasis?: Milli;
  currency: string;
  asOf: string;
  raw: unknown;
}

export interface FetchTxnOpts {
  accountIds?: string[];
  since: ISODate;
  until: ISODate;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

/** §7 connector interface. `C` is the provider's decrypted credential shape. */
export interface Connector<C = unknown> {
  provider: Provider;
  test(creds: C): Promise<TestResult>;
  listAccounts(creds: C): Promise<ExternalAccount[]>;
  fetchTransactions(creds: C, opts: FetchTxnOpts): Promise<ExternalTxn[]>;
  fetchHoldings?(creds: C): Promise<ExternalHolding[]>;
}

export type ConnectorErrorCode =
  | "auth"
  | "needs_attention"
  | "subscription_lapsed"
  | "revoked"
  | "already_claimed"
  | "rate_limited"
  | "budget_exceeded"
  | "http"
  | "network"
  | "timeout"
  | "parse"
  | "read_only_violation"
  | "invalid_input";

/** Error safe to surface in UI/logs: messages never include credentials. */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly status?: number;
  readonly provider?: Provider;
  constructor(code: ConnectorErrorCode, message: string, opts: { status?: number; provider?: Provider; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ConnectorError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.provider !== undefined) this.provider = opts.provider;
  }
}
