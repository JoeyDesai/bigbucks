import { describe, expect, it } from "vitest";
import { createMercuryConnector, mapMercuryStatus, mercuryAuthHeader } from "../src/mercury";
import { fixtureJson, json, mockFetch } from "./helpers";

const routes = () =>
  mockFetch((u) => {
    if (u.pathname === "/api/v1/accounts") return json(fixtureJson("mercury-accounts.json"));
    if (u.pathname === "/api/v1/transactions") return json(fixtureJson(u.searchParams.get("start_after") ? "mercury-transactions-p2.json" : "mercury-transactions-p1.json"));
    return undefined;
  });

describe("mercury", () => {
  const now = () => new Date("2026-10-22T15:00:00Z");

  it("auth header uses secret-token: prefix exactly once", () => {
    expect(mercuryAuthHeader("abc")).toBe("Bearer secret-token:abc");
    expect(mercuryAuthHeader("secret-token:abc")).toBe("Bearer secret-token:abc");
  });

  it("lists accounts (skips deleted, prefers nickname, strips account numbers from raw)", async () => {
    const { fetch, calls } = routes();
    const accts = await createMercuryConnector({ http: { fetch }, now }).listAccounts({ token: "tok123" });
    expect(calls[0]!.headers.authorization).toBe("Bearer secret-token:tok123");
    expect(accts).toHaveLength(2);
    expect(accts[0]).toMatchObject({ externalId: "6f1c0000-0000-4000-8000-000000000001", name: "Northwind Ops", kindGuess: "checking", balance: 18_310_750n, availableBalance: 18_234_500n, asOf: "2026-10-22T15:00:00.000Z", institution: "Mercury" });
    expect(accts[1]).toMatchObject({ name: "Mercury Savings ••2222", kindGuess: "savings", balance: 50_000_000n });
    expect(JSON.stringify(accts[0]!.raw)).not.toContain("000000001111");
  });

  it("paginates transactions via page.nextPage → start_after and maps statuses", async () => {
    const { fetch, calls } = routes();
    const txns = await createMercuryConnector({ http: { fetch } }).fetchTransactions({ token: "t" }, { since: "2026-10-01", until: "2026-10-22" });
    expect(calls).toHaveLength(2);
    const q1 = new URL(calls[0]!.url).searchParams;
    expect(q1.get("start")).toBe("2026-10-01");
    expect(q1.get("end")).toBe("2026-10-22");
    expect(q1.get("limit")).toBe("1000");
    expect(new URL(calls[1]!.url).searchParams.get("start_after")).toBe("a0000000-0000-4000-8000-000000000003");
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    expect(txns.map((t) => t.externalId.slice(-1))).toEqual(["1", "2", "4", "5"]); // failed + cancelled skipped
    const [wire, payroll, pending, interest] = txns;
    expect(wire).toMatchObject({ amount: 12_500_000n, description: "WIRE FROM ACME CLIENT INC", payee: "ACME CLIENT INC", memo: "INV-1042", pending: false, date: "2026-10-01", postedAt: "2026-10-01T18:00:00.000Z" });
    // createdAt 03:30Z on the 15th is the evening of the 14th in New York
    expect(payroll).toMatchObject({ amount: -3_250_000n, date: "2026-10-14", payee: "Payroll to Contoso", description: "Alex Rivera", memo: "Owner payroll" });
    expect(pending).toMatchObject({ pending: true, postedAt: null, mcc: "4816", amount: -120_450n });
    expect(interest).toMatchObject({ accountExternalId: "6f1c0000-0000-4000-8000-000000000002", amount: 41_070n });
  });

  it("passes accountId filters and status map", async () => {
    const { fetch, calls } = routes();
    await createMercuryConnector({ http: { fetch } }).fetchTransactions({ token: "t" }, { since: "2026-10-01", until: "2026-10-22", accountIds: ["A", "B"] });
    expect(new URL(calls[0]!.url).searchParams.getAll("accountId")).toEqual(["A", "B"]);
    expect(mapMercuryStatus("blocked")).toBeNull();
    expect(mapMercuryStatus("reversed")).toBeNull();
    expect(mapMercuryStatus("sent")).toEqual({ pending: false });
  });

  it("test() reports failures without leaking the token", async () => {
    const { fetch } = mockFetch(() => new Response("bad token tok-SECRET-1", { status: 401 }));
    const r = await createMercuryConnector({ http: { fetch } }).test({ token: "tok-SECRET-1" });
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("tok-SECRET-1");
  });

  it("backs off on 429", async () => {
    let n = 0;
    const { fetch } = mockFetch(() => (++n === 1 ? new Response("", { status: 429 }) : json(fixtureJson("mercury-accounts.json"))));
    const accts = await createMercuryConnector({ http: { fetch, sleep: async () => {} } }).listAccounts({ token: "t" });
    expect(accts).toHaveLength(2);
  });
});
