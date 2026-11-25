/**
 * OFX / QFX importer (§7.10). Handles OFX 1.x SGML (unclosed leaf tags) and OFX 2.x XML.
 * Parses each bank (STMTRS) / card (CCSTMTRS) statement's STMTTRN rows, LEDGERBAL and AVAILBAL.
 * Account numbers never leave this module except as last-4 and a one-way hash id.
 */
import { addDays, type ISODate, type Milli } from "@homebase/shared";
import { blankToUndef, instantToLocalDate, sha256Hex, toMilli } from "./normalize";
import { ConnectorError, type ExternalTxn } from "./types";

export interface OfxStatement {
  /** Stable id: "ofx:" + sha256(bankId|acctId) prefix. */
  accountExternalId: string;
  accountLast4: string;
  accountType: string;
  isCreditCard: boolean;
  currency: string;
  ledgerBalance?: Milli;
  ledgerBalanceAsOf?: string;
  availableBalance?: Milli;
  startDate?: ISODate;
  endDate?: ISODate;
  transactions: ExternalTxn[];
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .trim();

/** First leaf value of <TAG> inside `block` (works for SGML and XML). */
function leaf(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  return m ? blankToUndef(decode(m[1]!)) : undefined;
}

/** All <TAG>…</TAG> aggregate blocks. Aggregates are closed in both SGML and XML OFX. */
function blocks(text: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!);
  return out;
}

/**
 * OFX datetime "YYYYMMDD[HHMMSS[.XXX]][[+|-]H[H][.MM][:TZ]]" → { instant, localDate }.
 * Without an offset OFX means GMT. Date-only values are taken as the calendar date as-is.
 */
export function parseOfxDate(raw: string): { iso?: string; date: ISODate } {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?(?:\.\d+)?)?(?:\[([+-]?\d{1,2}(?:\.\d+)?)(?::[A-Za-z]+)?\])?/.exec(raw.trim());
  if (!m) throw new ConnectorError("parse", `Invalid OFX date: ${raw}`, { provider: "ofx" });
  const [, y, mo, d, hh, mi, ss, off] = m;
  const date = `${y}-${mo}-${d}`;
  if (hh === undefined) return { date };
  const offsetH = off !== undefined ? Number(off) : 0;
  const ms = Date.UTC(+y!, +mo! - 1, +d!, +hh, +mi!, +(ss ?? 0)) - offsetH * 3_600_000;
  const iso = new Date(ms).toISOString();
  // A non-GMT offset means the written calendar date is already the bank's local date. Midnight/noon
  // stamps are date-only values padded by the bank. Only real GMT times are converted to America/New_York.
  if (offsetH !== 0 || (mi === "00" && (hh === "00" || hh === "12"))) return { iso, date };
  return { iso, date: instantToLocalDate(iso) };
}

export function parseOfx(text: string): { statements: OfxStatement[]; warnings: string[] } {
  if (!/<OFX>/i.test(text)) throw new ConnectorError("parse", "Not an OFX/QFX file (no <OFX> element)", { provider: "ofx" });
  const warnings: string[] = [];
  const statements: OfxStatement[] = [];
  const kinds: Array<{ tag: string; cc: boolean }> = [
    { tag: "STMTRS", cc: false },
    { tag: "CCSTMTRS", cc: true },
  ];
  for (const { tag, cc } of kinds) {
    for (const st of blocks(text, tag)) {
      const from = blocks(st, cc ? "CCACCTFROM" : "BANKACCTFROM")[0] ?? st;
      const acctId = leaf(from, "ACCTID") ?? "unknown";
      const bankId = leaf(from, "BANKID") ?? "";
      const accountExternalId = `ofx:${sha256Hex(`${bankId}|${acctId}`).slice(0, 16)}`;
      const s: OfxStatement = {
        accountExternalId,
        accountLast4: acctId.slice(-4),
        accountType: cc ? "CREDITCARD" : (leaf(from, "ACCTTYPE") ?? "CHECKING"),
        isCreditCard: cc,
        currency: leaf(st, "CURDEF") ?? "USD",
        transactions: [],
      };
      const tl = blocks(st, "BANKTRANLIST")[0];
      if (tl) {
        const ds = leaf(tl, "DTSTART");
        const de = leaf(tl, "DTEND");
        if (ds) s.startDate = parseOfxDate(ds).date;
        if (de) s.endDate = parseOfxDate(de).date;
      }
      const lb = blocks(st, "LEDGERBAL")[0];
      if (lb) {
        const a = leaf(lb, "BALAMT");
        const d = leaf(lb, "DTASOF");
        if (a) s.ledgerBalance = toMilli(a);
        if (d) {
          const p = parseOfxDate(d);
          s.ledgerBalanceAsOf = p.iso ?? `${p.date}T12:00:00.000Z`;
        }
      }
      const ab = blocks(st, "AVAILBAL")[0];
      if (ab) {
        const a = leaf(ab, "BALAMT");
        if (a) s.availableBalance = toMilli(a);
      }
      const seen = new Map<string, number>();
      blocks(st, "STMTTRN").forEach((t, i) => {
        try {
          const amt = leaf(t, "TRNAMT");
          const posted = leaf(t, "DTPOSTED");
          if (!amt || !posted) throw new Error("missing TRNAMT/DTPOSTED");
          const p = parseOfxDate(posted);
          const user = leaf(t, "DTUSER");
          // §6.1: transaction date if known, else posted.
          const date = user ? parseOfxDate(user).date : p.date;
          const name = leaf(t, "NAME") ?? leaf(t, "PAYEE") ?? "";
          const memo = leaf(t, "MEMO");
          const amount = toMilli(amt);
          let fitid = leaf(t, "FITID") ?? `nofitid:${sha256Hex(`${date}|${amount}|${name}|${memo ?? ""}`).slice(0, 24)}`;
          const n = (seen.get(fitid) ?? 0) + 1;
          seen.set(fitid, n);
          if (n > 1) fitid = `${fitid}#${n}`;
          const x: ExternalTxn = {
            externalId: fitid,
            accountExternalId,
            date,
            postedAt: p.iso ?? null,
            amount,
            description: name || memo || (leaf(t, "TRNTYPE") ?? "OFX transaction"),
            pending: false,
            raw: { trnType: leaf(t, "TRNTYPE"), fitid: leaf(t, "FITID"), checkNum: leaf(t, "CHECKNUM"), name, memo, sic: leaf(t, "SIC") },
          };
          if (name) x.payee = name;
          if (memo) x.memo = memo;
          const sic = leaf(t, "SIC");
          if (sic) x.mcc = sic;
          s.transactions.push(x);
        } catch (e) {
          warnings.push(`statement ${s.accountLast4} txn #${i}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      statements.push(s);
    }
  }
  if (!statements.length) warnings.push("No STMTRS/CCSTMTRS statements found");
  return { statements, warnings };
}

/** Expand a statement date range by a day on each side (for dedupe windows). */
export function statementWindow(s: OfxStatement): { since?: ISODate; until?: ISODate } {
  const out: { since?: ISODate; until?: ISODate } = {};
  if (s.startDate) out.since = addDays(s.startDate, -1);
  if (s.endDate) out.until = addDays(s.endDate, 1);
  return out;
}
