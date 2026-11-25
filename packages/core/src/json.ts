/** JSON-safe conversion for jsonb payloads (bigint → decimal string, Date → ISO). */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return null; // never serialize secrets/bytes into logs
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toJson(v);
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  return String(value);
}

/** Deterministic stringify (sorted keys) for equality checks of row snapshots. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Raw `db.execute(sql…)` results bypass Drizzle's column mapping, and drizzle's node-postgres driver
 * returns timestamp/timestamptz as the server's text form ("2026-10-22 16:00:00.123+00"). Every raw
 * timestamp in core goes through this so callers always get a real Date (like typed Drizzle reads).
 */
export function toDateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable timestamp ${String(v)}`);
  return d;
}

export function toDate(v: unknown): Date {
  const d = toDateOrNull(v);
  if (!d) throw new Error("expected a timestamp, got null");
  return d;
}
