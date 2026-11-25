import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "../db";

export interface InboxEntryVM {
  connectionId: string;
  connectionLabel: string;
  accountId: string;
  externalId: string;
  name: string;
  kindGuess: string;
  detectedAt: string;
  institution: string | null;
  balance: bigint | null;
}

/** New-accounts inbox (worker ADR "ingest rules"): `connections.meta.inbox` entries, newest first. */
export async function loadAccountInbox(): Promise<InboxEntryVM[]> {
  const res = await getDb().execute<{
    connection_id: string;
    label: string;
    account_id: string;
    external_id: string;
    name: string;
    kind_guess: string;
    detected_at: string;
    institution: string | null;
    balance: string | null;
  }>(sql`
    SELECT c.id AS connection_id, c.label, e->>'accountId' AS account_id, e->>'externalId' AS external_id, e->>'name' AS name,
      e->>'kindGuess' AS kind_guess, e->>'detectedAt' AS detected_at, a.institution,
      (SELECT current_milli FROM balances b WHERE b.account_id = a.id ORDER BY as_of DESC LIMIT 1)::text AS balance
    FROM connections c
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.meta->'inbox', '[]'::jsonb)) e
    JOIN accounts a ON a.id = (e->>'accountId')::uuid AND a.deleted_at IS NULL
    ORDER BY e->>'detectedAt' DESC`);
  return res.rows.map((r) => ({
    connectionId: r.connection_id,
    connectionLabel: r.label,
    accountId: r.account_id,
    externalId: r.external_id,
    name: r.name,
    kindGuess: r.kind_guess,
    detectedAt: r.detected_at,
    institution: r.institution,
    balance: r.balance === null ? null : BigInt(r.balance),
  }));
}

export async function loadEntities(): Promise<{ id: string; name: string }[]> {
  const res = await getDb().execute<{ id: string; name: string }>(sql`SELECT id, name FROM entities ORDER BY sort, name`);
  return res.rows;
}
