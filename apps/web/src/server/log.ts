import "server-only";
import pino from "pino";
import { env } from "./env";

/** Structured logs (spec §15 Observability). Never log passwords, tokens or full transaction data. */
export const log = pino({
  level: env().LOG_LEVEL,
  base: { app: "web" },
  redact: { paths: ["pin", "token", "*.pin", "*.token", "headers.cookie"], remove: true },
});
