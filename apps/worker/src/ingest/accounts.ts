/**
 * §8.2 step 1–2: account upsert by (connection_id, external_id) and the daily balance upsert.
 *
 * A first-seen external account is created off budget in the "New accounts" inbox
 * (`connections.meta.inbox`) unless `connections.meta.accountMap[externalId]` maps it to an existing
 * account (e.g. the YNAB-imported "Checking") or gives explicit creation settings.
 * Nothing new is ever put on budget automatically.
 */
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { accounts, balances, entities, type Account, type Connection, type Tx } from "@homebase/db";
import type { ExternalAccount } from "@homebase/connectors";
import { ACCOUNT_KINDS, toLocalDate, type AccountKind, type AccountSource, type ISODate } from "@homebase/shared";
import { metaOf, patchConnectionMeta, type ConnectionMeta } from "./syncRuns";

export const HOUSEHOLD_ENTITY = "Household";
/**
 * The business entity (Mercury accounts land there). Every entity other than Household counts as the
 * business, so an existing one is found whatever it is called; this is only the name a new one gets.
 */
export const BUSINESS_ENTITY = "Business";

export async function ensureEntity(tx: Tx, name: string): Promise<string> {
  const found = await tx.select({ id: entities.id }).from(entities).where(eq(entities.name, name));
  if (found[0]) return found[0].id;
  if (name === BUSINESS_ENTITY) {
    const [business] = await tx.select({ id: entities.id }).from(entities).where(ne(entities.name, HOUSEHOLD_ENTITY)).orderBy(asc(entities.sort), asc(entities.name)).limit(1);
    if (business) return business.id;
  }
  const [row] = await tx.insert(entities).values({ name, sort: name === HOUSEHOLD_ENTITY ? 0 : 1 }).onConflictDoNothing().returning({ id: entities.id });
  if (row) return row.id;
  return (await tx.select({ id: entities.id }).from(entities).where(eq(entities.name, name)))[0]!.id;
}

const isKind = (k: unknown): k is AccountKind => typeof k === "string" && (ACCOUNT_KINDS as readonly string[]).includes(k);

export interface AccountUpsertResult {
  account: Account;
  created: boolean;
  inbox: boolean;
}

export async function upsertExternalAccount(
  tx: Tx,
  connection: Connection,
  ext: ExternalAccount,
  o: { source: AccountSource; defaultEntity: string; now: Date },
): Promise<AccountUpsertResult> {
  const existing = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.connectionId, connection.id), eq(accounts.externalId, ext.externalId)));
  if (existing[0]) {
    const a = existing[0];
    if (!a.institution && ext.institution) {
      await tx.update(accounts).set({ institution: ext.institution, updatedAt: o.now }).where(eq(accounts.id, a.id));
      a.institution = ext.institution;
    }
    return { account: a, created: false, inbox: false };
  }

  const meta = metaOf(connection);
  const mapping = meta.accountMap?.[ext.externalId];
  if (mapping?.accountId) {
    // Explicit link to an existing account (typically YNAB-imported) — it now syncs from this provider.
    const [linked] = await tx
      .update(accounts)
      .set({ connectionId: connection.id, externalId: ext.externalId, source: o.source, institution: sql`coalesce(${accounts.institution}, ${ext.institution ?? null})`, updatedAt: o.now })
      .where(and(eq(accounts.id, mapping.accountId), isNull(accounts.deletedAt)))
      .returning();
    if (linked) return { account: linked, created: false, inbox: false };
  }

  const explicit = !!mapping && !mapping.accountId;
  const entityId = await ensureEntity(tx, mapping?.entity ?? o.defaultEntity);
  const kind = isKind(mapping?.kind) ? mapping!.kind as AccountKind : ext.kindGuess;
  const [created] = await tx
    .insert(accounts)
    .values({
      entityId,
      name: mapping?.name ?? ext.name,
      institution: ext.institution ?? null,
      kind,
      onBudget: explicit ? mapping!.onBudget === true : false,
      source: o.source,
      connectionId: connection.id,
      externalId: ext.externalId,
      sort: 1000,
    })
    .returning();
  if (!explicit) {
    const entry = { accountId: created!.id, externalId: ext.externalId, name: ext.name, kindGuess: ext.kindGuess, detectedAt: o.now.toISOString() };
    const inbox = [...(meta.inbox ?? []).filter((x) => x.externalId !== ext.externalId), entry];
    await patchConnectionMeta(tx, connection.id, { inbox } satisfies Partial<ConnectionMeta>);
    connection.meta = { ...meta, inbox };
  }
  return { account: created!, created: true, inbox: !explicit };
}

/** Upsert the balance row for the balance's local date. `inverted` accounts flip the provider's sign. */
export async function upsertBalance(tx: Tx, account: Pick<Account, "id" | "balanceSign">, ext: Pick<ExternalAccount, "balance" | "availableBalance" | "asOf">, source: AccountSource): Promise<ISODate> {
  const asOf = toLocalDate(ext.asOf);
  const flip = account.balanceSign === "inverted" ? -1n : 1n;
  const current = ext.balance * flip;
  const available = ext.availableBalance !== undefined ? ext.availableBalance * flip : null;
  await tx
    .insert(balances)
    .values({ accountId: account.id, asOf, currentMilli: current, availableMilli: available, source })
    .onConflictDoUpdate({ target: [balances.accountId, balances.asOf], set: { currentMilli: current, availableMilli: available, source, updatedAt: new Date() } });
  return asOf;
}
