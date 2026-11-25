"use client";
import { useState } from "react";
import { BookmarkPlus } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import type { AskBlockVM, AskMessageVM } from "@/lib/view-models";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { DonutChart, DonutLegend } from "@/components/charts/DonutChart";
import { ConfirmActionCard, type ConfirmState } from "./ConfirmActionCard";

function Block({ block, onSaveReport }: { block: AskBlockVM; onSaveReport?: (title: string) => void }) {
  const [state, setState] = useState<ConfirmState>("pending");
  if (block.type === "donut")
    return (
      <ChartFrame
        title={<span className="text-[17px]">{block.title}</span>}
        summary={block.title}
        height={200}
        actions={
          onSaveReport && (
            <button type="button" onClick={() => onSaveReport(block.title)} className="inline-flex min-h-9 items-center gap-1.5 text-[12px] text-ink-2 hover:text-ink">
              <BookmarkPlus size={15} strokeWidth={1.75} aria-hidden /> Save as report
            </button>
          )
        }
        footer={<DonutLegend data={block.data.slice(0, 6)} />}
      >
        <DonutChart data={block.data} centerLabel="Spent" />
      </ChartFrame>
    );
  if (block.type === "table")
    return (
      <div>
        <div className="eyebrow mb-1.5">{block.title}</div>
        <ol className="border-t border-rule text-[14px]">
          {block.rows.map((r, i) => (
            <li key={r.label} className="flex items-baseline gap-3 border-b border-rule py-2">
              <span className="num w-5 text-[12px] text-ink-3">{i + 1}</span>
              <span className="flex-1 truncate">{r.label}</span>
              <span className="num">{formatMilli(r.value)}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  return (
    <ConfirmActionCard
      tool={block.tool}
      summary={block.summary}
      diff={block.diff}
      notes={block.notes}
      state={state}
      onConfirm={() => {
        setState("confirming");
        setTimeout(() => setState("confirmed"), 700);
      }}
      onEdit={() => undefined}
      onCancel={() => setState("cancelled")}
    />
  );
}

/** One chat turn. Assistant answers lead with the number and always show the date range. */
export function AskMessage({ message, onSaveReport }: { message: AskMessageVM; onSaveReport?: (title: string) => void }) {
  if (message.role === "user")
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-left text-[15px] text-accent-contrast">{message.text}</p>
      </div>
    );
  return (
    <article className="space-y-4">
      <p className={cx("display text-[19px] leading-[1.4] text-ink")}>{message.text}</p>
      {message.range && <p className="text-[12px] text-ink-3">{message.range}</p>}
      {message.blocks?.map((b, i) => (
        <Block key={i} block={b} onSaveReport={onSaveReport} />
      ))}
    </article>
  );
}
