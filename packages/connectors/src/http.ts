/**
 * Read-only HTTP wrapper used by every connector (§4.6).
 *
 * - Only GET is allowed. The single exception is the SimpleFIN one-time claim POST, which must pass
 *   `allowWrite: "simplefin.claim"` and send no body.
 * - Timeouts via AbortController, retry with exponential backoff on 429/5xx/network errors.
 * - Errors never contain credentials: URL userinfo, query secrets, and registered secret strings are redacted.
 *
 * No other module in src/ may call `fetch` directly (enforced by test/readOnly.test.ts).
 */
import { ConnectorError, type Provider } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The only non-GET requests that may ever leave this package. Frozen; do not add to it. */
export const WRITE_ALLOWLIST: readonly string[] = Object.freeze(["simplefin.claim"]);

export interface HttpClientOptions {
  fetch?: FetchLike;
  provider?: Provider;
  timeoutMs?: number;
  /** Retries after the first attempt for 429/5xx/network errors. */
  retries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Extra secret strings to redact from any error message (tokens, keys). */
  secrets?: string[];
  /** Default headers on every request. */
  headers?: Record<string, string>;
  /** Hook called before each request (e.g. rate limiters, per-request JWT signing). */
  beforeRequest?: (req: { method: string; url: URL; headers: Record<string, string> }) => void | Promise<void>;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null | Array<string | number>>;
  body?: string;
  /** Required for any non-GET; must be a member of WRITE_ALLOWLIST. */
  allowWrite?: string;
  /** Override client retries for this call. */
  retries?: number;
  timeoutMs?: number;
  /** HTTP statuses that should be returned to the caller instead of thrown. */
  passStatuses?: number[];
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Remove credentials from a URL string for safe display. */
export function redactUrl(input: string): string {
  try {
    const u = new URL(input);
    if (u.username || u.password) {
      u.username = "REDACTED";
      u.password = "";
    }
    for (const k of [...u.searchParams.keys()]) {
      if (/token|key|secret|password|auth|signature/i.test(k)) u.searchParams.set(k, "REDACTED");
    }
    return u.toString();
  } catch {
    return input.replace(/\/\/[^/@\s]+@/g, "//REDACTED@");
  }
}

/** Redact registered secrets and any embedded basic-auth / bearer values from free text. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/(https?:\/\/)[^/@\s:]+(:[^/@\s]*)?@/gi, "$1REDACTED@");
  out = out.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=:-]+/g, "$1 REDACTED");
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("REDACTED");
  }
  return out;
}

function buildUrl(url: string, query?: RequestOptions["query"]): URL {
  const u = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
      else u.searchParams.set(k, String(v));
    }
  }
  return u;
}

/** Throws unless the request is a GET, or the explicitly allowlisted body-less SimpleFIN claim POST. */
export function assertReadOnly(method: string, opts: { allowWrite?: string; body?: string | undefined } = {}): void {
  const m = method.toUpperCase();
  if (m === "GET") return;
  if (m === "POST" && opts.allowWrite !== undefined && WRITE_ALLOWLIST.includes(opts.allowWrite) && (opts.body === undefined || opts.body === "")) return;
  throw new ConnectorError("read_only_violation", `Blocked ${m} request: connectors are read-only (§4.6)`);
}

export interface HttpClient {
  request(url: string, opts?: RequestOptions): Promise<Response>;
  get(url: string, opts?: Omit<RequestOptions, "method" | "body" | "allowWrite">): Promise<Response>;
  getJson<T = unknown>(url: string, opts?: Omit<RequestOptions, "method" | "body" | "allowWrite">): Promise<T>;
  getText(url: string, opts?: Omit<RequestOptions, "method" | "body" | "allowWrite">): Promise<string>;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const secrets = options.secrets ?? [];
  const provider = options.provider;
  const baseRetries = options.retries ?? 3;
  const baseTimeout = options.timeoutMs ?? 30_000;
  const backoffBase = options.backoffBaseMs ?? 500;
  const backoffMax = options.backoffMaxMs ?? 30_000;

  const errOpts = (status?: number, cause?: unknown) => ({
    ...(status !== undefined ? { status } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });

  async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
    const method = (opts.method ?? "GET").toUpperCase();
    assertReadOnly(method, { allowWrite: opts.allowWrite, body: opts.body });

    const u = buildUrl(url, opts.query);
    if (u.username || u.password) {
      // fetch() rejects URLs with embedded credentials; callers must move them into a header.
      throw new ConnectorError("invalid_input", "URL must not embed credentials; pass an Authorization header", errOpts());
    }
    const headers: Record<string, string> = { accept: "application/json", ...(options.headers ?? {}), ...(opts.headers ?? {}) };
    const retries = method === "GET" ? (opts.retries ?? baseRetries) : 0; // never retry the claim POST
    const timeoutMs = opts.timeoutMs ?? baseTimeout;
    const safeUrl = redactText(redactUrl(u.toString()), secrets);

    let attempt = 0;
    for (;;) {
      if (options.beforeRequest) await options.beforeRequest({ method, url: u, headers });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response | undefined;
      let failure: ConnectorError | undefined;
      try {
        const init: RequestInit = { method, headers, signal: ctrl.signal, redirect: "follow" };
        if (opts.body !== undefined && opts.body !== "") init.body = opts.body;
        res = await doFetch(u.toString(), init);
      } catch (e) {
        const aborted = ctrl.signal.aborted;
        const msg = e instanceof Error ? e.message : String(e);
        failure = new ConnectorError(
          aborted ? "timeout" : "network",
          redactText(`${method} ${safeUrl} ${aborted ? `timed out after ${timeoutMs}ms` : `failed: ${msg}`}`, secrets),
          errOpts(undefined),
        );
      } finally {
        clearTimeout(timer);
      }

      if (res && (res.ok || opts.passStatuses?.includes(res.status))) return res;

      const retryable = failure ? true : RETRY_STATUSES.has(res!.status);
      if (retryable && attempt < retries) {
        let wait = Math.min(backoffMax, backoffBase * 2 ** attempt);
        const ra = res?.headers.get("retry-after");
        if (ra) {
          const secs = Number(ra);
          if (Number.isFinite(secs) && secs >= 0) wait = Math.min(backoffMax, secs * 1000);
        }
        attempt++;
        await sleep(wait);
        continue;
      }
      if (failure) throw failure;
      const status = res!.status;
      let snippet = "";
      try {
        snippet = (await res!.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      const code = status === 429 ? "rate_limited" : status === 401 ? "auth" : "http";
      throw new ConnectorError(code, redactText(`${method} ${safeUrl} → HTTP ${status}${snippet ? `: ${snippet}` : ""}`, secrets), errOpts(status));
    }
  }

  return {
    request,
    get: (url, opts = {}) => request(url, { ...opts, method: "GET" }),
    async getJson<T>(url: string, opts: Omit<RequestOptions, "method" | "body" | "allowWrite"> = {}): Promise<T> {
      const res = await request(url, { ...opts, method: "GET" });
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        throw new ConnectorError("parse", `GET ${redactText(redactUrl(url), secrets)} returned invalid JSON`, errOpts(res.status, e));
      }
    },
    async getText(url, opts = {}) {
      const res = await request(url, { ...opts, method: "GET" });
      return res.text();
    },
  };
}
