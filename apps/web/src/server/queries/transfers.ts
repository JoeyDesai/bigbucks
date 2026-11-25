import "server-only";
import { sql } from "drizzle-orm";
import { detectTransferPairs, type AccountInfo, type TransferTxn } from "@homebase/categorizer";
import { addDays } from "@homebase/shared";
import { householdEntityId } from "@homebase/core";
import { getDb } from "../db";

export interface TransferSuggestionVM {
  /** Counterpart account and row for markTransfer(ctx, id, {accountId, pairWithId}). */
  accountId: string;
  accountName: string;
  pairWithId: string;
  pairDate: string;
  reason: string;
}

/**
 * Transfer pairs the categorizer would only suggest (§8.3), computed at render time for unapproved
 * rows: candidates are unpaired, non-split, posted rows within the transfer window of those rows.
 */
export async function loadTransferSuggestions(): Promise<Record<string, TransferSuggestionVM>> {
  const db = getDb();
  const span = await db.execute<{ lo: string | null; hi: string | null }>(sql`
    SELECT min(date)::text AS lo, max(date)::text AS hi FROM transactions
    WHERE NOT approved AND deleted_at IS NULL AND transfer_account_id IS NULL AND NOT is_split AND cleared <> 'pending'`);
  const lo = span.rows[0]?.lo;
  const hi = span.rows[0]?.hi;
  if (!lo || !hi) return {};
  const rows = await db.execute<{ id: string; account_id: string; date: string; amount_milli: string; raw_description: string | null; payee_name: string | null; approved: boolean }>(sql`
    SELECT t.id, t.account_id, t.date::text AS date, t.amount_milli::text AS amount_milli, t.raw_description, p.name AS payee_name, t.approved
    FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
    WHERE t.deleted_at IS NULL AND t.transfer_account_id IS NULL AND NOT t.is_split AND NOT t.is_starting_balance AND t.cleared <> 'pending'
      AND t.date BETWEEN ${addDays(lo, -6)}::date AND ${addDays(hi, 6)}::date`);
  if (rows.rows.length < 2) return {};
  const household = await householdEntityId(db);
  const accts = await db.execute<{ id: string; name: string; nickname: string | null; institution: string | null; kind: AccountInfo["kind"]; on_budget: boolean; entity_id: string; entity_name: string }>(sql`
    SELECT a.id, a.name, a.nickname, a.institution, a.kind, a.on_budget, a.entity_id, e.name AS entity_name FROM accounts a JOIN entities e ON e.id = a.entity_id WHERE a.deleted_at IS NULL`);
  const accounts = new Map<string, AccountInfo>(
    accts.rows.map((a) => [a.id, { id: a.id, name: a.name, nickname: a.nickname, institution: a.institution, kind: a.kind, onBudget: a.on_budget, entity: a.entity_name, isBusiness: household !== null && a.entity_id !== household }]),
  );
  const [rta] = (await db.execute<{ id: string }>(sql`SELECT id FROM categories WHERE kind = 'internal_rta' LIMIT 1`)).rows;
  const txns: TransferTxn[] = rows.rows.map((r) => ({ id: r.id, accountId: r.account_id, date: r.date, amountMilli: BigInt(r.amount_milli), rawDescription: r.raw_description ?? "", payeeName: r.payee_name }));
  const unapproved = new Set(rows.rows.filter((r) => !r.approved).map((r) => r.id));
  const byId = new Map(txns.map((t) => [t.id, t]));
  const { auto, suggestions } = detectTransferPairs(txns, accounts, { rtaCategoryId: rta?.id ?? null });
  const out: Record<string, TransferSuggestionVM> = {};
  for (const m of [...auto, ...suggestions].sort((a, b) => b.confidence - a.confidence)) {
    for (const [mine, other, otherAccount] of [
      [m.outflowId, m.inflowId, m.inflowAccountId],
      [m.inflowId, m.outflowId, m.outflowAccountId],
    ] as const) {
      if (!unapproved.has(mine) || out[mine]) continue;
      out[mine] = { accountId: otherAccount, accountName: accounts.get(otherAccount)?.name ?? "another account", pairWithId: other, pairDate: byId.get(other)!.date, reason: m.reason };
    }
  }
  return out;
}
