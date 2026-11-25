import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Re-seed the e2e database with the deterministic demo data before every run (spec §14: e2e on seeded
 * data). Every Playwright run gets its own database via E2E_DATABASE_URL (default `homebase_web_e2e`),
 * created if missing. It refuses any name that doesn't end in `_e2e` or `_test`, so the shared dev
 * database (`homebase`) is never wiped. Two runs at once must use two different E2E_DATABASE_URLs.
 */
export default function globalSetup() {
  const url = new URL(process.env.E2E_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_web_e2e");
  const name = url.pathname.slice(1);
  if (!/(_e2e|_test)$/.test(name)) throw new Error(`refusing to reseed "${name}": e2e databases must end in _e2e or _test`);
  try {
    execFileSync("createdb", ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username), name], { stdio: "ignore" });
  } catch {
    // already exists
  }
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const env = { ...process.env, DATABASE_URL: url.toString() };
  execFileSync("pnpm", ["--filter", "@homebase/db", "migrate"], { cwd: root, env, stdio: "ignore" });
  execFileSync("pnpm", ["--filter", "@homebase/db", "seed:demo", "--", "--force"], { cwd: root, env, stdio: "ignore" });
}
