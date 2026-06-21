// Ambient declaration of the vitest-pool-workers `cloudflare:test` virtual module,
// scoped to just what the *.workers.test.ts files use. Declared by hand (instead of
// `/// <reference types="@cloudflare/vitest-pool-workers/types" />`) so the worker's
// `tsc --noEmit` does not pull a newer @cloudflare/workers-types whose stricter AI
// binding types conflict with existing code (src/rerank.ts). D1Database is global
// via the worker's @cloudflare/workers-types.

interface TestD1Migration {
  name: string;
  queries: string[];
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB_FTS: D1Database;
    TEST_MIGRATIONS: TestD1Migration[];
  }
  export const env: ProvidedEnv;
  export function applyD1Migrations(
    db: D1Database,
    migrations: TestD1Migration[],
    migrationsTableName?: string,
  ): Promise<void>;
}
