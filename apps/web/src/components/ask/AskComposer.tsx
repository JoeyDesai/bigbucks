"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square, Volume2, VolumeX } from "lucide-react";
import { cx } from "@/lib/cx";
import { MicButton, type Recording } from "./MicButton";

export interface AskComposerProps {
  onSend: (text: string) => void;
  onRecorded: (rec: Recording) => void;
  onMicError?: (message: string) => void;
  speak: boolean;
  onToggleSpeak: () => void;
  disabled?: boolean;
  /** Controlled draft (e.g. a transcript dropped in by the mic). Uncontrolled when omitted. */
  value?: string;
  onValueChange?: (v: string) => void;
  /** "Deep analysis" toggle (uses the deep model). Hidden when undefined. */
  deep?: boolean;
  onToggleDeep?: () => void;
  /** A reply is streaming: Send becomes Stop. */
  busy?: boolean;
  onStop?: () => void;
  /** Audio is being transcribed. */
  transcribing?: boolean;
  placeholder?: string;
}

/** Chat composer: auto-growing textarea, hold-to-talk mic, speak-replies and deep-analysis toggles, send/stop. */
export function AskComposer({ onSend, onRecorded, onMicError, speak, onToggleSpeak, disabled, value, onValueChange, deep, onToggleDeep, busy, onStop, transcribing, placeholder }: AskComposerProps) {
  const [own, setOwn] = useState("");
  const text = value ?? own;
  const setText = (v: string) => (onValueChange ? onValueChange(v) : setOwn(v));
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = text ? `${Math.min(el.scrollHeight, 160)}px` : "";
  }, [text]);

  const send = () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    onSend(t);
    setText("");
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className="border-t border-rule bg-paper px-3 pb-2.5 pt-2 lg:px-0"
    >
      {onToggleDeep && (
        <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px]">
          <label className={cx("inline-flex min-h-8 cursor-pointer items-center gap-2 select-none", deep ? "text-ink" : "text-ink-3 hover:text-ink-2")}>
            <input type="checkbox" checked={!!deep} onChange={onToggleDeep} className="h-3.5 w-3.5 accent-[var(--ink)]" disabled={disabled} />
            Deep analysis
            <span className="text-ink-3">{deep ? "slower, about 2× the cost" : ""}</span>
          </label>
          {transcribing && (
            <span className="text-ink-3" role="status">
              Transcribing…
            </span>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={onToggleSpeak}
          aria-pressed={speak}
          aria-label={speak ? "Speak replies: on" : "Speak replies: off"}
          title={speak ? "Speak replies: on" : "Speak replies: off"}
          className={cx("inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm", speak ? "text-ink" : "text-ink-3 hover:text-ink")}
        >
          {speak ? <Volume2 size={19} strokeWidth={1.6} /> : <VolumeX size={19} strokeWidth={1.6} />}
        </button>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Ask a question</span>
          <textarea
            ref={ref}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={transcribing ? "Transcribing…" : (placeholder ?? "Ask about your money")}
            className="block min-h-11 w-full resize-none rounded-sm border border-rule-strong bg-paper-raised px-3 py-2.5 text-[15px] leading-snug outline-none placeholder:text-ink-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-60"
          />
        </label>
        <MicButton onRecorded={onRecorded} onError={onMicError} disabled={disabled || busy || transcribing} />
        {busy && onStop ? (
          <button type="button" onClick={onStop} aria-label="Stop" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-rule-strong text-ink">
            <Square size={14} strokeWidth={2} fill="currentColor" />
          </button>
        ) : (
          <button type="submit" disabled={disabled || busy || !text.trim()} aria-label="Send" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-contrast disabled:opacity-30">
            <ArrowUp size={19} strokeWidth={2} />
          </button>
        )}
      </div>
    </form>
  );
}
