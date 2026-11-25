/**
 * `pnpm import:ynab` — §10 Phase 1 full import from YNAB (read-only API).
 *
 *   pnpm import:ynab                       # YNAB_PLAN_NAME (else the default or only plan) via YNAB_TOKEN
 *   pnpm import:ynab --plan "Other Plan"
 *   pnpm import:ynab --from-file fixtures/private/ynab/plan.json
 *   pnpm import:ynab --replace             # wipe YNAB-sourced facts first, then import
 *
 * Fetches `GET /plans/{id}` once, saves the raw response to fixtures/private/ynab/plan.json
 * (gitignored; the engine's golden test reads it), imports everything in one DB transaction,
 * recomputes the budget and prints a Homebase-vs-YNAB parity summary. Prints no secrets.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultRecompute } from "../budget";
import { createLogger } from "../log";
import { createRuntime } from "../runtime";
import { loadConnections } from "../secrets";
import { fetchPlanExport, resolvePlanId } from "../ynab/fetch";
import { importYnabPlan } from "../ynab/import";
import { formatParity, ynabParity } from "../ynab/parity";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const PRIVATE_PLAN_PATH = resolve(REPO_ROOT, "fixtures/private/ynab/plan.json");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      "from-file": { type: "string" },
      replace: { type: "boolean", default: false },
      "no-save": { type: "boolean", default: false },
    },
  });
  const log = createLogger({ name: "import-ynab", level: process.env.LOG_LEVEL ?? "warn" });
  const rt = createRuntime({ name: "import-ynab", logger: log });
  const { ctx } = rt;
  try {
    let raw: unknown;
    if (values["from-file"]) {
      raw = JSON.parse(await readFile(resolve(process.cwd(), values["from-file"]), "utf8"));
      console.log(`Importing from ${values["from-file"]}`);
    } else {
      const token = ctx.env.YNAB_TOKEN ?? (await loadConnections({ db: ctx.db, log, keyring: ctx.keyring, env: ctx.env }, "ynab"))[0]?.creds.token;
      if (!token) throw new Error("Set YNAB_TOKEN (or store a YNAB token in Settings) or pass --from-file");
      const planName = values.plan ?? ctx.env.YNAB_PLAN_NAME;
      const plan = await resolvePlanId(token, planName);
      console.log(`Fetching YNAB plan "${plan.name}" (one request)…`);
      raw = await fetchPlanExport(token, plan.id);
      if (!values["no-save"]) {
        await mkdir(dirname(PRIVATE_PLAN_PATH), { recursive: true });
        await writeFile(PRIVATE_PLAN_PATH, JSON.stringify(raw), { mode: 0o600 });
        await chmod(PRIVATE_PLAN_PATH, 0o600);
        console.log(`Saved raw export to ${PRIVATE_PLAN_PATH} (gitignored), server_knowledge=${(raw as { data: { server_knowledge: number } }).data.server_knowledge}`);
      }
    }

    const s = await importYnabPlan(ctx.db, raw, { now: new Date(), replace: values.replace });
    console.log(
      [
        `Imported plan "${s.planName}" (server_knowledge ${s.serverKnowledge ?? "?"})`,
        `  accounts ${s.accounts}, groups ${s.groups}, categories ${s.categories}, payees ${s.payees}`,
        `  transactions +${s.transactions.inserted} ~${s.transactions.updated} merged ${s.transactions.mergedIntoSynced} deleted ${s.transactions.deleted}, split lines ${s.splits}`,
        `  scheduled ${s.scheduled}, month assignments ${s.assignments}, targets ${s.targets}`,
      ].join("\n"),
    );
    if (s.warnings.length) console.log(`Warnings (${s.warnings.length}):\n  ${s.warnings.slice(0, 30).join("\n  ")}`);

    await defaultRecompute(ctx.db, { fromMonth: null });
    const report = await ynabParity(ctx.db, raw);
    console.log(formatParity(report));
    console.log("Engine-only parity on the saved export: pnpm --filter @homebase/engine golden");
    process.exitCode = report.rows.length ? 2 : 0;
  } finally {
    await rt.close();
  }
}

main().catch((e) => {
  console.error(`import:ynab failed: ${(e as Error).message}`);
  process.exit(1);
});
