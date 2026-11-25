"use client";
import { useRef, useState, type PointerEvent } from "react";
import { ArrowLeftRight, Check, MoreHorizontal, Split, Tag } from "lucide-react";
import { cx } from "@/lib/cx";
import { formatDay, pct } from "@/lib/format";
import type { TransactionVM } from "@/lib/view-models";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { categoryLabel } from "@/lib/category-icons";
import { NeedsCategory } from "./Register";
import { Money } from "@/components/ui/Money";

export interface TransactionCardProps {
  tx: TransactionVM;
  /** Approve with the suggested (or current) category. */
  onApprove: (tx: TransactionVM) => void;
  /** Open the category picker for this transaction. */
  onChangeCategory: (tx: TransactionVM) => void;
  onSplit?: (tx: TransactionVM) => void;
  onMarkTransfer?: (tx: TransactionVM) => void;
  /** A likely transfer counterpart (categorizer suggestion) and how to link it. */
  transferSuggestion?: { accountName: string; pairDate: string; reason: string };
  onLinkTransfer?: (tx: TransactionVM) => void;
}

const THRESHOLD = 96;
const METHOD_LABEL: Record<string, string> = {
  rule: "Rule",
  history: "History",
  ai: "AI",
  ai_web: "AI + web lookup",
  user: "You",
  ynab: "YNAB",
  transfer: "Transfer",
};

function confidenceTone(c: number) {
  return c >= 0.9 ? "bg-pos-bar" : c >= 0.75 ? "bg-warn-bar" : "bg-ink-3";
}

/**
 * Review-inbox row. Swipe right = approve, swipe left = change category (pointer events);
 * the same actions are buttons for keyboard and screen-reader users.
 * Tapping the suggestion reveals confidence + explanation.
 */
export function TransactionCard({ tx, onApprove, onChangeCategory, onSplit, onMarkTransfer, transferSuggestion, onLinkTransfer }: TransactionCardProps) {
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const [explain, setExplain] = useState(false);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; id: number; horizontal: boolean | null } | null>(null);

  const s = tx.suggestion;
  const category = tx.categoryName ?? s?.categoryName ?? null;

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button,a,[role=menu]")) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null };
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const st = start.current;
    if (!st || st.id !== e.pointerId) return;
    const mx = e.clientX - st.x;
    const my = e.clientY - st.y;
    if (st.horizontal === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      st.horizontal = Math.abs(mx) > Math.abs(my);
      if (st.horizontal) {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }
    }
    if (st.horizontal) setDx(Math.max(-160, Math.min(160, mx)));
  }
  function onPointerUp() {
    const st = start.current;
    start.current = null;
    setDragging(false);
    if (!st?.horizontal) return;
    if (dx > THRESHOLD && category) {
      setLeaving("right");
      setTimeout(() => onApprove(tx), 180);
    } else if (dx < -THRESHOLD) {
      setDx(0);
      onChangeCategory(tx);
    } else {
      setDx(0);
    }
  }

  const offset = leaving === "right" ? "110%" : `${dx}px`;
  const revealApprove = dx > 0;
  const armed = Math.abs(dx) > THRESHOLD;

  return (
    <div className={cx("relative overflow-hidden border-b border-rule transition-[max-height,opacity] duration-200", leaving && "opacity-0")}>
      {/* Swipe backdrops */}
      <div aria-hidden className={cx("absolute inset-0 flex items-center px-5 text-[13px] font-semibold", revealApprove ? "justify-start bg-pos-bar text-white" : "justify-end bg-accent text-accent-contrast", dx === 0 && "invisible")}>
        <span className={cx("flex items-center gap-2 transition-opacity", armed ? "opacity-100" : "opacity-60")}>
          {revealApprove ? (
            <>
              <Check size={18} strokeWidth={2} /> Approve
            </>
          ) : (
            <>
              Categorize <Tag size={16} strokeWidth={2} />
            </>
          )}
        </span>
      </div>

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ transform: `translate3d(${offset},0,0)`, transition: dragging ? "none" : "transform 220ms var(--ease-out-quart)", touchAction: "pan-y" }}
        className="relative bg-paper px-4 py-3 lg:px-6"
      >
        <div className="flex items-baseline gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-ink">{tx.payee}</div>
            <div className="mt-0.5 truncate text-[12px] text-ink-3">
              {tx.accountName} · {formatDay(tx.date)}
              {tx.cleared === "uncleared" && " · uncleared"}
            </div>
          </div>
          <Money value={tx.amount} tone={tx.amount > 0n ? "pos" : "ink"} sign={tx.amount > 0n ? "always" : "auto"} className="text-[16px] font-semibold" />
        </div>

        <div className="mt-2 flex items-center gap-2">
          {s ? (
            <button
              type="button"
              onClick={() => setExplain((v) => !v)}
              aria-expanded={explain}
              className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-xs text-left text-[13px]"
            >
              <CategoryIcon name={tx.categoryName ?? s.categoryName} size={16} />
              <span className="truncate font-medium text-ink">{categoryLabel(tx.categoryName ?? s.categoryName)}</span>
              <span className="num inline-flex shrink-0 items-center gap-1 rounded-full bg-paper-sunken px-2 py-0.5 text-[11.5px] font-semibold text-ink-3">
                <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", confidenceTone(s.confidence))} />
                {pct(s.confidence)} sure
              </span>
            </button>
          ) : (
            <span className="flex min-h-9 flex-1 items-center">
              <NeedsCategory />
            </span>
          )}
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => onChangeCategory(tx)}
              className="min-h-9 rounded-md px-2.5 text-[13px] font-semibold text-accent hover:bg-accent-soft"
            >
              Change
            </button>
            <button
              type="button"
              disabled={!category}
              onClick={() => {
                setLeaving("right");
                setTimeout(() => onApprove(tx), 180);
              }}
              className="ml-1 inline-flex min-h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-semibold text-accent-contrast hover:bg-accent-hover disabled:opacity-40"
            >
              <Check size={14} strokeWidth={2.25} aria-hidden />
              Approve
            </button>
            <ActionMenu
              label={`More actions for ${tx.payee}`}
              trigger={<MoreHorizontal size={18} strokeWidth={1.75} />}
              triggerClassName="ml-0.5 inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-paper-sunken hover:text-ink"
              items={[
                { id: "split", label: "Split", icon: <Split size={16} strokeWidth={1.75} />, onSelect: () => onSplit?.(tx), disabled: !onSplit },
                { id: "transfer", label: "Mark as transfer", icon: <ArrowLeftRight size={16} strokeWidth={1.75} />, onSelect: () => onMarkTransfer?.(tx), disabled: !onMarkTransfer },
              ]}
            />
          </div>
        </div>

        {transferSuggestion && onLinkTransfer && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-1 text-[13px]">
            <ArrowLeftRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 text-ink-2">
              Looks like a transfer with <span className="text-ink">{transferSuggestion.accountName}</span> ({formatDay(transferSuggestion.pairDate)})
            </span>
            <button type="button" onClick={() => onLinkTransfer(tx)} className="min-h-9 shrink-0 rounded-xs px-2.5 font-medium text-accent hover:bg-paper-sunken">
              Link
            </button>
          </div>
        )}

        {explain && s && (
          <div className="mt-2 rounded-lg bg-paper-sunken px-3 py-2 text-[13px] text-ink-2" style={{ animation: "hb-pop 160ms var(--ease-out-quart)" }}>
            <p>{s.explanation}</p>
            <p className="mt-1 text-[12px] text-ink-3">
              {METHOD_LABEL[s.method] ?? s.method} · confidence <span className="num">{pct(s.confidence)}</span> · bank text <span className="font-mono text-[11px]">{tx.rawDescription}</span>
            </p>
          </div>
        )}
        {!s && tx.alternatives && tx.alternatives.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
            <span>Maybe:</span>
            {tx.alternatives.map((a) => (
              <span key={a.categoryId}>
                {categoryLabel(a.categoryName)} <span className="num">{pct(a.confidence)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
