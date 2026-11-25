/**
 * `pnpm --filter @homebase/worker sync:now <simplefin|mercury|coinbase|rentcast|ynab>` — run one
 * provider sync in this process. Counts as a manual sync: SimpleFIN's 2/day manual cap and 6/day total
 * budget, and RentCast's 5/month cap, still apply.
 */
import { parseArgs } from "node:util";
import { MANUAL_SYNC_PROVIDERS, type ManualSyncProvider } from "../jobs/definitions";
import { runManualSync } from "../jobs/handlers";
import { createLogger } from "../log";
import { createRuntime } from "../runtime";

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const provider = positionals[0] as ManualSyncProvider | undefined;
  if (!provider || !(MANUAL_SYNC_PROVIDERS as readonly string[]).includes(provider)) {
    console.error(`usage: sync:now <${MANUAL_SYNC_PROVIDERS.join("|")}>`);
    process.exit(64);
  }
  const log = createLogger({ name: "sync-now", level: process.env.LOG_LEVEL ?? "info" });
  const rt = createRuntime({ name: "sync-now", logger: log });
  try {
    const result = await runManualSync(rt.ctx, provider, "manual");
    console.log(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } finally {
    await rt.close();
  }
}

main().catch((e) => {
  console.error(`sync:now failed: ${(e as Error).message}`);
  process.exit(1);
});
