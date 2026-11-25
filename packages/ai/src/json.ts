import { formatMilli } from "@homebase/shared";
import { redactDeep } from "./redact";

/**
 * Serialize a tool result for the model: bigint milliunits become dollar strings ("-$612.40"),
 * free text is redacted, and very large payloads are truncated with a note.
 */
export function toModelJson(value: unknown, maxChars = 40_000): string {
  const redacted = redactDeep(value);
  const s = JSON.stringify(redacted, (_k, v: unknown) => (typeof v === "bigint" ? formatMilli(v) : v));
  if (s === undefined) return "null";
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}… [truncated ${s.length - maxChars} chars; narrow the query]`;
}

/** JSON.stringify that tolerates bigint (as a decimal string), for persistence/audit payloads. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

/** Extract the last top-level JSON object embedded in model text (fenced or bare). */
export function extractJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const f of fenced.reverse()) {
    try {
      return JSON.parse(f);
    } catch {
      /* try next */
    }
  }
  // Scan backwards for a balanced {...}
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = end; i >= 0; i--) {
      const c = text[i];
      if (c === '"' && text[i - 1] !== "\\") inStr = !inStr;
      if (inStr) continue;
      if (c === "}") depth++;
      else if (c === "{") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, end + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
