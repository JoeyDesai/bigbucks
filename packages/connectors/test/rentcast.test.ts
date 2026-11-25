import { describe, expect, it } from "vitest";
import { checkRentcastBudget, createRentcastConnector, getRentcastValue } from "../src/rentcast";
import { fixtureJson, json, mockFetch } from "./helpers";

describe("RentCast AVM", () => {
  it("GETs /avm/value with X-Api-Key and maps price range + comps", async () => {
    const { fetch, calls } = mockFetch(() => json(fixtureJson("rentcast-avm.json")));
    const v = await getRentcastValue("rc-key-123456", { address: "100 Example Ave, Fairview, VA 00000", compCount: 5, bedrooms: 3 }, { fetch });
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe("https://api.rentcast.io/v1/avm/value");
    expect(u.searchParams.get("address")).toBe("100 Example Ave, Fairview, VA 00000");
    expect(u.searchParams.get("compCount")).toBe("5");
    expect(u.searchParams.has("bathrooms")).toBe(false);
    expect(calls[0]!.headers["x-api-key"]).toBe("rc-key-123456");
    expect(calls[0]!.method).toBe("GET");
    expect(v).toMatchObject({ price: 412_000_000n, priceRangeLow: 375_000_000n, priceRangeHigh: 449_000_000n });
    expect(v.comparables).toHaveLength(2);
    expect(v.comparables[1]).toMatchObject({ price: 439_500_000n, distanceMiles: 0.41, correlation: 0.9512, bathrooms: 2.5, address: "22 Sample St, Fairview, VA 00000" });
    expect(v.subjectProperty?.squareFootage).toBe(1850);
  });

  it("connector adapter exposes the home as a property account; test() spends no calls", async () => {
    const { fetch, calls } = mockFetch(() => json(fixtureJson("rentcast-avm.json")));
    const c = createRentcastConnector({ http: { fetch }, now: () => new Date("2026-11-02T14:00:00Z") });
    const creds = { apiKey: "rc-key-123456", property: { address: "100 Example Ave" }, accountId: "home-1" };
    expect((await c.test(creds)).ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(await c.listAccounts(creds)).toEqual([expect.objectContaining({ externalId: "home-1", kindGuess: "property", balance: 412_000_000n, name: "100 Example Ave, Fairview, VA 00000" })]);
    expect(await c.fetchTransactions(creds, { since: "2026-01-01", until: "2026-12-31" })).toEqual([]);
  });

  it("monthly cap of 5 (pure)", () => {
    expect(checkRentcastBudget(0)).toEqual({ allowed: true, remaining: 5 });
    expect(checkRentcastBudget(4)).toEqual({ allowed: true, remaining: 1 });
    expect(checkRentcastBudget(5)).toEqual({ allowed: false, remaining: 0 });
  });

  it("errors redact the API key", async () => {
    const { fetch } = mockFetch(() => new Response("invalid key rc-key-123456", { status: 401 }));
    const err = (await getRentcastValue("rc-key-123456", { address: "x" }, { fetch }).catch((e) => e)) as Error;
    expect(err.message).not.toContain("rc-key-123456");
  });
});
