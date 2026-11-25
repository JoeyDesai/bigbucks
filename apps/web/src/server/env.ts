import "server-only";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /** Dev-only identity bypass: a Tailscale login of a seeded user. Ignored unless NODE_ENV=development. */
  HOMEBASE_DEV_USER: z.email().optional(),
  /** Dev-only: a test password applied to every seeded user that has none, so the login flow can be exercised. */
  HOMEBASE_DEV_PASSWORD: z.string().min(6).optional(),
  /**
   * Public demo instance: every visitor is the sample household's admin and admin settings are read-only.
   * Only ever set on the demo container, which has its own database and no secrets.
   */
  HOMEBASE_DEMO: z.enum(["0", "1"]).default("0"),
  /** Where the sign-in page's "Try the demo" link goes; no link when unset. */
  HOMEBASE_DEMO_URL: z.url().optional(),
  HOMEBASE_TRUST_TAILSCALE_HEADERS: z.enum(["0", "1"]).default("0"),
  HOMEBASE_PUBLIC_HOST: z.string().optional(),
  HOSTNAME: z.string().optional(),
  /** Address header trust requires HOSTNAME to equal (a 127/8 alias other than 127.0.0.1; default 127.0.0.2). */
  HOMEBASE_LISTEN_HOST: z.string().optional(),
  /** Cloudflare Access team name (<team>.cloudflareaccess.com) and the app's audience tag; both or neither. */
  HOMEBASE_CF_ACCESS_TEAM: z.string().optional(),
  HOMEBASE_CF_ACCESS_AUD: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.message}`);
    cached = parsed.data;
  }
  return cached;
}
