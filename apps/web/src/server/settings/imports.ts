import { BRAND } from "@/lib/brand";
import "server-only";
/**
 * Settings → Imports (§7.4, §7.5, §7.10, §8.4): CSV/OFX/River transactions and Fidelity positions.
 *
 * Imported transactions are inserted like synced bank rows (source csv/river_csv, cleared, unapproved,
 * catz NULL) so the categorizer picks them up; exact duplicates (import_hash, external_id) are skipped
 * and near duplicates are skipped unless asked. One audit row per import; the budget cache is
 * invalidated from the earliest imported month.
 */
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { normalizedKey } from "@homebase/categorizer";
import { dedupeAgainst, importHash, type ExternalHolding, type ExternalTxn } from "@homebase/connectors";
import { invalidateBudget, withTx, writeAudit, type Ctx } from "@homebase/core";
import { accounts, holdings, payees, transactions, type Tx } from "@homebase/db";
import { addDays, monthOf, newId, type ISODate } from "@homebase/shared";

export interface ImportOutcome {
  imported: number;
  exact: number;
  near: number;
  skippedExisting: number;
  transactionIds: string[];
  from: ISODate | null;
  to: ISODate | null;
}

async function payeeFor(tx: Tx, name: string | undefined, cache: Map<string, string | null>): Promise<string | null> {
  const n = name?.trim();
  if (!n) return null;
  const key = normalizedKey(n);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key)!;
  const [hit] = await tx
    .select({ id: payees.id })
    .from(payees)
    .where(and(isNull(payees.deletedAt), sql`(${payees.normalizedKey} = ${key} OR regexp_replace(lower(${payees.normalizedKey}), '[^a-z0-9]', '', 'g') = ${key})`))
    .limit(1);
  let id = hit?.id ?? null;
  if (!id) {
    const [row] = await tx.insert(payees).values({ id: newId(), name: n.slice(0, 200), normalizedKey: key }).onConflictDoNothing({ target: payees.normalizedKey }).returning({ id: payees.id });
    id = row?.id ?? (await tx.select({ id: payees.id }).from(payees).where(eq(payees.normalizedKey, key)))[0]?.id ?? null;
  }
  cache.set(key, id);
  return id;
}

/** Insert parsed transactions into one account with dedupe (§8.4). */
export async function importTransactions(ctx: Ctx, input: { accountId: string; txns: ExternalTxn[]; source: "csv" | "river_csv"; fileName: string; kind: string; includeNear?: boolean }): Promise<ImportOutcome> {
  const txns = input.txns.filter((t) => !t.pending);
  if (!txns.length) return { imported: 0, exact: 0, near: 0, skippedExisting: 0, transactionIds: [], from: null, to: null };
  const dates = txns.map((t) => t.date).sort();
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  return withTx(ctx, async (tx, c) => {
    const [acct] = await tx.select({ id: accounts.id, closed: accounts.closed }).from(accounts).where(eq(accounts.id, input.accountId));
    if (!acct) throw new Error("That account doesn't exist.");
    const existing = await tx
      .select({ date: transactions.date, amount: transactions.amountMilli, description: sql<string>`coalesce(${transactions.rawDescription}, '')`, importHash: transactions.importHash, externalId: transactions.externalId })
      .from(transactions)
      .where(and(eq(transactions.accountId, input.accountId), isNull(transactions.deletedAt), gte(transactions.date, addDays(from, -7)), lte(transactions.date, addDays(to, 7))));
    const extIds = new Set(existing.map((e) => e.externalId).filter(Boolean));
    const notSeen = txns.filter((t) => !extIds.has(t.externalId));
    const skippedExisting = txns.length - notSeen.length;
    const d = dedupeAgainst(
      notSeen,
      existing.map((e) => ({ date: e.date, amount: e.amount, description: e.description, ...(e.importHash ? { importHash: e.importHash } : {}) })),
      input.accountId,
    );
    const toInsert = input.includeNear ? [...d.fresh, ...d.near] : d.fresh;
    const cache = new Map<string, string | null>();
    const ids: string[] = [];
    let order = 0;
    for (const t of toInsert) {
      const id = newId();
      ids.push(id);
      await tx.insert(transactions).values({
        id,
        accountId: input.accountId,
        date: t.date,
        postedAt: t.postedAt ? new Date(t.postedAt) : null,
        amountMilli: t.amount,
        payeeId: await payeeFor(tx, t.payee, cache),
        rawDescription: t.description.slice(0, 500),
        memo: t.memo?.slice(0, 500) ?? null,
        cleared: "cleared",
        approved: false,
        source: input.source,
        externalId: t.externalId,
        importHash: importHash(input.accountId, t.date, t.amount, t.description),
        importOrder: order++,
      });
    }
    if (ids.length) await invalidateBudget(tx, monthOf(from));
    await writeAudit(tx, c, {
      action: `import.${input.kind}`,
      entity: "account",
      entityId: input.accountId,
      after: { file: input.fileName.slice(0, 120), imported: ids.length, exact: d.exact.length, near: d.near.length, skippedExisting, from, to, includeNear: !!input.includeNear },
    });
    return { imported: ids.length, exact: d.exact.length, near: d.near.length, skippedExisting, transactionIds: ids, from, to };
  });
}

/** Replace one day's holdings snapshot for each mapped account (Fidelity positions CSV). */
export async function importHoldings(ctx: Ctx, input: { mapping: Record<string, string>; holdings: ExternalHolding[]; asOf: ISODate; fileName: string }): Promise<{ accounts: number; positions: number }> {
  const targets = [...new Set(Object.values(input.mapping).filter(Boolean))];
  if (!targets.length) throw new Error(`Map at least one Fidelity account to a ${BRAND.name} account.`);
  return withTx(ctx, async (tx, c) => {
    const found = await tx.select({ id: accounts.id }).from(accounts).where(inArray(accounts.id, targets));
    if (found.length !== targets.length) throw new Error("One of the chosen accounts doesn't exist.");
    await tx.delete(holdings).where(and(inArray(holdings.accountId, targets), eq(holdings.asOf, input.asOf)));
    let n = 0;
    for (const h of input.holdings) {
      const accountId = input.mapping[h.accountExternalId];
      if (!accountId) continue;
      if (h.marketValue === undefined) continue;
      await tx.insert(holdings).values({
        accountId,
        asOf: input.asOf,
        symbol: h.symbol.slice(0, 40),
        name: h.description?.slice(0, 200) ?? null,
        quantity: h.shares,
        price: null,
        marketValueMilli: h.marketValue,
        costBasisMilli: h.costBasis ?? null,
        lotKey: h.externalId ?? null,
      });
      n++;
    }
    await writeAudit(tx, c, { action: "import.fidelity_positions", entity: "holdings", entityId: null, after: { file: input.fileName.slice(0, 120), asOf: input.asOf, accounts: targets.length, positions: n } });
    return { accounts: targets.length, positions: n };
  });
}
