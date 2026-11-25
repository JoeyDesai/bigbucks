/**
 * `pnpm --filter @homebase/worker import:ynab-snapshot --file <path> [--month 2026-10-01] [--dry-run]
 *    [--card "<payment category name>=<accountId>"]… [--on-budget <accountId>]… [--force]`
 *
 * Seeds groups, categories (icons, hidden), targets, this month's assignments and opening balances
 * from a YNAB web-UI snapshot JSON (see src/ynab/snapshot.ts). One transaction, idempotent; `--dry-run`
 * prints the summary and rolls back. A later full `import:ynab` adopts these categories and replaces
 * the opening balances with YNAB's real history.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Month } from "@homebase/shared";
import { createLogger } from "../log";
import { createRuntime } from "../runtime";
import { formatSnapshotSummary, importUiSnapshot, parseCardFlags } from "../ynab/snapshot";

const USAGE =
  'usage: import:ynab-snapshot --file <path> [--month YYYY-MM-01] [--dry-run] [--card "<category>=<accountId>"]... [--on-budget <accountId>]... [--force]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      month: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      card: { type: "string", multiple: true },
      "on-budget": { type: "string", multiple: true },
      force: { type: "boolean", default: false },
    },
  });
  if (!values.file || (values.month && !/^\d{4}-\d{2}-01$/.test(values.month))) {
    console.error(USAGE);
    process.exit(64);
  }
  const cards = parseCardFlags(values.card);
  // pnpm runs the script in apps/worker; resolve relative paths against where the command was typed.
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), values.file);
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));

  const log = createLogger({ name: "import-ynab-snapshot", level: process.env.LOG_LEVEL ?? "warn" });
  const rt = createRuntime({ name: "import-ynab-snapshot", logger: log });
  try {
    const s = await importUiSnapshot(rt.ctx.db, raw, {
      file: values.file,
      ...(values.month ? { month: values.month as Month } : {}),
      cards,
      onBudget: values["on-budget"] ?? [],
      dryRun: values["dry-run"],
      force: values.force,
      now: rt.ctx.now(),
    });
    console.log(formatSnapshotSummary(s));
  } finally {
    await rt.close();
  }
}

main().catch((e) => {
  console.error(`import:ynab-snapshot failed: ${(e as Error).message}`);
  process.exit(1);
});
