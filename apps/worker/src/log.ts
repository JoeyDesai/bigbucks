/** pino logger. Secret-looking keys are redacted wherever they appear (depth ≤ 2); never log credentials. */
import { pino, type Logger } from "pino";

export type { Logger };

const SECRET_KEYS = ["accessUrl", "access_url", "token", "apiKey", "api_key", "privateKey", "private_key", "privateKeyPem", "password", "secret", "authorization", "credentials", "encCredentials", "enc_credentials", "encValue", "keys", "auth", "p256dh"];
export const REDACT_PATHS = [...SECRET_KEYS, ...SECRET_KEYS.map((k) => `*.${k}`), ...SECRET_KEYS.map((k) => `*.*.${k}`)];

export function createLogger(opts: { level?: string; name?: string } = {}): Logger {
  return pino({
    name: opts.name ?? "homebase-worker",
    level: opts.level ?? process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** A logger that discards everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}

/** Error → loggable object without stack noise for expected connector errors. */
export function errInfo(e: unknown): { message: string; code?: string; name?: string } {
  if (e instanceof Error) {
    const out: { message: string; code?: string; name?: string } = { message: e.message, name: e.name };
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") out.code = code;
    return out;
  }
  return { message: String(e) };
}
