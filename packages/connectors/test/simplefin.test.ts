import { describe, expect, it } from "vitest";
import {
  buildAccountsUrl,
  checkSimplefinBudget,
  claimSetupToken,
  connectionsNeedingAttention,
  createSimplefinConnector,
  dateWindows,
  decodeSetupToken,
  fetchAccountSet,
  guessSimplefinKind,
  mapAccountSet,
  mapErrlist,
  normalizeCostBasis,
  normalizeLiabilityBalance,
  parseAccessUrl,
  parseAccountSet,
  parseSimplefinHoldings,
  SimplefinAccountSchema,
} from "../src/simplefin";
import { localMidnightEpoch } from "../src/normalize";
import { fixtureJson, json, mockFetch, noSleep } from "./helpers";

const ACCESS = "https://u5er:s3cretPass@bridge.example/simplefin";
const fixture = fixtureJson("simplefin-v2.json");

describe("claim", () => {
  const token = Buffer.from("https://bridge.example/simplefin/claim/demo-token").toString("base64");

  it("decodes the setup token to the claim URL", () => {
    expect(decodeSetupToken(token)).toBe("https://bridge.example/simplefin/claim/demo-token");
    expect(() => decodeSetupToken(Buffer.from("http://insecure/claim").toString("base64"))).toThrow(/https/);
    expect(() => decodeSetupToken("!!!not base64")).toThrow();
  });

  it("POSTs with no body and returns the access URL", async () => {
    const { fetch, calls } = mockFetch(() => new Response(`${ACCESS}\n`));
    expect(await claimSetupToken(token, { fetch })).toBe(ACCESS);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://bridge.example/simplefin/claim/demo-token" });
    expect(calls[0]!.body).toBeUndefined();
  });

  it("403 → already claimed, with a clear message and no retry", async () => {
    const { fetch, calls } = mockFetch(() => new Response("Forbidden", { status: 403 }));
    await expect(claimSetupToken(token, { fetch, sleep: noSleep })).rejects.toMatchObject({ code: "already_claimed", status: 403, message: expect.stringMatching(/already claimed/) });
    expect(calls).toHaveLength(1);
  });

  it("never retries the claim even on 5xx", async () => {
    const { fetch, calls } = mockFetch(() => new Response("oops", { status: 503 }));
    await expect(claimSetupToken(token, { fetch, sleep: noSleep })).rejects.toMatchObject({ code: "http" });
    expect(calls).toHaveLength(1);
  });
});

describe("access URL + request building", () => {
  it("splits credentials out of the access URL", () => {
    expect(parseAccessUrl(ACCESS)).toEqual({ baseUrl: "https://bridge.example/simplefin", username: "u5er", password: "s3cretPass" });
    expect(() => parseAccessUrl("https://bridge.example/simplefin")).toThrow(/credentials/);
  });

  it("builds version=2 URLs; omits pending entirely when off", () => {
    const on = new URL(buildAccountsUrl("https://b.example/simplefin", { startDate: 100, endDate: 200, pending: true, accountIds: ["A1", "A2"] }));
    expect(on.pathname).toBe("/simplefin/accounts");
    expect(on.searchParams.get("version")).toBe("2");
    expect(on.searchParams.get("start-date")).toBe("100");
    expect(on.searchParams.get("end-date")).toBe("200");
    expect(on.searchParams.get("pending")).toBe("1");
    expect(on.searchParams.getAll("account")).toEqual(["A1", "A2"]);
    const off = new URL(buildAccountsUrl("https://b.example/simplefin", { pending: false, balancesOnly: true }));
    expect(off.searchParams.has("pending")).toBe(false);
    expect(off.toString()).not.toMatch(/pending/);
    expect(off.searchParams.get("balances-only")).toBe("1");
  });

  it("sends basic auth in a header (never in the URL) and maps 402/403", async () => {
    const { fetch, calls } = mockFetch(() => json(fixture));
    await fetchAccountSet(ACCESS, { balancesOnly: true }, { fetch });
    expect(calls[0]!.url).not.toContain("s3cretPass");
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from("u5er:s3cretPass").toString("base64")}`);

    const f402 = mockFetch(() => new Response("pay", { status: 402 }));
    await expect(fetchAccountSet(ACCESS, {}, { fetch: f402.fetch })).rejects.toMatchObject({ code: "subscription_lapsed", status: 402 });
    const f403 = mockFetch(() => new Response("no", { status: 403 }));
    await expect(fetchAccountSet(ACCESS, {}, { fetch: f403.fetch })).rejects.toMatchObject({ code: "revoked", status: 403 });
  });

  it("errors never leak the access URL password", async () => {
    const { fetch } = mockFetch(() => new Response("boom s3cretPass", { status: 500 }));
    const err = await fetchAccountSet(ACCESS, {}, { fetch, sleep: noSleep, retries: 1 }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("s3cretPass");
    expect(String((err as Error).message)).toContain("REDACTED");
  });
});

describe("windows + budget", () => {
  it("splits into ≤45-day windows at local midnight boundaries by default", () => {
    const w = dateWindows("2026-07-01", "2026-10-22");
    expect(w.map((x) => [x.from, x.to])).toEqual([
      ["2026-07-01", "2026-08-14"],
      ["2026-08-15", "2026-09-28"],
      ["2026-09-29", "2026-10-22"],
    ]);
    expect(w[0]!.start).toBe(localMidnightEpoch("2026-07-01"));
    expect(w[0]!.end).toBe(w[1]!.start);
    expect(new Date(w[0]!.start * 1000).toISOString()).toBe("2026-07-01T04:00:00.000Z"); // EDT
    expect(dateWindows("2026-01-01", "2026-03-31", 90)).toHaveLength(1);
    expect(() => dateWindows("2026-01-01", "2026-03-31", 91)).toThrow();
    expect(dateWindows("2026-02-01", "2026-01-01")).toEqual([]);
  });

  it("handles a DST boundary inside a window", () => {
    const [w] = dateWindows("2026-11-01", "2026-11-01", 1);
    expect(w!.end - w!.start).toBe(25 * 3600); // fall back: 25-hour day
  });

  it("budget: ≤6/day, manual ≤2/day, pure", () => {
    expect(checkSimplefinBudget({ usedToday: 0, manualToday: 0 }, "scheduled")).toEqual({ allowed: true, remaining: 5 });
    expect(checkSimplefinBudget({ usedToday: 5, manualToday: 0 }, "scheduled").allowed).toBe(true);
    expect(checkSimplefinBudget({ usedToday: 6, manualToday: 0 }, "scheduled")).toMatchObject({ allowed: false, remaining: 0 });
    expect(checkSimplefinBudget({ usedToday: 3, manualToday: 2 }, "manual")).toMatchObject({ allowed: false, reason: expect.stringMatching(/Manual/) });
    expect(checkSimplefinBudget({ usedToday: 3, manualToday: 1 }, "manual").allowed).toBe(true);
    expect(checkSimplefinBudget({ usedToday: 4, manualToday: 0 }, "scheduled", 3).allowed).toBe(false); // a 3-window backfill
  });
});

describe("mapping the recorded v2 response", () => {
  const set = parseAccountSet(fixture);
  const mapped = mapAccountSet(set);

  it("parses accounts, connections, errlist", () => {
    expect(set.accounts).toHaveLength(4);
    expect(set.connections.map((c) => c.conn_id)).toEqual(["CON-co000000001", "CON-wg000000002", "CON-fk000000003"]);
    expect(set.errlist[0]!.code).toBe("gen.api");
  });

  it("maps accounts with kind guesses, institutions and milli balances", () => {
    const byId = Object.fromEntries(mapped.accounts.map((a) => [a.externalId, a]));
    expect(byId["ACT-checking-0001"]).toMatchObject({ kindGuess: "checking", balance: 4_210_550n, availableBalance: 4_185_550n, institution: "Contoso Bank", connectionId: "CON-co000000001", asOf: "2026-10-22T04:00:00.000Z" });
    expect(byId["ACT-card-0002"]).toMatchObject({ kindGuess: "credit_card", balance: -1_384_220n });
    expect(byId["ACT-savings-0003"]).toMatchObject({ kindGuess: "savings", balance: 18_250_000n, institution: "Woodgrove Bank" });
    expect(byId["ACT-fabrikam-0004"]).toMatchObject({ kindGuess: "credit_card", balance: -733_410n, institution: "Fabrikam" });
  });

  it("maps transactions: local date from transacted_at, pending, payee/mcc, signs", () => {
    expect(mapped.transactions).toHaveLength(17);
    const t = Object.fromEntries(mapped.transactions.map((x) => [x.externalId, x]));
    // transacted_at 2026-10-17T00:00Z is 2026-10-16 20:00 in New York
    expect(t["TRN-c-001"]).toMatchObject({ date: "2026-10-16", postedAt: "2026-10-17T04:00:00.000Z", amount: 3_250_000n, payee: "Northwind Studio", pending: false });
    expect(t["TRN-c-001"]!.memo).toBeUndefined();
    expect(t["TRN-c-001"]!.mcc).toBeUndefined();
    expect(t["TRN-c-005"]).toMatchObject({ pending: true, postedAt: null, date: "2026-10-21", amount: -89_990n });
    expect(t["TRN-v-001"]).toMatchObject({ mcc: "5300", amount: -142_670n, accountExternalId: "ACT-card-0002" });
    expect(t["TRN-v-004"]!.amount).toBe(612_400n);
    expect(t["TRN-s-001"]!.date).toBe("2026-10-19");
    expect(mapped.transactions.filter((x) => x.pending).map((x) => x.externalId).sort()).toEqual(["TRN-c-005", "TRN-d-004", "TRN-v-006"]);
  });

  it("surfaces gen.api warning as info", () => {
    expect(mapped.issues).toEqual([{ code: "gen.api", msg: expect.stringMatching(/45 days/), status: "info" }]);
    expect(mapped.holdings).toEqual([]);
  });
});

describe("errlist → connection status", () => {
  const conns = [{ conn_id: "CON-co", name: "Contoso Bank", org_name: "Contoso Bank" }];
  it("con.auth → needs_attention with a reconnect banner", () => {
    const issues = mapErrlist([{ code: "con.auth", msg: "Login failed", conn_id: "CON-co" }], conns);
    expect(issues[0]).toMatchObject({ status: "needs_attention", banner: "Reconnect Contoso Bank in SimpleFIN", connId: "CON-co" });
    expect(connectionsNeedingAttention(issues)).toEqual(["CON-co"]);
  });
  it("act.* → retry_later; unknown sub-codes fall back to prefix", () => {
    const issues = mapErrlist([
      { code: "act.failed", msg: "x", account_id: "A" },
      { code: "con.weird", msg: "y", conn_id: "CON-co" },
      { code: "gen.newthing", msg: "z" },
    ]);
    expect(issues.map((i) => i.status)).toEqual(["retry_later", "retry_later", "info"]);
  });
});

describe("v1 fallback", () => {
  it("accepts `errors` strings and per-account `org`", () => {
    const v1 = {
      errors: ["Connection to Old Bank may need attention"],
      accounts: [{ id: "A1", name: "Old Bank Checking", currency: "USD", balance: "10.00", "balance-date": 1792641600, org: { domain: "oldbank.example", name: "Old Bank", "sfin-url": "https://x" }, transactions: [{ id: "T1", posted: 1792641600, amount: "-1.00", description: "Fee" }] }],
    };
    const set = parseAccountSet(v1);
    expect(set.errlist).toEqual([{ code: "gen.legacy", msg: "Connection to Old Bank may need attention" }]);
    expect(set.connections[0]).toMatchObject({ name: "Old Bank" });
    const m = mapAccountSet(set);
    expect(m.accounts[0]).toMatchObject({ institution: "Old Bank", connectionId: set.connections[0]!.conn_id });
    expect(m.transactions[0]).toMatchObject({ amount: -1000n, date: "2026-10-22" });
  });

  it("skips malformed accounts instead of failing the whole sync", () => {
    const set = parseAccountSet({ errlist: [], connections: [], accounts: [{ id: "bad" }, ...((fixture as { accounts: unknown[] }).accounts.slice(0, 1))] });
    expect(set.accounts).toHaveLength(1);
    expect(set.invalidAccounts).toHaveLength(1);
    expect(mapAccountSet(set).warnings[0]).toMatch(/failed validation/);
  });
});

describe("liability sign normalization", () => {
  it("auto: positive card balance (protocol convention) → negative; already-negative kept", () => {
    expect(normalizeLiabilityBalance(1_384_220n, "credit_card")).toBe(-1_384_220n);
    expect(normalizeLiabilityBalance(-1_384_220n, "credit_card")).toBe(-1_384_220n);
    expect(normalizeLiabilityBalance(281_000_000n, "mortgage")).toBe(-281_000_000n);
    expect(normalizeLiabilityBalance(5_000n, "checking")).toBe(5_000n);
  });
  it("per-account override", () => {
    expect(normalizeLiabilityBalance(25_000n, "credit_card", "negative_is_debt")).toBe(25_000n); // overpaid card
    expect(normalizeLiabilityBalance(-25_000n, "credit_card", "positive_is_debt")).toBe(25_000n);
    const m = mapAccountSet(parseAccountSet(fixture), { balanceSigns: { "ACT-card-0002": "positive_is_debt" } });
    expect(m.accounts.find((a) => a.externalId === "ACT-card-0002")!.balance).toBe(1_384_220n);
  });
  it("kind guesses", () => {
    expect(guessSimplefinKind("Fidelity 401(k)", "Fidelity")).toBe("retirement");
    expect(guessSimplefinKind("Individual - TOD", "Fidelity Investments")).toBe("brokerage");
    expect(guessSimplefinKind("Home Mortgage ...1234")).toBe("mortgage");
    expect(guessSimplefinKind("Card (0004)", "Fabrikam")).toBe("credit_card");
    expect(guessSimplefinKind("Blue Cash Everyday", "American Express")).toBe("credit_card");
    expect(guessSimplefinKind("High Yield Savings", "American Express")).toBe("savings");
  });
});

describe("holdings", () => {
  const baseAcct = SimplefinAccountSchema.parse({ id: "ACT-401k", name: "ACME 401(K)", currency: "USD", balance: "25000.00", "balance-date": 1792641600 });

  it("one row per lot; Fidelity cost_basis is already a total", () => {
    const acct = {
      ...baseAcct,
      holdings: [
        { id: "H1", symbol: "FXAIX", description: "Fidelity 500 (deferral)", shares: "40.5", market_value: "8680.37", cost_basis: "7000.00", currency: "USD" },
        { id: "H2", symbol: "FXAIX", description: "Fidelity 500 (match)", shares: "10.25", market_value: "2196.88", cost_basis: "1800.00", currency: "USD" },
      ],
    };
    const { holdings, warnings } = parseSimplefinHoldings(acct, "Fidelity Investments");
    expect(warnings).toEqual([]);
    expect(holdings).toHaveLength(2);
    expect(holdings[0]).toMatchObject({ symbol: "FXAIX", shares: "40.5", marketValue: 8_680_370n, costBasis: 7_000_000n, externalId: "H1", accountExternalId: "ACT-401k" });
    expect(holdings[1]!.costBasis).toBe(1_800_000n);
  });

  it("a 0 cost basis on a position worth something is unknown, not free", () => {
    const acct = { ...baseAcct, holdings: [{ id: "H1", symbol: "FBTC", shares: "60", market_value: "5717.40", cost_basis: "0", currency: "USD" }] };
    const { holdings } = parseSimplefinHoldings(acct, "Fidelity Investments");
    expect(holdings[0]!.costBasis).toBeUndefined();
    const empty = { ...baseAcct, holdings: [{ id: "H2", symbol: "SPAXX", shares: "0", market_value: "0", cost_basis: "0", currency: "USD" }] };
    expect(parseSimplefinHoldings(empty, "Fidelity Investments").holdings[0]!.costBasis).toBe(0n);
  });

  it("other institutions: per-share cost basis × shares; heuristic catches totals", () => {
    expect(normalizeCostBasis({ costBasis: 150_000n, shares: "10", marketValue: 1_800_000n, institution: "Ally Invest" })).toEqual({ total: 1_500_000n, method: "per_share" });
    expect(normalizeCostBasis({ costBasis: 1_500_000n, shares: "10", marketValue: 1_800_000n, institution: "Some Broker" })).toEqual({ total: 1_500_000n, method: "heuristic_total" });
    expect(normalizeCostBasis({ costBasis: 1_500_000n, shares: "10", institution: "Charles Schwab" }).method).toBe("institution_total");
  });

  it("degrades gracefully on garbage", () => {
    const acct = { ...baseAcct, holdings: [{ symbol: "OK", shares: "1", market_value: "10" }, { shares: "x" }, "nonsense", { symbol: "BAD", shares: "1", market_value: "ten dollars" }] };
    const { holdings, warnings } = parseSimplefinHoldings(acct as typeof baseAcct);
    expect(holdings.map((h) => h.symbol)).toEqual(["OK"]);
    expect(warnings).toHaveLength(3);
    const notArray = parseSimplefinHoldings({ ...baseAcct, holdings: null });
    expect(notArray.holdings).toEqual([]);
  });

  it("purchase_price fallback", () => {
    const { holdings } = parseSimplefinHoldings({ ...baseAcct, holdings: [{ symbol: "VTI", shares: "2", market_value: "600", purchase_price: "250.505" }] });
    expect(holdings[0]!.costBasis).toBe(501_010n);
  });
});

describe("connector", () => {
  it("fetchTransactions splits windows, passes pending=1, dedupes across windows", async () => {
    const { fetch, calls } = mockFetch(() => json(fixture));
    const c = createSimplefinConnector({ http: { fetch } });
    const txns = await c.fetchTransactions({ accessUrl: ACCESS }, { since: "2026-07-01", until: "2026-10-22", accountIds: ["ACT-card-0002"] });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const u = new URL(call.url);
      expect(u.searchParams.get("pending")).toBe("1");
      expect(u.searchParams.getAll("account")).toEqual(["ACT-card-0002"]);
      expect(call.method).toBe("GET");
    }
    expect(txns).toHaveLength(17); // same fixture returned 3× → deduped
  });

  it("pending: false omits the parameter", async () => {
    const { fetch, calls } = mockFetch(() => json(fixture));
    await createSimplefinConnector({ http: { fetch }, pending: false }).fetchTransactions({ accessUrl: ACCESS }, { since: "2026-10-08", until: "2026-10-22" });
    expect(new URL(calls[0]!.url).searchParams.has("pending")).toBe(false);
  });

  it("test() reports institutions and needs_attention banners; listAccounts uses balances-only", async () => {
    const withAuth = { ...(fixture as object), errlist: [{ code: "con.auth", msg: "Reauth", conn_id: "CON-co000000001" }] };
    const { fetch, calls } = mockFetch(() => json(withAuth));
    const issues: string[] = [];
    const c = createSimplefinConnector({ http: { fetch }, onIssues: (i) => issues.push(...i.map((x) => x.status)) });
    const r = await c.test({ accessUrl: ACCESS });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Reconnect Contoso Bank in SimpleFIN/);
    const accts = await c.listAccounts({ accessUrl: ACCESS });
    expect(accts).toHaveLength(4);
    expect(new URL(calls[1]!.url).searchParams.get("balances-only")).toBe("1");
    expect(issues).toEqual(["needs_attention"]);
  });

  it("test() returns ok:false on revoked access", async () => {
    const { fetch } = mockFetch(() => new Response("", { status: 403 }));
    const r = await createSimplefinConnector({ http: { fetch } }).test({ accessUrl: ACCESS });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/revoked/) });
  });
});
