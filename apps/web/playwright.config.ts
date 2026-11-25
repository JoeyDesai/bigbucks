import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs (`pnpm --filter @homebase/web e2e`):
 * - E2E_DATABASE_URL: the run's own database, created and re-seeded by e2e/global-setup.ts before every
 *   run. Default `homebase_web_e2e`; the name must end in `_e2e` or `_test`. Agents or terminals running
 *   Playwright at the same time must each set a different one (e.g. `homebase_ask_e2e`), or they wipe
 *   each other's data mid-run.
 * - E2E_PORT: the app under test (default 3100). An already-running server is reused; it must have been
 *   started with the same DATABASE_URL and HOMEBASE_DEV_USER=alex@example.com.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_web_e2e";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  outputDir: "./test-results/e2e",
  // Flows mutate one shared database: run files serially.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "iphone-15", use: { ...devices["iPhone 15"], browserName: "chromium" } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `pnpm dev -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { HOMEBASE_DEV_USER: "alex@example.com", DATABASE_URL },
  },
});
