/**
 * §8.2 ingest for one provider fetch: accounts → balances → holdings → transactions → transfer
 * detection, in a single DB transaction. After commit the caller runs `afterIngest` (enqueue
 * categorize.pending, recompute the budget from the earliest touched month).
 */
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { accounts, categories, entities, holdings, transactions, type Connection, type Tx } from "@homebase/db";
import type { ExternalAccount, ExternalHolding, ExternalTxn } from "@homebase/connectors";
import { addDays, monthOf, toLocalDate, type AccountSource, type ISODate } from "@homebase/shared";
import type { WorkerContext } from "../context";
import type { DetectedTransfer, TransferAccountInput, TransferDetector } from "../hooks";
import { errInfo } from "../log";
import { BUSINESS_ENTITY, HOUSEHOLD_ENTITY, upsertBalance, upsertExternalAccount } from "./accounts";
import { emptyCounts, ingestAccountTransactions, type TxnIngestCounts } from "./transactions";

export { HOUSEHOLD_ENTITY, BUSINESS_ENTITY } from "./accounts";

export interface IngestInput {
  connection: Connection;
  source: AccountSource;
  /** Entity for newly created accounts (Mercury → the business, everything else → Household). */
  entity: string;
  accounts: ExternalAccount[];
  transactions: ExternalTxn[];
  holdings?: ExternalHolding[] | undefined;
  /** Date range the fetch fully covered (enables removal of vanished pending rows). */
  window?: { since: ISODate; until: ISODate } | undefined;
  /** Provider accounts that reported errors this run; their pending rows are left alone. */
  failedAccountExternalIds?: ReadonlySet<string> | undefined;
}

export interface IngestResult extends TxnIngestCounts {
  accountsSeen: number;
  accountsCreated: string[];
  inboxAccounts: string[];
  balancesUpserted: number;
  holdingsWritten: number;
  transfersPaired: number;
  transferSuggestions: DetectedTransfer[];
  /** New or bank-changed transactions (categorize.pending). */
  touchedIds: string[];
  earliestTouched: ISODate | null;
}

export async function ingestBatch(ctx: Pick<WorkerContext, "db" | "now" | "detectTransfers" | "log">, input: IngestInput): Promise<IngestResult> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const out: IngestResult = { ...emptyCounts(), accountsSeen: 0, accountsCreated: [], inboxAccounts: [], balancesUpserted: 0, holdingsWritten: 0, transfersPaired: 0, transferSuggestions: [], touchedIds: [], earliestTouched: null };
    const byExt = new Map<string, { id: string; balanceSign: "normal" | "inverted" }>();

    for (const ext of input.accounts) {
      const r = await upsertExternalAccount(tx, input.connection, ext, { source: input.source, defaultEntity: input.entity, now });
      out.accountsSeen++;
      if (r.created) out.accountsCreated.push(r.account.id);
      if (r.inbox) out.inboxAccounts.push(r.account.id);
      byExt.set(ext.externalId, { id: r.account.id, balanceSign: r.account.balanceSign });
      await upsertBalance(tx, r.account, ext, input.source);
      out.balancesUpserted++;
    }

    // Holdings: one snapshot per account per day (replace that day's lots).
    const holdingsByAcct = new Map<string, ExternalHolding[]>();
    for (const h of input.holdings ?? []) {
      const l = holdingsByAcct.get(h.accountExternalId) ?? [];
      l.push(h);
      holdingsByAcct.set(h.accountExternalId, l);
    }
    for (const [extId, hs] of holdingsByAcct) {
      const acct = byExt.get(extId);
      if (!acct) continue;
      out.holdingsWritten += await writeHoldings(tx, acct.id, hs);
    }

    // Transactions per account.
    const txByAcct = new Map<string, ExternalTxn[]>();
    for (const t of input.transactions) {
      const l = txByAcct.get(t.accountExternalId) ?? [];
      l.push(t);
      txByAcct.set(t.accountExternalId, l);
    }
    for (const [extId, acct] of byExt) {
      const list = txByAcct.get(extId) ?? [];
      const window = input.failedAccountExternalIds?.has(extId) ? undefined : input.window;
      const r = await ingestAccountTransactions(tx, acct, list, { source: input.source, now, window });
      for (const k of Object.keys(emptyCounts()) as (keyof TxnIngestCounts)[]) out[k] += r[k];
      out.touchedIds.push(...r.touchedIds);
      if (r.earliest && (!out.earliestTouched || r.earliest < out.earliestTouched)) out.earliestTouched = r.earliest;
    }
    for (const extId of txByAcct.keys()) if (!byExt.has(extId)) ctx.log.warn({ provider: input.connection.provider }, "transactions for an account the provider did not list were skipped");

    // §8.3 transfer detection over recent unpaired rows (both sides may come from different providers).
    if (out.touchedIds.length) {
      const pairing = await detectAndApplyTransfers(tx, ctx.detectTransfers, out.touchedIds, now, ctx.log);
      out.transfersPaired = pairing.paired;
      out.transferSuggestions = pairing.suggestions;
    }
    return out;
  });
}

async function writeHoldings(tx: Tx, accountId: string, hs: ExternalHolding[]): Promise<number> {
  const asOf = toLocalDate(hs[0]!.asOf);
  await tx.delete(holdings).where(and(eq(holdings.accountId, accountId), eq(holdings.asOf, asOf)));
  const seen = new Set<string>();
  let n = 0;
  for (const h of hs) {
    const lotKey = h.externalId ?? null;
    const key = `${h.symbol}|${lotKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await tx.insert(holdings).values({
      accountId,
      asOf,
      symbol: h.symbol,
      name: h.description ?? null,
      quantity: h.shares,
      price: null,
      marketValueMilli: h.marketValue ?? 0n,
      costBasisMilli: h.costBasis ?? null,
      lotKey,
    });
    n++;
  }
  return n;
}

/** Window (days) of unpaired rows considered around newly ingested ones (§8.3: dates within 5 days). */
const TRANSFER_LOOKBACK_DAYS = 5;

export async function detectAndApplyTransfers(tx: Tx, detect: TransferDetector, touchedIds: string[], now: Date, log: WorkerContext["log"]): Promise<{ paired: number; suggestions: DetectedTransfer[] }> {
  const touched = await tx.select({ date: transactions.date }).from(transactions).where(inArray(transactions.id, touchedIds));
  if (!touched.length) return { paired: 0, suggestions: [] };
  const since = addDays(touched.map((t) => t.date).reduce((a, b) => (a < b ? a : b)), -TRANSFER_LOOKBACK_DAYS);

  const rows = await tx
    .select({ id: transactions.id, accountId: transactions.accountId, date: transactions.date, amount: transactions.amountMilli, raw: transactions.rawDescription, cleared: transactions.cleared })
    .from(transactions)
    .where(and(isNull(transactions.deletedAt), isNull(transactions.transferPairId), isNull(transactions.transferAccountId), isNull(transactions.categoryId), eq(transactions.isSplit, false), gte(transactions.date, since)));
  const candidates = rows.filter((r) => r.cleared !== "pending").map((r) => ({ id: r.id, accountId: r.accountId, date: r.date, amountMilli: r.amount, rawDescription: r.raw ?? "" }));
  if (candidates.length < 2) return { paired: 0, suggestions: [] };

  const acctRows = await tx
    .select({ id: accounts.id, name: accounts.name, nickname: accounts.nickname, institution: accounts.institution, kind: accounts.kind, onBudget: accounts.onBudget, entity: entities.name })
    .from(accounts)
    .innerJoin(entities, eq(entities.id, accounts.entityId))
    .where(isNull(accounts.deletedAt));
  const acctMap = new Map<string, TransferAccountInput>(acctRows.map((a) => [a.id, { ...a, isBusiness: a.entity !== HOUSEHOLD_ENTITY }]));
  const rta = await tx.select({ id: categories.id }).from(categories).where(eq(categories.kind, "internal_rta"));

  let detected: { auto: DetectedTransfer[]; suggestions: DetectedTransfer[] };
  try {
    detected = await detect(candidates, acctMap, { rtaCategoryId: rta[0]?.id ?? null });
  } catch (e) {
    log.error({ err: errInfo(e) }, "transfer detection failed; continuing without pairing");
    return { paired: 0, suggestions: [] };
  }
  let paired = 0;
  for (const m of detected.auto) {
    const out = acctMap.get(m.outflowAccountId);
    const inn = acctMap.get(m.inflowAccountId);
    if (!out || !inn) continue;
    const catz = { method: "transfer" as const, confidence: m.confidence, explanation: m.reason, at: now.toISOString() };
    // No category between two on-budget accounts. A business draw into a household account is income
    // (Ready to Assign, §7.2); any other budget↔tracking side is left for the categorizer.
    const inCat = inn.onBudget && !out.onBudget ? m.householdCategoryId : null;
    await tx.update(transactions).set({ transferAccountId: inn.id, transferPairId: m.inflowId, catz, updatedAt: now }).where(eq(transactions.id, m.outflowId));
    await tx.update(transactions).set({ transferAccountId: out.id, transferPairId: m.outflowId, categoryId: inCat, catz, updatedAt: now }).where(eq(transactions.id, m.inflowId));
    paired++;
  }
  return { paired, suggestions: detected.suggestions };
}

/** After a committed ingest: categorize new rows and refresh the budget cache (§8.2 step 4, §6). */
export async function afterIngest(ctx: Pick<WorkerContext, "db" | "enqueue" | "recompute" | "log">, r: Pick<IngestResult, "touchedIds" | "earliestTouched">): Promise<void> {
  if (r.touchedIds.length) await ctx.enqueue("categorize.pending", { transactionIds: r.touchedIds.slice(0, 5000) });
  if (r.earliestTouched) {
    try {
      await ctx.recompute(ctx.db, { fromMonth: monthOf(r.earliestTouched) });
    } catch (e) {
      ctx.log.error({ err: errInfo(e) }, "budget recompute after ingest failed");
    }
  }
}

