#!/usr/bin/env node
// Guards against drift between the Worker `search` tool param schema and the
// client proxy's static mirror of it.
//
//   source of truth : src/mcp.ts            (zod object passed to this.server.tool("search", ...))
//   mirror          : mcp-server/server/index.js  (TOOLS[0].inputSchema.properties)
//
// Why this exists (gh#157 / gh#159): the proxy answers tools/list from a
// hand-maintained static schema (it does NOT forward to the Worker, to keep
// startup auth-free / network-free). A param added to the Worker but forgotten
// in the proxy is silently stripped by MCP clients (additionalProperties:false)
// and never reaches the Worker — exactly how graph_expand shipped broken in
// v0.9.0. This check turns that "forgot to sync" procedure into a CI gate: the
// build fails instead of shipping a stale schema.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = join(repoRoot, "src", "mcp.ts");
const proxyPath = join(repoRoot, "mcp-server", "server", "index.js");

/** Return the substring of `text` from the first `startMarker` to the next `endMarker`. */
function region(text, startMarker, endMarker, label) {
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`drift-check: start marker not found (${label}): ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`drift-check: end marker not found (${label}): ${endMarker}`);
  return text.slice(start, end);
}

// Worker: zod object is the 3rd arg of this.server.tool("search", "<desc>", { ... }, handler).
// Top-level param keys are 8-space-indented `<name>: z`. Bounded from the tool
// name to the `async ({` handler so other zod objects in the file are excluded.
function workerParams(text) {
  const toolIdx = text.indexOf('"search"');
  if (toolIdx === -1) throw new Error("drift-check: `\"search\"` tool not found in Worker (src/mcp.ts)");
  const schema = region(text.slice(toolIdx), "{", "async ({", "worker search schema");
  return new Set([...schema.matchAll(/^ {8}(\w+): z\b/gm)].map((m) => m[1]));
}

// Proxy: TOOLS[0].inputSchema.properties — top-level keys are 8-space-indented
// `<name>: {`. Bounded from `properties: {` to the sibling `annotations:`.
function proxyParams(text) {
  const props = region(text, "properties: {", "annotations:", "proxy search schema");
  return new Set([...props.matchAll(/^ {8}(\w+): \{/gm)].map((m) => m[1]));
}

const worker = workerParams(readFileSync(workerPath, "utf8"));
const proxy = proxyParams(readFileSync(proxyPath, "utf8"));

// Extractor sanity guard: a structural change could make a regex match nothing,
// turning the comparison into a meaningless empty==empty pass. Refuse that.
for (const [label, set] of [["worker", worker], ["proxy", proxy]]) {
  if (set.size < 5 || !set.has("query") || !set.has("repo")) {
    console.error(
      `drift-check: ${label} param extraction looks wrong ` +
        `(got ${set.size}: ${[...set].join(", ") || "<none>"}). ` +
        "The source structure likely changed — update scripts/check-schema-drift.mjs.",
    );
    process.exit(2);
  }
}

const missingInProxy = [...worker].filter((k) => !proxy.has(k));
const extraInProxy = [...proxy].filter((k) => !worker.has(k));

if (missingInProxy.length || extraInProxy.length) {
  console.error("drift-check: proxy search schema is out of sync with the Worker.");
  if (missingInProxy.length)
    console.error(
      "  missing in proxy (add to mcp-server/server/index.js TOOLS search inputSchema.properties): " +
        missingInProxy.join(", "),
    );
  if (extraInProxy.length)
    console.error(
      "  extra in proxy (not present in Worker src/mcp.ts search schema): " + extraInProxy.join(", "),
    );
  process.exit(1);
}

console.log(
  `drift-check OK: proxy mirrors Worker search params (${worker.size}): ` +
    `${[...worker].sort().join(", ")}`,
);
