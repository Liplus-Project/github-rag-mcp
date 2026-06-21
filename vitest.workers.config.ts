import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Workers-realistic pool: runs *.workers.test.ts inside workerd with a real local
// D1 (miniflare-backed SQLite) and the IssueStore Durable Object (SQLite-backed).
// The D1 migrations under ./migrations are read at config time and handed to the
// test via the TEST_MIGRATIONS binding, then applied with applyD1Migrations(). The
// DO is loaded from a minimal entry (src/test-do-entry.ts) that exports only
// IssueStore, so Vectorize / Workers AI (no local emulation) are never bound.
//
// vitest 4 wiring: cloudflareTest() is a Vite plugin (provides the `cloudflare:test`
// module + transforms); cloudflarePool() is the pool runner for `test.pool`.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const workersOptions = {
    main: "src/test-do-entry.ts",
    singleWorker: true,
    // One shared local D1 for the whole file, no per-test snapshotting. The
    // isolatedStorage snapshot/restore and bulk DELETE both corrupt FTS5
    // external-content shadow tables (SQLITE_CORRUPT_VTAB), so instead each test
    // scopes itself to its own repo via the queryFts repo filter.
    isolatedStorage: false,
    miniflare: {
      compatibilityDate: "2025-03-26",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB_FTS: "test-fts" },
      durableObjects: {
        ISSUE_STORE: { className: "IssueStore", useSQLite: true },
      },
      bindings: { TEST_MIGRATIONS: migrations },
    },
  };
  return {
    plugins: [cloudflareTest(workersOptions)],
    test: {
      include: ["src/**/*.workers.test.ts"],
      pool: cloudflarePool(workersOptions),
    },
  };
});
