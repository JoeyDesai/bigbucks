/**
 * `pnpm --filter @homebase/worker simplefin:claim` — claim a SimpleFIN setup token (the one allowed
 * write: a body-less POST) and store the resulting Access URL encrypted in `connections`.
 *
 * The token is read from stdin (paste, then Enter) or SIMPLEFIN_SETUP_TOKEN, never from argv (shell
 * history). Prints only the connection id and the last 4 characters shown in Settings.
 *   --connection <id>   replace the credentials of an existing SimpleFIN connection
 *   --label <text>      label for a new connection
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { claimSetupToken } from "@homebase/connectors";
import { createLogger } from "../log";
import { createRuntime } from "../runtime";
import { displayLast4, storeCredentials } from "../secrets";

async function readToken(): Promise<string> {
  const fromEnv = process.env.SIMPLEFIN_SETUP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  process.stderr.write("Paste the SimpleFIN setup token and press Enter: ");
  const line = (await rl.question("")).trim();
  rl.close();
  return line;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { connection: { type: "string" }, label: { type: "string" } } });
  const token = await readToken();
  if (!token) throw new Error("no setup token given");
  const log = createLogger({ name: "simplefin-claim", level: "warn" });
  const rt = createRuntime({ name: "simplefin-claim", logger: log });
  try {
    const accessUrl = await claimSetupToken(token);
    const id = await storeCredentials({ db: rt.ctx.db, keyring: rt.ctx.keyring }, "simplefin", { accessUrl }, { ...(values.connection ? { connectionId: values.connection } : {}), ...(values.label ? { label: values.label } : {}) });
    const l4 = displayLast4("simplefin", { accessUrl });
    console.log(`Stored SimpleFIN access (encrypted) on connection ${id}${l4 ? ` (…${l4})` : ""}. The first sync runs at the next 05:17/11:17/17:17/23:17 slot, or use sync:now simplefin.`);
  } finally {
    await rt.close();
  }
}

main().catch((e) => {
  console.error(`simplefin:claim failed: ${(e as Error).message}`);
  process.exit(1);
});
