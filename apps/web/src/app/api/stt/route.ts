import { transcribe, STT_MAX_BYTES } from "@/server/ai/stt";
import { apiUser, json, sameOrigin } from "@/server/ai/http";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/stt — hold-to-talk audio → transcript (§11.5). Body: multipart `file` (+ optional
 * `mimeType`), or the raw audio with its Content-Type.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const auth = await apiUser();
  if (auth instanceof Response) return auth;
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > STT_MAX_BYTES + 64 * 1024) return json({ error: "too_large", message: "That recording is too long. Keep it under a minute." }, 413);

  let audio: Blob | null = null;
  let mime = "";
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const f = form.get("file");
      if (f instanceof Blob) audio = f;
      const m = form.get("mimeType");
      mime = typeof m === "string" && m ? m : (audio?.type ?? "");
    } else {
      audio = await req.blob();
      mime = ct;
    }
  } catch {
    return json({ error: "invalid", message: "Couldn't read the recording." }, 400);
  }
  if (!audio) return json({ error: "empty", message: "No audio was recorded." }, 400);

  const r = await transcribe(audio, mime, { env: { WHISPER_URL: process.env.WHISPER_URL, OPENAI_API_KEY: process.env.OPENAI_API_KEY } });
  if (!r.ok) {
    log.warn({ code: r.code, mime, bytes: audio.size }, "stt failed");
    return json({ error: r.code, message: r.error }, r.status);
  }
  return json({ text: r.text, engine: r.engine });
}
