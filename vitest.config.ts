import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: { WAYS_CLI: resolve("dist/cli.js") },
    testTimeout: 30_000,
    // Threads die with the parent process; forks would be reparented to
    // PID 1 and keep burning CPU if the runner dies early (SIGPIPE from
    // `| head`, tool timeouts, Ctrl-C). See src/check/check.ts.
    pool: "threads",
  },
});
