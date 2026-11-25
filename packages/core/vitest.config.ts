import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The suites reset and re-seed one shared database; run files one at a time.
    fileParallelism: false,
    globalSetup: ["./test/globalSetup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
