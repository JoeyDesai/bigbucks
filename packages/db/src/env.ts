import { z } from "zod";

export const DEV_DATABASE_URL = "postgres://homebase@localhost:54329/homebase";

const base64Key = z
  .string()
  .trim()
  .refine((s) => Buffer.from(s, "base64").length === 32, "must be 32 bytes, base64-encoded (openssl rand -base64 32)");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL")
      .optional(),
    /** Current AES-256-GCM master key for stored credentials (§4.6). Required in production. */
    HOMEBASE_MASTER_KEY: base64Key.optional(),
    /** Key id written into every ciphertext; bump it when rotating keys. */
    HOMEBASE_MASTER_KEY_ID: z.coerce.number().int().min(1).max(255).default(1),
    /** Retired keys still accepted for decryption during rotation: "id:base64,id:base64". */
    HOMEBASE_PREVIOUS_MASTER_KEYS: z.string().optional(),
    /** Password for the read-only AI role; when unset the role is NOLOGIN. */
    HOMEBASE_RO_PASSWORD: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (!env.DATABASE_URL) ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "required in production" });
    if (!env.HOMEBASE_MASTER_KEY) ctx.addIssue({ code: "custom", path: ["HOMEBASE_MASTER_KEY"], message: "required in production" });
  })
  .transform((env) => ({ ...env, DATABASE_URL: env.DATABASE_URL ?? DEV_DATABASE_URL }));

export type Env = z.output<typeof EnvSchema>;

/** Parse and validate an env source; empty strings count as unset. Throws with every problem listed. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${problems}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** process.env, validated once. */
export function env(): Env {
  cached ??= parseEnv();
  return cached;
}
