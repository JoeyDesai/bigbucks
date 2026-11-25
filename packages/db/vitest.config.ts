import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The DB suite resets a shared database; run files one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
