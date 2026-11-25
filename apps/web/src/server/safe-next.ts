/**
 * Where to go after signing in: only a path on this site, else /budget.
 *
 * The value is parsed the way a browser reads a Location header instead of being prefix-matched, so
 * "/\t/evil.example" (browsers drop the tab and see "//evil.example"), "/\\evil.example" and friends
 * can't point at another site. Control characters and backslashes are refused outright, and the result
 * is the URL parser's own serialization (path + query), so nothing unencoded reaches the header.
 *
 * Deliberately not in a "use server" module: exports there become callable server actions.
 */
const FALLBACK = "/budget";
const BASE = "https://same-origin.invalid";

function hasControlOrBackslash(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || hasControlOrBackslash(next)) return FALLBACK;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== BASE || url.pathname.startsWith("/login")) return FALLBACK;
  return url.pathname + url.search;
}
