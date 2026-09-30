#!/usr/bin/env node
// Compare canonical schemas and actual served schemas with every shipped bridge tool.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "src/memory-contract.test.ts"], {cwd: repoRoot, stdio: "inherit"});
