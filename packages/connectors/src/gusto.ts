/**
 * Gusto (§7.8, Phase 8). Gusto has no single-company REST API for us; we shell out to the Gusto CLI.
 * §4.6: only `gusto api request` with GET on an explicit path allowlist. Everything else is blocked in code.
 *
 * argv is built as an array and executed without a shell (execFile), so nothing is interpolated.
 * [VERIFY] exact CLI flag spelling for `gusto api request` (README defers to `--help`).
 */
import { execFile } from "node:child_process";
import { z } from "zod";
import type { ISODate, Milli } from "@homebase/shared";
import { toMilliOpt } from "./normalize";
import { ConnectorError } from "./types";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** The only API paths the wrapper will ever request (GET). */
export const GUSTO_PATH_ALLOWLIST: readonly RegExp[] = Object.freeze([
  new RegExp(`^/v1/companies/${UUID}/payrolls$`),
  new RegExp(`^/v1/companies/${UUID}/payrolls/${UUID}$`),
  new RegExp(`^/v1/companies/${UUID}/pay_schedules$`),
  new RegExp(`^/v1/companies/${UUID}$`),
  new RegExp(`^/v1/companies/${UUID}/employees$`),
  /^\/v1\/me$/,
]);

const QUERY_ALLOWLIST = new Set(["processing_statuses", "include", "start_date", "end_date", "payroll_types", "page", "per", "date_filter_by", "sort_order", "include_off_cycle"]);

export type GustoArgv = readonly string[];

/** Validate and build argv for a GET request. Throws `read_only_violation` for anything off the allowlist. */
export function buildGustoArgv(path: string, query: Record<string, string | number | boolean> = {}): GustoArgv {
  if (/[\s;&|`$<>\\'"]/.test(path) || path.includes("..")) throw new ConnectorError("read_only_violation", "Gusto path contains forbidden characters", { provider: "gusto" });
  if (!GUSTO_PATH_ALLOWLIST.some((re) => re.test(path))) throw new ConnectorError("read_only_violation", `Gusto path not on the read-only allowlist: ${path}`, { provider: "gusto" });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (!QUERY_ALLOWLIST.has(k)) throw new ConnectorError("read_only_violation", `Gusto query param not allowed: ${k}`, { provider: "gusto" });
    const sv = String(v);
    if (!/^[A-Za-z0-9_,.:-]*$/.test(sv)) throw new ConnectorError("read_only_violation", `Gusto query value not allowed for ${k}`, { provider: "gusto" });
    qs.set(k, sv);
  }
  const full = qs.toString() ? `${path}?${qs.toString()}` : path;
  const argv = ["api", "request", "--method", "GET", full, "--json"] as const;
  assertGustoArgvReadOnly(argv);
  return argv;
}

/** Final guard on any argv before exec: must be exactly `api request --method GET <allowlisted path> --json`. */
export function assertGustoArgvReadOnly(argv: readonly string[]): void {
  const ok =
    argv.length === 6 &&
    argv[0] === "api" &&
    argv[1] === "request" &&
    argv[2] === "--method" &&
    argv[3] === "GET" &&
    argv[5] === "--json" &&
    typeof argv[4] === "string" &&
    GUSTO_PATH_ALLOWLIST.some((re) => re.test(argv[4]!.split("?")[0]!));
  if (!ok) throw new ConnectorError("read_only_violation", `Blocked Gusto CLI invocation: ${argv.slice(0, 4).join(" ")}`, { provider: "gusto" });
}

export type GustoExec = (bin: string, argv: readonly string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Default executor: execFile (no shell). */
export const defaultGustoExec: GustoExec = (bin, argv, opts) =>
  new Promise((resolve) => {
    execFile(bin, [...argv], { timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: false, env: opts.env ?? process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

export interface GustoRunner {
  get(path: string, query?: Record<string, string | number | boolean>): Promise<unknown>;
}

export function createGustoRunner(o: { bin?: string; exec?: GustoExec; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): GustoRunner {
  const bin = o.bin ?? "gusto";
  const exec = o.exec ?? defaultGustoExec;
  return {
    async get(path, query = {}) {
      const argv = buildGustoArgv(path, query);
      assertGustoArgvReadOnly(argv);
      const r = await exec(bin, argv, { timeoutMs: o.timeoutMs ?? 60_000, ...(o.env ? { env: o.env } : {}) });
      if (r.code !== 0) {
        const msg = r.stderr.replace(/(token|bearer)\s*[:=]?\s*\S+/gi, "$1 REDACTED").slice(0, 300);
        throw new ConnectorError(/auth|login|unauthor/i.test(r.stderr) ? "auth" : "http", `gusto CLI exited ${r.code}: ${msg}`, { provider: "gusto" });
      }
      try {
        return JSON.parse(r.stdout);
      } catch (e) {
        throw new ConnectorError("parse", "gusto CLI did not return JSON", { provider: "gusto", cause: e });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Payroll parsing

const money = z.union([z.string(), z.number()]).nullish();
const Named = z.looseObject({ name: z.string().nullish(), amount: money, employer: z.boolean().nullish(), employee_deduction: money, company_contribution: money, imputed: z.boolean().nullish() });
const EmpComp = z.looseObject({
  employee_uuid: z.string().nullish(),
  gross_pay: money,
  net_pay: money,
  check_amount: money,
  taxes: z.array(Named).nullish(),
  benefits: z.array(Named).nullish(),
  deductions: z.array(Named).nullish(),
});
const PayrollSchema = z.looseObject({
  payroll_uuid: z.string().nullish(),
  uuid: z.string().nullish(),
  check_date: z.string(),
  processed: z.boolean().nullish(),
  processed_date: z.string().nullish(),
  off_cycle: z.boolean().nullish(),
  pay_period: z.looseObject({ start_date: z.string().nullish(), end_date: z.string().nullish(), pay_schedule_uuid: z.string().nullish() }).nullish(),
  totals: z
    .looseObject({
      gross_pay: money,
      net_pay: money,
      employee_taxes: money,
      employer_taxes: money,
      benefits: money,
      employee_benefits_deductions: money,
      deferred_payroll_taxes: money,
      other_deductions: money,
      reimbursements: money,
      check_amount: money,
      company_debit: money,
    })
    .nullish(),
  employee_compensations: z.array(EmpComp).nullish(),
});

export interface PayrollLine {
  name: string;
  amount: Milli;
}

export interface PayrollRun {
  payrollUuid: string;
  checkDate: ISODate;
  payPeriodStart?: ISODate;
  payPeriodEnd?: ISODate;
  processed: boolean;
  offCycle: boolean;
  gross: Milli;
  net: Milli;
  employeeTaxes: Milli;
  employerTaxes: Milli;
  /** Employee-side benefit deductions (401k deferral, HSA, …), summed across employees. */
  employeeBenefitDeductions: PayrollLine[];
  companyContributions: PayrollLine[];
  otherDeductions: PayrollLine[];
  taxes: PayrollLine[];
  retirementDeferral: Milli;
  hsa: Milli;
  reimbursements: Milli;
  raw: unknown;
}

const mm = (v: string | number | null | undefined): Milli => toMilliOpt(v ?? undefined) ?? 0n;
function addLine(list: PayrollLine[], name: string, amount: Milli) {
  if (amount === 0n) return;
  const l = list.find((x) => x.name === name);
  if (l) l.amount += amount;
  else list.push({ name, amount });
}

/** Parse `/v1/companies/{uuid}/payrolls` JSON (array or `{payrolls: []}`) into payroll runs. Unprocessed runs are dropped. */
export function parseGustoPayrolls(json: unknown, o: { includeUnprocessed?: boolean } = {}): { runs: PayrollRun[]; warnings: string[] } {
  const list = Array.isArray(json) ? json : ((json as { payrolls?: unknown[] })?.payrolls ?? []);
  const runs: PayrollRun[] = [];
  const warnings: string[] = [];
  list.forEach((raw, i) => {
    const r = PayrollSchema.safeParse(raw);
    if (!r.success) {
      warnings.push(`payroll[${i}] skipped: ${r.error.issues[0]?.message ?? "invalid"}`);
      return;
    }
    const p = r.data;
    if (p.processed === false && !o.includeUnprocessed) return;
    const taxes: PayrollLine[] = [];
    const ben: PayrollLine[] = [];
    const co: PayrollLine[] = [];
    const other: PayrollLine[] = [];
    let empTax = 0n;
    let erTax = 0n;
    let gross = 0n;
    let net = 0n;
    for (const e of p.employee_compensations ?? []) {
      gross += mm(e.gross_pay);
      net += mm(e.net_pay ?? e.check_amount);
      for (const t of e.taxes ?? []) {
        const a = mm(t.amount);
        if (t.employer) erTax += a;
        else empTax += a;
        addLine(taxes, `${t.name ?? "Tax"}${t.employer ? " (employer)" : ""}`, a);
      }
      for (const b of e.benefits ?? []) {
        addLine(ben, b.name ?? "Benefit", mm(b.employee_deduction));
        addLine(co, b.name ?? "Benefit", mm(b.company_contribution));
      }
      for (const d of e.deductions ?? []) addLine(other, d.name ?? "Deduction", mm(d.amount));
    }
    const t = p.totals;
    const run: PayrollRun = {
      payrollUuid: p.payroll_uuid ?? p.uuid ?? `payroll-${p.check_date}-${i}`,
      checkDate: p.check_date,
      processed: p.processed ?? true,
      offCycle: p.off_cycle ?? false,
      gross: t?.gross_pay != null ? mm(t.gross_pay) : gross,
      net: t?.net_pay != null ? mm(t.net_pay) : net,
      employeeTaxes: t?.employee_taxes != null ? mm(t.employee_taxes) : empTax,
      employerTaxes: t?.employer_taxes != null ? mm(t.employer_taxes) : erTax,
      employeeBenefitDeductions: ben,
      companyContributions: co,
      otherDeductions: other,
      taxes,
      retirementDeferral: ben.filter((b) => /401|403|457|retirement|roth/i.test(b.name)).reduce((s, b) => s + b.amount, 0n),
      hsa: ben.filter((b) => /\bhsa\b|health savings/i.test(b.name)).reduce((s, b) => s + b.amount, 0n),
      reimbursements: mm(t?.reimbursements),
      raw,
    };
    if (p.pay_period?.start_date) run.payPeriodStart = p.pay_period.start_date;
    if (p.pay_period?.end_date) run.payPeriodEnd = p.pay_period.end_date;
    runs.push(run);
  });
  runs.sort((a, b) => (a.checkDate < b.checkDate ? -1 : a.checkDate > b.checkDate ? 1 : 0));
  return { runs, warnings };
}

/** Fetch processed payrolls for a company via the CLI wrapper. */
export async function fetchGustoPayrolls(runner: GustoRunner, companyUuid: string, o: { startDate?: ISODate; endDate?: ISODate } = {}): Promise<PayrollRun[]> {
  const q: Record<string, string> = { processing_statuses: "processed", include: "totals,taxes,benefits,deductions" };
  if (o.startDate) q.start_date = o.startDate;
  if (o.endDate) q.end_date = o.endDate;
  return parseGustoPayrolls(await runner.get(`/v1/companies/${companyUuid}/payrolls`, q)).runs;
}
