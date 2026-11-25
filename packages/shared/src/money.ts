/**
 * Money is always bigint milliunits ($1.00 = 1000n), matching YNAB's API.
 * Never use floats for money. Format only at the display edge.
 */
export type Milli = bigint;

export const MILLI_PER_DOLLAR = 1000n;

/** Parse a decimal string like "-1,234.56" or "$12" into milliunits. Throws on garbage. */
export function parseMilli(input: string | number): Milli {
  const s = String(input).trim().replace(/[$,\s]/g, "");
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`Invalid money amount: ${input}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = BigInt(m[2] || "0");
  const frac = (m[3] ?? "").padEnd(4, "0");
  // round half away from zero at the 4th decimal (milliunits have 3)
  let thousandths = BigInt(frac.slice(0, 3));
  if (Number(frac[3]) >= 5) thousandths += 1n;
  return sign * (whole * 1000n + thousandths);
}

/** Dollars (number) → milli. Only for trusted numeric inputs from APIs that already use numbers. */
export function dollarsToMilli(n: number): Milli {
  return parseMilli(n.toFixed(4));
}

/** milli → cents-precision number for charting only. Never feed back into math. */
export function milliToNumber(m: Milli): number {
  return Number(m) / 1000;
}

export function absMilli(m: Milli): Milli {
  return m < 0n ? -m : m;
}

export function minMilli(...xs: Milli[]): Milli {
  return xs.reduce((a, b) => (b < a ? b : a));
}

export function maxMilli(...xs: Milli[]): Milli {
  return xs.reduce((a, b) => (b > a ? b : a));
}

export function sumMilli(xs: Iterable<Milli>): Milli {
  let t = 0n;
  for (const x of xs) t += x;
  return t;
}

/** Integer division rounding half away from zero. */
export function divRound(a: Milli, b: bigint): Milli {
  if (b === 0n) throw new Error("division by zero");
  const neg = (a < 0n) !== (b < 0n);
  const aa = a < 0n ? -a : a;
  const bb = b < 0n ? -b : b;
  const q = (aa * 2n + bb) / (bb * 2n);
  return neg ? -q : q;
}

/** Round milli to whole cents (YNAB displays cents; its milliunits are always multiples of 10). */
export function roundToCents(m: Milli): Milli {
  return divRound(m, 10n) * 10n;
}

/** "$1,234.56" / "-$1,234.56". */
export function formatMilli(m: Milli, opts: { sign?: "auto" | "always" | "never"; cents?: boolean } = {}): string {
  const neg = m < 0n;
  const cents = roundToCents(absMilli(m)) / 10n;
  const dollars = cents / 100n;
  const c = (cents % 100n).toString().padStart(2, "0");
  const d = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = opts.cents === false ? `$${d}` : `$${d}.${c}`;
  const sign = opts.sign ?? "auto";
  if (sign === "never") return body;
  if (neg) return `-${body}`;
  return sign === "always" && m > 0n ? `+${body}` : body;
}

/** JSON-safe serialization of milli values (bigint → string). */
export function milliToJSON(m: Milli): string {
  return m.toString();
}

export function milliFromJSON(s: string | number | bigint): Milli {
  return typeof s === "bigint" ? s : BigInt(s);
}

/**
 * Evaluate the Assigned-cell mini-language. `current` is the existing value.
 *   "200" → 200   "=200" / "=-25" → set   "+50" → add   "-25" → subtract   "*2" / "/4" → scale
 *   "50*2" / "100/4" → arithmetic result
 */
export function evalAmountExpr(expr: string, current: Milli): Milli {
  const e = expr.trim().replace(/[$,\s]/g, "");
  if (e === "") return current;
  if (e.startsWith("=")) return parseMilli(e.slice(1));
  if (e.startsWith("+")) return current + parseMilli(e.slice(1));
  if (e.startsWith("-")) return current - parseMilli(e.slice(1));
  if (e.startsWith("*")) return divRound(current * parseMilli(e.slice(1)), 1000n);
  if (e.startsWith("/")) return divRound(current * 1000n, parseMilli(e.slice(1)));
  const bin = /^([\d.]+)([*/+-])([\d.]+)$/.exec(e);
  if (bin) {
    const a = parseMilli(bin[1]!), b = parseMilli(bin[3]!);
    switch (bin[2]) {
      case "*": return divRound(a * b, 1000n);
      case "/": return divRound(a * 1000n, b);
      case "+": return a + b;
      default: return a - b;
    }
  }
  return parseMilli(e);
}
