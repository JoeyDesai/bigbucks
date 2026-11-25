"use server";
/** Settings → Imports actions: previews (no writes) and imports (audited, deduped). */
import { z } from "zod";
import { ConnectorError, DATE_FORMATS, parseFidelityPositionsCsv, parseGenericCsv, parseOfx, parseRiverCsv, previewCsv, previewRiverCsv, riverRowsToTxns, type CsvMapping } from "@homebase/connectors";
import { today } from "@homebase/shared";
import { createBoss } from "@homebase/worker";
import { log } from "@/server/log";
import { act, UserFacingError } from "../act";
import { importHoldings, importTransactions } from "../imports";

const MAX_TEXT = 900_000; // server-action bodies are capped at 1 MB
const Text = z.string().min(1, "The file is empty.").max(MAX_TEXT, "That file is over 900 KB. Split it into smaller date ranges.");
const Id = z.string().uuid();
const IMP = "/settings/imports";

function parseErr(e: unknown): never {
  if (e instanceof ConnectorError) throw new UserFacingError(e.message);
  throw e;
}

/** Best effort: ask the worker to categorize the new rows now (otherwise the nightly run does). */
async function enqueueCategorize(ids: string[]): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url || !ids.length) return false;
  const boss = createBoss(url, process.env.PGBOSS_SCHEMA ?? "pgboss");
  boss.on("error", (e) => log.warn({ err: e.message }, "pg-boss (import)"));
  try {
    await boss.start();
    await boss.send("categorize.pending", { transactionIds: ids.slice(0, 5000) });
    return true;
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "import: categorize enqueue failed");
    return false;
  } finally {
    await boss.stop({ graceful: false, wait: false }).catch(() => undefined);
  }
}

// ── CSV ─────────────────────────────────────────────────────────────────────

const Col = z.union([z.string().max(200), z.number().int().min(0).max(200)]);
const MappingSchema = z.object({
  date: Col,
  amount: Col.optional(),
  outflow: Col.optional(),
  inflow: Col.optional(),
  payee: Col.optional(),
  memo: Col.optional(),
  description: Col.optional(),
  dateFormat: z.enum([...DATE_FORMATS, "auto"]).optional(),
  invertAmount: z.boolean().optional(),
  hasHeader: z.boolean().optional(),
  skipLines: z.number().int().min(0).max(50).optional(),
});

export async function previewCsvAction(text: string, mapping?: Partial<CsvMapping>) {
  return act("import.csv_preview", {}, async () => {
    try {
      const p = previewCsv(Text.parse(text), mapping ?? {});
      return { header: p.header, sample: p.sample.slice(0, 8), suggested: p.suggested as Record<string, string | number | boolean>, detectedDateFormat: p.detectedDateFormat };
    } catch (e) {
      return parseErr(e);
    }
  });
}

export async function dryRunCsvAction(text: string, accountId: string, mapping: unknown) {
  return act("import.csv_dry_run", {}, async () => {
    try {
      const m = MappingSchema.parse(mapping) as CsvMapping;
      const r = parseGenericCsv(Text.parse(text), Id.parse(accountId), m);
      return { count: r.transactions.length, dateFormat: r.dateFormat, warnings: r.warnings.slice(0, 20), sample: r.transactions.slice(0, 6).map((t) => ({ date: t.date, description: t.description, amount: t.amount.toString() })) };
    } catch (e) {
      return parseErr(e);
    }
  });
}

export async function importCsvAction(input: { text: string; accountId: string; mapping: unknown; fileName: string; includeNear?: boolean }) {
  return act("import.csv", { revalidate: [IMP, "/activity", "/plan"] }, async ({ ctx }) => {
    let txns;
    try {
      txns = parseGenericCsv(Text.parse(input.text), Id.parse(input.accountId), MappingSchema.parse(input.mapping) as CsvMapping).transactions;
    } catch (e) {
      return parseErr(e);
    }
    const r = await importTransactions(ctx, { accountId: input.accountId, txns, source: "csv", kind: "csv", fileName: input.fileName, includeNear: !!input.includeNear });
    const queued = await enqueueCategorize(r.transactionIds);
    return { ...r, transactionIds: undefined, categorizeQueued: queued };
  });
}

// ── OFX / QFX ───────────────────────────────────────────────────────────────

export async function previewOfxAction(text: string) {
  return act("import.ofx_preview", {}, async () => {
    try {
      const r = parseOfx(Text.parse(text));
      return {
        statements: r.statements.map((s) => ({ id: s.accountExternalId, last4: s.accountLast4, type: s.isCreditCard ? "Credit card" : s.accountType, count: s.transactions.length, start: s.startDate ?? null, end: s.endDate ?? null, ledgerBalance: s.ledgerBalance?.toString() ?? null })),
        warnings: r.warnings.slice(0, 20),
      };
    } catch (e) {
      return parseErr(e);
    }
  });
}

export async function importOfxAction(input: { text: string; mapping: Record<string, string>; fileName: string; includeNear?: boolean }) {
  return act("import.ofx", { revalidate: [IMP, "/activity", "/plan"] }, async ({ ctx }) => {
    let statements;
    try {
      statements = parseOfx(Text.parse(input.text)).statements;
    } catch (e) {
      return parseErr(e);
    }
    let imported = 0,
      exact = 0,
      near = 0,
      skippedExisting = 0;
    const ids: string[] = [];
    for (const s of statements) {
      const accountId = input.mapping[s.accountExternalId];
      if (!accountId) continue;
      const r = await importTransactions(ctx, { accountId: Id.parse(accountId), txns: s.transactions, source: "csv", kind: "ofx", fileName: input.fileName, includeNear: !!input.includeNear });
      imported += r.imported;
      exact += r.exact;
      near += r.near;
      skippedExisting += r.skippedExisting;
      ids.push(...r.transactionIds);
    }
    if (!Object.values(input.mapping).some(Boolean)) throw new UserFacingError("Choose an account for at least one statement.");
    return { imported, exact, near, skippedExisting, categorizeQueued: await enqueueCategorize(ids) };
  });
}

// ── River ───────────────────────────────────────────────────────────────────

export async function previewRiverAction(text: string) {
  return act("import.river_preview", {}, async () => {
    try {
      const p = previewRiverCsv(Text.parse(text), 6);
      const parsed = p.missing.length ? null : parseRiverCsv(text, p.mapping);
      return {
        headers: p.headers,
        missing: p.missing as string[],
        sample: p.sample,
        rows: parsed?.rows.length ?? 0,
        warnings: (parsed?.warnings ?? []).slice(0, 20),
        btcNetSats: parsed ? parsed.rows.reduce((s, r) => s + r.btcDeltaSats, 0n).toString() : "0",
      };
    } catch (e) {
      return parseErr(e);
    }
  });
}

export async function importRiverAction(input: { text: string; accountId: string; fileName: string }) {
  return act("import.river", { revalidate: [IMP, "/wealth", "/investments", "/activity"] }, async ({ ctx }) => {
    let txns;
    try {
      const rows = parseRiverCsv(Text.parse(input.text)).rows;
      txns = riverRowsToTxns(rows, Id.parse(input.accountId));
    } catch (e) {
      return parseErr(e);
    }
    const r = await importTransactions(ctx, { accountId: input.accountId, txns, source: "river_csv", kind: "river", fileName: input.fileName });
    return { ...r, transactionIds: undefined };
  });
}

// ── Fidelity positions ──────────────────────────────────────────────────────

export async function previewFidelityAction(text: string) {
  return act("import.fidelity_preview", {}, async () => {
    try {
      const r = parseFidelityPositionsCsv(Text.parse(text));
      // Account numbers never leave the server: only the hashed id, the name and last 4 are sent.
      return {
        downloadedAt: r.downloadedAt ?? null,
        accounts: r.accounts.map((a) => ({ id: a.externalId, name: a.name, total: a.balance.toString(), positions: r.holdings.filter((h) => h.accountExternalId === a.externalId).length })),
        warnings: r.warnings.slice(0, 20),
      };
    } catch (e) {
      return parseErr(e);
    }
  });
}

export async function importFidelityAction(input: { text: string; mapping: Record<string, string>; fileName: string }) {
  return act("import.fidelity", { revalidate: [IMP, "/wealth", "/investments"] }, async ({ ctx }) => {
    let r;
    try {
      r = parseFidelityPositionsCsv(Text.parse(input.text));
    } catch (e) {
      return parseErr(e);
    }
    const asOf = r.downloadedAt && /^\d{4}-\d{2}-\d{2}/.test(r.downloadedAt) ? r.downloadedAt.slice(0, 10) : today();
    const mapping = Object.fromEntries(Object.entries(input.mapping).filter(([, v]) => v).map(([k, v]) => [k, Id.parse(v)]));
    return await importHoldings(ctx, { mapping, holdings: r.holdings, asOf, fileName: input.fileName });
  });
}

// ── YNAB ────────────────────────────────────────────────────────────────────

/** "Run a YNAB delta now": sync.manual {provider: ynab} for the worker (only after the first import). */
export async function runYnabDeltaAction() {
  return act("import.ynab_delta", { admin: true, revalidate: IMP }, async ({ user }) => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new UserFacingError("DATABASE_URL isn't set.");
    const boss = createBoss(url, process.env.PGBOSS_SCHEMA ?? "pgboss");
    boss.on("error", (e) => log.warn({ err: e.message }, "pg-boss (ynab delta)"));
    try {
      await boss.start();
      const jobId = await boss.send("sync.manual", { provider: "ynab", userId: user.id }, { singletonKey: "ynab" });
      return { jobId };
    } catch {
      throw new UserFacingError("Couldn't queue the delta. Is the worker running?");
    } finally {
      await boss.stop({ graceful: false, wait: false }).catch(() => undefined);
    }
  });
}
