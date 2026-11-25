import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB suites reset a shared database (homebase_worker_test); run files one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
