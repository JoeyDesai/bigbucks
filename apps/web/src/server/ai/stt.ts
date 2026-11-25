/**
 * Speech to text (§11.5): whisper.cpp server on the host (infra ADR "contracts" #6), optional OpenAI
 * fallback when OPENAI_API_KEY is set. No "server-only" import so the route logic is unit-tested.
 */
export const STT_MAX_BYTES = 10 * 1024 * 1024; // ~10 min of AAC; the mic caps recordings at 60 s
export const STT_TIMEOUT_MS = 30_000;
export const DEFAULT_WHISPER_URL = "http://host.internal:8178";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface SttEnv {
  WHISPER_URL?: string;
  OPENAI_API_KEY?: string;
}

export type SttResult = { ok: true; text: string; engine: "whisper" | "openai" } | { ok: false; status: number; error: string; code: "too_large" | "empty" | "unsupported_format" | "unavailable" | "failed" };

const EXT: Record<string, string> = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/flac": "flac", "audio/mp4": "m4a", "audio/aac": "m4a", "audio/x-m4a": "m4a", "audio/webm": "webm", "audio/ogg": "ogg" };

export function baseMime(t: string): string {
  return (t.split(";")[0] ?? "").trim().toLowerCase();
}
export function extensionFor(mime: string): string {
  return EXT[baseMime(mime)] ?? "bin";
}
/** whisper.cpp decodes these natively; anything else needs the server's --convert (ffmpeg). */
export function whisperNative(mime: string): boolean {
  return ["wav", "mp3", "flac"].includes(extensionFor(mime));
}

/** whisper output sometimes carries "[BLANK_AUDIO]" / "(music)" markers and leading spaces. */
export function cleanTranscript(t: string): string {
  return t
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]/gi, "")
    .replace(/\((music|silence|noise)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function whisper(audio: Blob, mime: string, env: SttEnv, fetchFn: FetchFn): Promise<SttResult> {
  const base = (env.WHISPER_URL?.trim() || DEFAULT_WHISPER_URL).replace(/\/+$/, "");
  const form = new FormData();
  form.append("file", new File([audio], `speech.${extensionFor(mime)}`, { type: baseMime(mime) || "application/octet-stream" }));
  form.append("response_format", "json");
  form.append("temperature", "0");
  let res: Response;
  try {
    res = await fetchFn(`${base}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(STT_TIMEOUT_MS) });
  } catch (e) {
    const timeout = (e as Error)?.name === "TimeoutError";
    return { ok: false, status: 503, code: "unavailable", error: timeout ? "Speech recognition timed out." : "The speech-to-text server isn't reachable." };
  }
  const body = await res.text();
  if (!res.ok) {
    if (!whisperNative(mime)) {
      return {
        ok: false,
        status: 415,
        code: "unsupported_format",
        error: `The speech server couldn't read ${baseMime(mime) || "this audio"}. iPhone records audio/mp4, which whisper-server only decodes when installed with ffmpeg (infra/scripts/install-whisper.sh --with-ffmpeg).`,
      };
    }
    return { ok: false, status: 502, code: "failed", error: `Speech recognition failed (${res.status}).` };
  }
  let text = "";
  try {
    const j = JSON.parse(body) as { text?: unknown; error?: unknown };
    if (typeof j.error === "string" && !j.text) {
      if (!whisperNative(mime)) return { ok: false, status: 415, code: "unsupported_format", error: `The speech server couldn't read ${baseMime(mime)}. Install whisper-server with ffmpeg (--with-ffmpeg) or record WAV.` };
      return { ok: false, status: 502, code: "failed", error: "Speech recognition failed." };
    }
    text = typeof j.text === "string" ? j.text : "";
  } catch {
    text = body; // response_format=text servers
  }
  return { ok: true, text: cleanTranscript(text), engine: "whisper" };
}

async function openai(audio: Blob, mime: string, key: string, fetchFn: FetchFn): Promise<SttResult> {
  const form = new FormData();
  form.append("file", new File([audio], `speech.${extensionFor(mime)}`, { type: baseMime(mime) || "application/octet-stream" }));
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("response_format", "json");
  try {
    const res = await fetchFn("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(STT_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: 502, code: "failed", error: `The fallback transcriber failed (${res.status}).` };
    const j = (await res.json()) as { text?: string };
    return { ok: true, text: cleanTranscript(j.text ?? ""), engine: "openai" };
  } catch {
    return { ok: false, status: 503, code: "unavailable", error: "The fallback transcriber isn't reachable." };
  }
}

export async function transcribe(audio: Blob, mimeType: string, o: { env: SttEnv; fetch?: FetchFn }): Promise<SttResult> {
  const fetchFn: FetchFn = o.fetch ?? ((u, i) => fetch(u, i));
  if (audio.size === 0) return { ok: false, status: 400, code: "empty", error: "No audio was recorded." };
  if (audio.size > STT_MAX_BYTES) return { ok: false, status: 413, code: "too_large", error: "That recording is too long. Keep it under a minute." };
  const mime = mimeType || audio.type || "application/octet-stream";
  const w = await whisper(audio, mime, o.env, fetchFn);
  if (w.ok) return w;
  const key = o.env.OPENAI_API_KEY?.trim();
  if (key && (w.code === "unavailable" || w.code === "unsupported_format" || w.code === "failed")) {
    const f = await openai(audio, mime, key, fetchFn);
    if (f.ok) return f;
  }
  return w;
}
