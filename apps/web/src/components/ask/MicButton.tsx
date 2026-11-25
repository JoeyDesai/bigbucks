"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Mic } from "lucide-react";
import { cx } from "@/lib/cx";

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export interface MicButtonProps {
  /** Called with the finished recording (POST it to /api/stt). */
  onRecorded: (rec: Recording) => void;
  onError?: (message: string) => void;
  /** Recordings shorter than this are discarded as accidental taps. */
  minDurationMs?: number;
  maxDurationMs?: number;
  disabled?: boolean;
  className?: string;
}

/** Prefer audio/mp4 (iOS Safari), then webm/opus. Exported for tests. */
export function pickMimeType(isSupported: (t: string) => boolean): string | undefined {
  return ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((t) => isSupported(t));
}

type Phase = "idle" | "starting" | "recording";

/**
 * Hold-to-talk: press and hold (pointer) or hold Space/Enter (keyboard) to record with
 * MediaRecorder; release to stop and emit a Blob. No Web Speech API (broken in iOS home-screen
 * apps, spec §11.5).
 */
export function MicButton({ onRecorded, onError, minDurationMs = 350, maxDurationMs = 60_000, disabled, className }: MicButtonProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const wantStop = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => cleanup(), []);

  function cleanup() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
  }

  async function start() {
    if (disabled || phase !== "idle") return;
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError?.("This browser can't record audio.");
      return;
    }
    wantStop.current = false;
    setPhase("starting");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = s;
      const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(s, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      r.onstop = () => {
        const durationMs = Date.now() - startedAt.current;
        const type = r.mimeType || mimeType || "audio/webm";
        cleanup();
        setPhase("idle");
        setElapsed(0);
        if (durationMs < minDurationMs) return;
        onRecorded({ blob: new Blob(chunks.current, { type }), mimeType: type, durationMs });
      };
      recorder.current = r;
      startedAt.current = Date.now();
      r.start(250);
      setPhase("recording");
      timer.current = setInterval(() => {
        const ms = Date.now() - startedAt.current;
        setElapsed(ms);
        if (ms >= maxDurationMs) stop();
      }, 100);
      if (wantStop.current) stop();
    } catch (err) {
      cleanup();
      setPhase("idle");
      const name = (err as DOMException)?.name;
      onError?.(name === "NotAllowedError" ? "Microphone access is off. Allow it in Settings → Safari → Microphone." : "Couldn't start the microphone.");
    }
  }

  function stop() {
    wantStop.current = true;
    if (recorder.current && recorder.current.state === "recording") recorder.current.stop();
  }

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    void start();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      void start();
    }
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      stop();
    }
  };

  const recording = phase === "recording";
  const secs = Math.floor(elapsed / 1000);
  return (
    <div className={cx("relative inline-flex items-center", className)}>
      {recording && (
        <span className="num pointer-events-none absolute right-full mr-2 whitespace-nowrap text-[12px] text-neg" aria-live="off">
          0:{String(secs).padStart(2, "0")}
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        aria-label={recording ? "Recording. Release to send" : "Hold to talk"}
        aria-pressed={recording}
        onPointerDown={onPointerDown}
        onPointerUp={stop}
        onPointerCancel={stop}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        style={recording ? { animation: "hb-pulse-ring 1.1s ease-out infinite" } : undefined}
        className={cx(
          "inline-flex h-11 w-11 touch-none select-none items-center justify-center rounded-full border transition-colors [-webkit-touch-callout:none]",
          recording ? "border-neg bg-neg text-paper" : "border-rule-strong text-ink-2 hover:border-accent hover:text-ink",
          phase === "starting" && "opacity-70",
          disabled && "opacity-40",
        )}
      >
        <Mic size={18} strokeWidth={1.75} aria-hidden />
      </button>
      <span className="sr-only" aria-live="polite">
        {recording ? "Recording" : ""}
      </span>
    </div>
  );
}
