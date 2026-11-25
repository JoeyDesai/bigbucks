/**
 * `pnpm --filter @homebase/worker ynab:delta` — import YNAB changes since the stored server_knowledge
 * (same as the daily ynab.delta job). `--from-file <path>` applies a saved delta response instead.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultRecompute } from "../budget";
import { runYnabDelta } from "../jobs/ynabDelta";
import { createLogger } from "../log";
import { createRuntime } from "../runtime";
import { importYnabPlan } from "../ynab/import";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "from-file": { type: "string" } } });
  const log = createLogger({ name: "ynab-delta", level: process.env.LOG_LEVEL ?? "warn" });
  const rt = createRuntime({ name: "ynab-delta", logger: log });
  try {
    if (values["from-file"]) {
      const raw = JSON.parse(await readFile(resolve(process.cwd(), values["from-file"]), "utf8"));
      const s = await importYnabPlan(rt.ctx.db, raw, { now: new Date(), delta: true });
      await defaultRecompute(rt.ctx.db, { fromMonth: s.earliestMonth });
      console.log(`Applied delta: +${s.transactions.inserted} ~${s.transactions.updated} merged ${s.transactions.mergedIntoSynced} deleted ${s.transactions.deleted}; server_knowledge ${s.serverKnowledge ?? "?"}`);
      return;
    }
    const r = await runYnabDelta(rt.ctx, { trigger: "cli" });
    if (r.skipped) console.log(`Skipped: ${r.skipped}`);
    else {
      const t = r.summary!.transactions;
      console.log(`Applied delta: +${t.inserted} ~${t.updated} merged ${t.mergedIntoSynced} deleted ${t.deleted}; server_knowledge ${r.serverKnowledge ?? "?"}`);
    }
  } finally {
    await rt.close();
  }
}

main().catch((e) => {
  console.error(`ynab:delta failed: ${(e as Error).message}`);
  process.exit(1);
});
