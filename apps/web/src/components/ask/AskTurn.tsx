"use client";
import type { ChartSpec } from "@homebase/ai";
import { Check } from "lucide-react";
import { cx } from "@/lib/cx";
import { AskAction, type CategoryOption } from "./AskAction";
import { AskChart } from "./AskChart";
import { Markdown } from "./Markdown";
import { TOOL_LABELS, type ActionVM, type AskPart, type AskTurnVM } from "./types";

function ToolTrail({ parts }: { parts: Extract<AskPart, { type: "tool" }>[] }) {
  if (!parts.length) return null;
  return (
    <ul className="space-y-0.5 text-[12px] text-ink-3" aria-label="Steps">
      {parts.map((p) => (
        <li key={p.id} className="flex items-baseline gap-2">
          {p.done ? (
            <Check size={12} strokeWidth={2} aria-hidden className={cx("shrink-0 translate-y-[1px]", p.isError ? "text-neg" : "text-ink-3")} />
          ) : (
            <span aria-hidden className="inline-block h-[7px] w-[7px] shrink-0 translate-y-[-1px] bg-accent" style={{ animation: "hb-fade-in 0.8s ease-in-out infinite alternate" }} />
          )}
          <span className={p.isError ? "text-neg" : undefined}>
            {TOOL_LABELS[p.name] ?? p.name}
            {p.done && p.summary ? <span className="text-ink-3"> · {p.summary}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface AskTurnProps {
  turn: AskTurnVM;
  categories: CategoryOption[];
  onActionChange: (turnId: string, a: ActionVM) => void;
  onSaveChart: (spec: ChartSpec) => Promise<boolean>;
}

/** One chat turn. Assistant answers lead with the number; tool steps are listed small above. */
export function AskTurn({ turn, categories, onActionChange, onSaveChart }: AskTurnProps) {
  if (turn.role === "user") {
    const text = turn.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-left text-[15px] text-accent-contrast">{text}</p>
      </div>
    );
  }
  const tools = turn.parts.filter((p): p is Extract<AskPart, { type: "tool" }> => p.type === "tool");
  const body = turn.parts.filter((p) => p.type !== "tool");
  const empty = body.length === 0;
  return (
    <article className="space-y-4" aria-busy={turn.streaming || undefined}>
      <ToolTrail parts={tools} />
      {body.map((p, i) =>
        p.type === "text" ? (
          <Markdown key={i} text={p.text} className="space-y-3 text-[16px] leading-[1.55] text-ink [&>p:first-child]:font-display [&>p:first-child]:text-[19px] [&>p:first-child]:leading-[1.4]" />
        ) : p.type === "chart" ? (
          <AskChart key={p.id} spec={p.spec} onSave={onSaveChart} />
        ) : p.type === "action" ? (
          <AskAction key={p.action.id} action={p.action} categories={categories} onChange={(a) => onActionChange(turn.id, a)} />
        ) : null,
      )}
      {turn.streaming && empty && !turn.error && (
        <p className="text-[14px] text-ink-3" role="status">
          Working on it…
        </p>
      )}
      {turn.error && (
        <p role="alert" className="border-l-[3px] border-neg-bar pl-3 text-[14px] text-ink-2">
          {turn.error}
        </p>
      )}
    </article>
  );
}
