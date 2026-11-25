import { evalAmountExpr } from "@homebase/shared";

/**
 * Resolve what the user typed in an amount field against the current value.
 * A bare number replaces the value ("200" → 200). Leading operators use the mini-language
 * (`+50`, `-25`, `=200`, `*2`, `/4`), and `50*2` style arithmetic works too.
 * Returns null when the text can't be parsed. Empty text keeps the current value.
 * With `signedAbsolute` (always-editable form fields) a leading "-" is a sign, not subtraction.
 */
export function resolveAmountText(text: string, current: bigint, opts: { signedAbsolute?: boolean } = {}): bigint | null {
  const t = text.trim();
  if (t === "") return current;
  // Form fields (signedAbsolute): "-1,950.00" is a negative amount, not "subtract 1,950".
  const bare = opts.signedAbsolute ? /^-?\$?[\d,]*\.?\d*$/.test(t) : /^\$?[\d,]*\.?\d*$/.test(t);
  try {
    return evalAmountExpr(bare ? `=${t}` : t, current);
  } catch {
    return null;
  }
}

/** True when the text is an expression whose result differs from what was typed (show a preview). */
export function isAmountExpression(text: string): boolean {
  const t = text.trim();
  return t.length > 1 && /^[+\-*/=]|\d[*/+-]/.test(t);
}
