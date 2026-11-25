/**
 * The agent ends each reply with <speech>…</speech> (spoken summary for TTS, §11.5). This
 * extractor sits on the text stream: it passes visible text through, holds back anything that
 * might be the start of the tag, and captures the speech content separately.
 */
import { SPEECH_CLOSE, SPEECH_OPEN } from "./systemPrompt";

export class SpeechExtractor {
  private buf = "";
  private inSpeech = false;
  private done = false;
  speech = "";

  /** Feed a text delta; returns the part safe to show now. */
  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      if (!this.inSpeech) {
        const i = this.buf.indexOf(SPEECH_OPEN);
        if (i !== -1) {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + SPEECH_OPEN.length);
          this.inSpeech = true;
          continue;
        }
        const keep = partialSuffix(this.buf, SPEECH_OPEN);
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      const j = this.buf.indexOf(SPEECH_CLOSE);
      if (j !== -1) {
        this.speech += this.buf.slice(0, j);
        this.buf = this.buf.slice(j + SPEECH_CLOSE.length);
        this.inSpeech = false;
        this.done = true;
        continue;
      }
      const keep = partialSuffix(this.buf, SPEECH_CLOSE);
      this.speech += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  /** End of a text stream: release any held-back text. */
  flush(): string {
    const rest = this.buf;
    this.buf = "";
    if (this.inSpeech) {
      this.speech += rest;
      this.inSpeech = false;
      this.done = true;
      return "";
    }
    return rest;
  }

  get hasSpeech(): boolean {
    return this.done && this.speech.trim() !== "";
  }
}

/** Length of the longest suffix of s that is a proper prefix of tag. */
function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/** Fallback spoken text from markdown: strip formatting, keep the first two sentences. */
export function speechFromMarkdown(md: string, maxChars = 300): string {
  const text = md
    .split("\n")
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*[-:| ]+$/.test(l))
    .join(" ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = text.match(/.*?[.!?](?=\s|$)/g) ?? [text];
  let out = sentences.slice(0, 2).map((x) => x.trim()).join(" ").trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trimEnd()}…`;
  return out;
}

/** Final cleanup of model-provided speech: no markdown. */
export function cleanSpeech(s: string): string {
  return speechFromMarkdown(s, 400);
}
