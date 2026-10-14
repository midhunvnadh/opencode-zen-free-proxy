import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Nothing in the test path touches Bun's runtime API: server.ts and
    // opencode.ts are the only modules that do, and the suites replace
    // opencode.ts with a fake backend, so the suite runs on plain Node.
    environment: "node",
    restoreMocks: true,
  },
});
