#!/usr/bin/env node
// Guards against drift between the Worker `search` tool param schema and the
// client proxy's static mirror of it.
//
//   source of truth : src/mcp.ts             (zod object passed to this.server.tool("search", ...))
//   mirror          : mcp-server/server/tools.js  (TOOLS[0].inputSchema.properties)
//
// Why this exists (gh#157 / gh#159): the proxy answers tools/list from a
// hand-maintained static schema (it does NOT forward to the Worker, to keep
// startup auth-free / network-free). A param added to the Worker but forgotten
// in the proxy is silently stripped by MCP clients (additionalProperties:false)
// and never reaches the Worker — exactly how graph_expand shipped broken in
// v0.9.0. This check turns that "forgot to sync" procedure into a CI gate: the
// build fails instead of shipping a stale schema.
//
// Two axes are compared (gh#181): param NAMES and, for enum params, their
// VALUES. Name-only comparison let `type: "wiki_doc"` exist on the Worker while
// the proxy enum omitted it — clients validate against the proxy schema, so the
// value was rejected before any request left the client.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = join(repoRoot, "src", "mcp.ts");
const proxyPath = join(repoRoot, "mcp-server", "server", "tools.js");

/** Return the substring of `text` from the first `startMarker` to the next `endMarker`. */
function region(text, startMarker, endMarker, label) {
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`drift-check: start marker not found (${label}): ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`drift-check: end marker not found (${label}): ${endMarker}`);
  return text.slice(start, end);
}

/** Extract the string literals of the first `[ ... ]` list in `block`, if any. */
function enumValues(block) {
  const open = block.indexOf("[");
  if (open === -1) return null;
  const close = block.indexOf("]", open);
  if (close === -1) return null;
  const list = block.slice(open + 1, close);
  const values = [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return values.length > 0 ? values : null;
}

/**
 * Split a schema region into per-param blocks keyed by param name.
 * `headerRe` must be a global, multiline regex whose first capture group is the
 * param name; each block runs from its header to the next header (or the end).
 */
function paramBlocks(schema, headerRe) {
  const heads = [...schema.matchAll(headerRe)];
  const blocks = new Map();
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i].index;
    const to = i + 1 < heads.length ? heads[i + 1].index : schema.length;
    blocks.set(heads[i][1], schema.slice(from, to));
  }
  return blocks;
}

// Worker: zod object is the 3rd arg of this.server.tool("search", "<desc>", { ... }, handler).
// Top-level param keys are 8-space-indented `<name>: z`. Bounded from the tool
// name to the `async ({` handler so other zod objects in the file are excluded.
// Enum values come from the `.enum([...])` call inside each param's block.
function workerParams(text) {
  const toolIdx = text.indexOf('"search"');
  if (toolIdx === -1) throw new Error("drift-check: `\"search\"` tool not found in Worker (src/mcp.ts)");
  const schema = region(text.slice(toolIdx), "{", "async ({", "worker search schema");
  const blocks = paramBlocks(schema, /^ {8}(\w+): z\b/gm);
  const enums = new Map();
  for (const [name, block] of blocks) {
    const enumIdx = block.indexOf(".enum(");
    if (enumIdx === -1) continue;
    const values = enumValues(block.slice(enumIdx));
    if (values) enums.set(name, values);
  }
  return { names: new Set(blocks.keys()), enums };
}

// Proxy: TOOLS[0].inputSchema.properties — top-level keys are 8-space-indented
// `<name>: {`. Bounded from `properties: {` to the sibling `annotations:`.
// Enum values come from the `enum: [...]` key inside each param's block.
function proxyParams(text) {
  const props = region(text, "properties: {", "annotations:", "proxy search schema");
  const blocks = paramBlocks(props, /^ {8}(\w+): \{/gm);
  const enums = new Map();
  for (const [name, block] of blocks) {
    const enumIdx = block.indexOf("enum: [");
    if (enumIdx === -1) continue;
    const values = enumValues(block.slice(enumIdx));
    if (values) enums.set(name, values);
  }
  return { names: new Set(blocks.keys()), enums };
}

const worker = workerParams(readFileSync(workerPath, "utf8"));
const proxy = proxyParams(readFileSync(proxyPath, "utf8"));

// Extractor sanity guard: a structural change could make a regex match nothing,
// turning the comparison into a meaningless empty==empty pass. Refuse that.
// The enum floor is the same guard on the value axis — `type` is the param this
// check exists for, and a zero-enum extraction would silently pass every value.
for (const [label, side] of [["worker", worker], ["proxy", proxy]]) {
  if (side.names.size < 5 || !side.names.has("query") || !side.names.has("repo")) {
    console.error(
      `drift-check: ${label} param extraction looks wrong ` +
        `(got ${side.names.size}: ${[...side.names].join(", ") || "<none>"}). ` +
        "The source structure likely changed — update scripts/check-schema-drift.mjs.",
    );
    process.exit(2);
  }
  if (!side.enums.has("type") || side.enums.get("type").length < 5) {
    console.error(
      `drift-check: ${label} enum extraction looks wrong ` +
        `(type = ${JSON.stringify(side.enums.get("type") ?? null)}). ` +
        "The source structure likely changed — update scripts/check-schema-drift.mjs.",
    );
    process.exit(2);
  }
}

const problems = [];

const missingInProxy = [...worker.names].filter((k) => !proxy.names.has(k));
const extraInProxy = [...proxy.names].filter((k) => !worker.names.has(k));

if (missingInProxy.length)
  problems.push(
    "  missing in proxy (add to mcp-server/server/tools.js TOOLS search inputSchema.properties): " +
      missingInProxy.join(", "),
  );
if (extraInProxy.length)
  problems.push(
    "  extra in proxy (not present in Worker src/mcp.ts search schema): " + extraInProxy.join(", "),
  );

// Enum values: compared as sets, per param present on both sides. A param whose
// enum exists on one side only is a drift too — the client would either reject a
// value the Worker accepts, or accept one it rejects.
for (const name of [...worker.names].filter((k) => proxy.names.has(k))) {
  const w = worker.enums.get(name);
  const p = proxy.enums.get(name);
  if (!w && !p) continue;
  if (!w || !p) {
    problems.push(
      `  enum mismatch on "${name}": ${w ? "Worker" : "proxy"} declares an enum, ` +
        `${w ? "proxy" : "Worker"} does not.`,
    );
    continue;
  }
  const missing = w.filter((v) => !p.includes(v));
  const extra = p.filter((v) => !w.includes(v));
  if (missing.length)
    problems.push(`  enum values missing in proxy for "${name}": ${missing.join(", ")}`);
  if (extra.length)
    problems.push(`  enum values extra in proxy for "${name}": ${extra.join(", ")}`);
}

if (problems.length) {
  console.error("drift-check: proxy search schema is out of sync with the Worker.");
  for (const line of problems) console.error(line);
  process.exit(1);
}

console.log(
  `drift-check OK: proxy mirrors Worker search params (${worker.names.size}) ` +
    `and enum values (${[...worker.enums.keys()].sort().join(", ")}): ` +
    `${[...worker.names].sort().join(", ")}`,
);
