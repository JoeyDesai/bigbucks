import { describe, expect, it } from "vitest";
import { assertGustoArgvReadOnly, buildGustoArgv, createGustoRunner, fetchGustoPayrolls, parseGustoPayrolls, type GustoExec } from "../src/gusto";
import { fixtureJson } from "./helpers";

const CO = "c0c0c0c0-0000-4000-8000-000000000000";
const PR = "11111111-1111-4111-8111-111111111111";

describe("Gusto CLI wrapper (read-only, allowlisted)", () => {
  it("builds GET argv for allowlisted paths only", () => {
    expect(buildGustoArgv(`/v1/companies/${CO}/payrolls`, { processing_statuses: "processed" })).toEqual(["api", "request", "--method", "GET", `/v1/companies/${CO}/payrolls?processing_statuses=processed`, "--json"]);
    expect(buildGustoArgv(`/v1/companies/${CO}/payrolls/${PR}`)).toHaveLength(6);
  });

  it.each([
    `/v1/companies/${CO}/payrolls/${PR}/submit`,
    `/v1/companies/${CO}/payrolls/${PR}/calculate`,
    `/v1/payrolls/${PR}`,
    `/v1/companies/${CO}/employees/../payrolls`,
    `/v1/companies/${CO}/payrolls; rm -rf /`,
    `/v1/companies/${CO}/payrolls --method POST`,
    `/v1/companies/not-a-uuid/payrolls`,
  ])("blocks %s", (path) => {
    expect(() => buildGustoArgv(path)).toThrow(expect.objectContaining({ code: "read_only_violation" }));
  });

  it("blocks unknown query params and shell-ish values", () => {
    expect(() => buildGustoArgv(`/v1/companies/${CO}/payrolls`, { method: "POST" })).toThrow(/not allowed/);
    expect(() => buildGustoArgv(`/v1/companies/${CO}/payrolls`, { start_date: "2026-01-01 && x" })).toThrow(/not allowed/);
  });

  it("final argv guard rejects anything but `api request --method GET <path> --json`", () => {
    for (const argv of [
      ["payroll", "submit", PR],
      ["api", "request", "--method", "POST", `/v1/companies/${CO}/payrolls`, "--json"],
      ["api", "request", "--method", "GET", `/v1/companies/${CO}/payrolls`, "--json", "--data", "{}"],
      ["api", "request", "--method", "GET", "/v1/anything", "--json"],
    ]) {
      expect(() => assertGustoArgvReadOnly(argv)).toThrow(expect.objectContaining({ code: "read_only_violation" }));
    }
  });

  it("runner executes via injected exec (no shell) and parses JSON", async () => {
    const seen: Array<{ bin: string; argv: readonly string[] }> = [];
    const exec: GustoExec = async (bin, argv) => {
      seen.push({ bin, argv });
      return { stdout: JSON.stringify(fixtureJson("gusto-payrolls.json")), stderr: "", code: 0 };
    };
    const runs = await fetchGustoPayrolls(createGustoRunner({ exec, bin: "/usr/local/bin/gusto" }), CO, { startDate: "2026-09-01", endDate: "2026-10-22" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.bin).toBe("/usr/local/bin/gusto");
    expect(seen[0]!.argv.slice(0, 4)).toEqual(["api", "request", "--method", "GET"]);
    expect(seen[0]!.argv[4]).toContain("processing_statuses=processed");
    expect(runs.map((r) => r.checkDate)).toEqual(["2026-09-15", "2026-09-30"]);
  });

  it("runner surfaces CLI failures as typed errors without tokens", async () => {
    const exec: GustoExec = async () => ({ stdout: "", stderr: "error: unauthorized, token=abc123secret", code: 2 });
    const err = (await createGustoRunner({ exec }).get(`/v1/companies/${CO}/payrolls`).catch((e) => e)) as Error & { code: string };
    expect(err.code).toBe("auth");
    expect(err.message).not.toContain("abc123secret");
  });
});

describe("payroll parsing", () => {
  const { runs, warnings } = parseGustoPayrolls(fixtureJson("gusto-payrolls.json"));

  it("drops unprocessed runs, sorts by check date", () => {
    expect(warnings).toEqual([]);
    expect(runs.map((r) => r.payrollUuid)).toEqual(["55555555-5555-4555-8555-555555555555", PR]);
    expect(parseGustoPayrolls(fixtureJson("gusto-payrolls.json"), { includeUnprocessed: true }).runs).toHaveLength(3);
  });

  it("gross → net breakdown in milli; 401k deferral + HSA", () => {
    const r = runs[1]!;
    expect(r).toMatchObject({ checkDate: "2026-09-30", payPeriodStart: "2026-09-16", payPeriodEnd: "2026-09-30", gross: 4_583_330n, net: 3_250_000n, employeeTaxes: 870_120n, employerTaxes: 350_280n, retirementDeferral: 366_670n, hsa: 96_540n });
    expect(r.taxes).toContainEqual({ name: "Social Security (employer)", amount: 284_170n });
    expect(r.taxes).toContainEqual({ name: "FUTA (employer)", amount: -350n });
    expect(r.companyContributions).toEqual([{ name: "401(k)", amount: 183_330n }]);
  });

  it("falls back to summing employee compensations when totals are absent", () => {
    const r = runs[0]!;
    expect(r).toMatchObject({ gross: 4_583_330n, net: 3_250_000n, employeeTaxes: 410_000n, employerTaxes: 66_460n, retirementDeferral: 366_670n, hsa: 0n });
    expect(r.otherDeductions).toEqual([]);
  });

  it("accepts {payrolls: []} envelope and reports bad rows", () => {
    const r = parseGustoPayrolls({ payrolls: [{ nope: true }] });
    expect(r.runs).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});
