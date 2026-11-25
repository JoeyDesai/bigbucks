/** Small display formatters (dates and relative times). Money formatting lives in @homebase/shared. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-10-21" → "Oct 21" (or "Oct 21, 2025" when `withYear`). */
export function formatDay(date: string, opts: { withYear?: boolean; weekday?: boolean } = {}): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const base = `${MONTHS[m - 1]} ${d}`;
  const wd = opts.weekday ? `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ` : "";
  return `${wd}${base}${opts.withYear ? `, ${y}` : ""}`;
}

/** "updated 2h ago" style relative time. `now` is injectable for tests. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

/** "2026-10-01" → "2026-10" for URLs. */
export function monthParam(month: string): string {
  return month.slice(0, 7);
}

/** Accepts "2026-10" or "2026-10-01" → "2026-10-01"; null on garbage. */
export function parseMonthParam(v: string | undefined | null): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/.exec(v);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

export function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase();
}

const SOURCE_LABEL: Record<string, string> = {
  simplefin: "SimpleFIN",
  mercury: "Mercury",
  coinbase: "Coinbase",
  river_csv: "River CSV",
  xpub: "Bitcoin xpub",
  rentcast: "RentCast",
  amortization: "Amortization schedule",
  manual: "Manual",
  ynab_import: "YNAB import",
  csv: "CSV import",
};
/** Human label for an account's data source (used when there is no institution). */
export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

/** Whole dollars, rounded half away from zero: 79_990n → "$80". */
export function dollars(m: bigint): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const r = ((a + 500n) / 1000n) * 1000n;
  const s = `$${(r / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  return neg && r !== 0n ? `-${s}` : s;
}

/** Display label for a user-entered name: drops replacement characters (broken emoji from imports) and extra spaces. */
export function cleanLabel(name: string): string {
  return name.replace(/\uFFFD+/g, "").replace(/\s{2,}/g, " ").trim() || name;
}
