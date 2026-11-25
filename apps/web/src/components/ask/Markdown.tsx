import { Fragment, type ReactNode } from "react";

/**
 * Small, safe markdown renderer for assistant replies: paragraphs, headings, bullet and numbered
 * lists, tables, **bold**, *italic*, `code`. Builds React elements (never HTML strings), so model
 * output can't inject markup.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("**")) out.push(<strong key={k} className="font-semibold text-ink">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k} className="rounded-xs bg-paper-sunken px-1 font-mono text-[0.9em]">{t.slice(1, -1)}</code>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isDivider = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const numeric = (s: string) => /^[−\-+]?\$?[\d,]+(\.\d+)?%?$/.test(s.replace(/\s/g, ""));

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${n++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <p key={key} className="display mt-1 text-[17px] leading-snug text-ink">
          {inline(h[2]!, key)}
        </p>,
      );
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      const num = head.map((_, c) => rows.length > 0 && rows.every((r) => !r[c] || numeric(r[c]!)));
      blocks.push(
        <div key={key} className="overflow-x-auto border-y border-rule">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} scope="col" className={`eyebrow border-b border-rule-strong px-3 py-2 first:pl-0 last:pr-0 ${num[j] ? "text-right" : "text-left"}`}>
                    {inline(c, `${key}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-rule last:border-b-0">
                  {head.map((_, j) => (
                    <td key={j} className={`px-3 py-2 first:pl-0 last:pr-0 ${num[j] ? "num whitespace-nowrap text-right" : ""}`}>
                      {inline(r[j] ?? "", `${key}r${ri}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*([-*•])\s+/).test(lines[i]!)) {
        items.push(lines[i]!.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*([-*•])\s+/, ""));
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key} className="border-t border-rule">
          {items.map((it, j) => (
            <li key={j} className="flex gap-3 border-b border-rule py-1.5">
              <span aria-hidden className="num w-4 shrink-0 text-[12px] leading-[1.9] text-ink-3">
                {ordered ? j + 1 : <span className="mt-[0.6em] inline-block h-1 w-1 bg-ink-3 align-top" />}
              </span>
              <span className="min-w-0 flex-1">{inline(it, `${key}-${j}`)}</span>
            </li>
          ))}
        </Tag>,
      );
      continue;
    }
    // Always consume the current line, so a stray "|" line can't stall the loop.
    const para: string[] = [lines[i++]!];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4})\s/.test(lines[i]!) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!) && !isTableRow(lines[i]!)) para.push(lines[i++]!);
    blocks.push(
      <p key={key}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className={className}>{blocks}</div>;
}
