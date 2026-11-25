import { describe, expect, it } from "vitest";
import { STT_MAX_BYTES, cleanTranscript, transcribe, type FetchFn } from "./stt";

function recorder(responses: (Response | Error)[]) {
  const calls: { url: string; form: FormData | null; headers: Headers }[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, form: init?.body instanceof FormData ? init.body : null, headers: new Headers(init?.headers) });
    const r = responses.shift();
    if (!r) throw new Error("no scripted response");
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}
const audio = (type: string, bytes = 2048) => new Blob([new Uint8Array(bytes)], { type });

describe("transcribe (whisper.cpp)", () => {
  it("posts multipart file + response_format=json to /inference and cleans the text", async () => {
    const { fetch, calls } = recorder([new Response(JSON.stringify({ text: " How much did we spend on groceries? [BLANK_AUDIO]" }), { status: 200 })]);
    const r = await transcribe(audio("audio/wav"), "audio/wav", { env: { WHISPER_URL: "http://127.0.0.1:8178/" }, fetch });
    expect(r).toEqual({ ok: true, text: "How much did we spend on groceries?", engine: "whisper" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8178/inference");
    expect(calls[0]!.form!.get("response_format")).toBe("json");
    const f = calls[0]!.form!.get("file") as File;
    expect(f.name).toBe("speech.wav");
  });

  it("defaults to host.internal:8178", async () => {
    const { fetch, calls } = recorder([new Response(JSON.stringify({ text: "hi" }))]);
    await transcribe(audio("audio/wav"), "audio/wav", { env: {}, fetch });
    expect(calls[0]!.url).toBe("http://host.internal:8178/inference");
  });

  it("explains the ffmpeg requirement when the server rejects iPhone audio/mp4", async () => {
    const { fetch, calls } = recorder([new Response("failed to read audio", { status: 500 })]);
    const r = await transcribe(audio("audio/mp4"), "audio/mp4", { env: {}, fetch });
    expect(r).toMatchObject({ ok: false, status: 415, code: "unsupported_format" });
    expect(!r.ok && r.error).toMatch(/--with-ffmpeg/);
    expect((calls[0]!.form!.get("file") as File).name).toBe("speech.m4a");
  });

  it("treats a JSON error body for non-WAV audio the same way", async () => {
    const { fetch } = recorder([new Response(JSON.stringify({ error: "failed to read WAV file" }), { status: 200 })]);
    const r = await transcribe(audio("audio/webm;codecs=opus"), "audio/webm;codecs=opus", { env: {}, fetch });
    expect(r).toMatchObject({ ok: false, code: "unsupported_format" });
  });

  it("falls back to OpenAI only when OPENAI_API_KEY is set", async () => {
    const down = () => recorder([new TypeError("fetch failed"), new Response(JSON.stringify({ text: "fallback text" }))]);
    const a = down();
    expect(await transcribe(audio("audio/mp4"), "audio/mp4", { env: {}, fetch: a.fetch })).toMatchObject({ ok: false, code: "unavailable" });
    expect(a.calls).toHaveLength(1);
    const b = down();
    const r = await transcribe(audio("audio/mp4"), "audio/mp4", { env: { OPENAI_API_KEY: "sk-test" }, fetch: b.fetch });
    expect(r).toEqual({ ok: true, text: "fallback text", engine: "openai" });
    expect(b.calls[1]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(b.calls[1]!.form!.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(b.calls[1]!.headers.get("authorization")).toBe("Bearer sk-test");
  });

  it("enforces size limits before calling anything", async () => {
    const { fetch, calls } = recorder([]);
    expect(await transcribe(audio("audio/wav", 0), "audio/wav", { env: {}, fetch })).toMatchObject({ ok: false, code: "empty", status: 400 });
    expect(await transcribe(audio("audio/wav", STT_MAX_BYTES + 1), "audio/wav", { env: {}, fetch })).toMatchObject({ ok: false, code: "too_large", status: 413 });
    expect(calls).toHaveLength(0);
  });
});

describe("cleanTranscript", () => {
  it("strips whisper markers", () => {
    expect(cleanTranscript("  (music) Fund   all underfunded categories. [SILENCE] ")).toBe("Fund all underfunded categories.");
  });
});
