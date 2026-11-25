/**
 * `pnpm --filter @homebase/worker setup:household --admin <tailscale login> --name <display name>
 *   [--accent <accent>] [--member <login> --member-name <name> [--member-accent <accent>]]`
 *   — first-run setup for a fresh server database.
 *
 * Idempotent: creates the Household and business entities and the system categories (Ready to
 * Assign, Uncategorized, card payment categories), and upserts the given users by Tailscale login.
 * Existing users keep their PINs; role and display name are updated. Accents (blue | pink | green |
 * purple | orange | teal): an explicit flag always wins; otherwise a user without one gets the default
 * (admin blue, member pink) and an existing accent is kept.
 */
import { parseArgs } from "node:util";
import { USER_ACCENTS, isUserAccent, type UserAccent } from "@homebase/shared";
import { upsertHouseholdUsers, type HouseholdPerson } from "../household";
import { BUSINESS_ENTITY, HOUSEHOLD_ENTITY, ensureEntity } from "../ingest/accounts";
import { createLogger } from "../log";
import { createRuntime } from "../runtime";
import { ensureSystemCategories } from "../ynab/import";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      admin: { type: "string" },
      name: { type: "string" },
      accent: { type: "string" },
      member: { type: "string" },
      "member-name": { type: "string" },
      "member-accent": { type: "string" },
    },
  });
  const badAccent = [values.accent, values["member-accent"]].some((a) => a !== undefined && !isUserAccent(a));
  if (!values.admin || !values.name || (values.member && !values["member-name"]) || badAccent) {
    console.error(`usage: setup:household --admin <login> --name <name> [--accent <a>] [--member <login> --member-name <name> [--member-accent <a>]]  (accents: ${USER_ACCENTS.join(", ")})`);
    process.exit(64);
  }
  const people: HouseholdPerson[] = [{ login: values.admin, name: values.name, role: "admin", ...(values.accent ? { accent: values.accent as UserAccent } : {}) }];
  if (values.member) people.push({ login: values.member, name: values["member-name"]!, role: "member", ...(values["member-accent"] ? { accent: values["member-accent"] as UserAccent } : {}) });

  const log = createLogger({ name: "setup-household", level: process.env.LOG_LEVEL ?? "info" });
  const rt = createRuntime({ name: "setup-household", logger: log });
  try {
    await rt.ctx.db.transaction(async (tx) => {
      await ensureEntity(tx, HOUSEHOLD_ENTITY);
      await ensureEntity(tx, BUSINESS_ENTITY);
      await ensureSystemCategories(tx);
      await upsertHouseholdUsers(tx, people);
    });
    console.log(`household ready: ${people.map((p) => `${p.name} (${p.role})`).join(", ")}`);
  } finally {
    await rt.close();
  }
}

main().catch((e) => {
  console.error(`setup:household failed: ${(e as Error).message}`);
  process.exit(1);
});
