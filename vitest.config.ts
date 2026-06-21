import { defineConfig } from "vitest/config";

// Node project: binding-independent unit tests (slice 1).
// Workers-pool D1 integration tests live in *.workers.test.ts and run under
// vitest.workers.config.ts (a separate workerd pool). They are excluded here so
// the node run does not try to resolve the `cloudflare:test` virtual module.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/*.workers.test.ts"],
  },
});
