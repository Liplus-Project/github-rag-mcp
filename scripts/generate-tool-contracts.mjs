#!/usr/bin/env node
// Regenerate bridge JSON from the exact Worker Zod contracts. No Worker bindings.
import { readFileSync, writeFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { z } from 'zod';
async function load(name) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const js = transpileModule(source, { compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 } }).outputText.replace(/from ["']zod["']/g, `from ${JSON.stringify(import.meta.resolve('zod'))}`);
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}
const memory = await load('memory-contract');
const search = await load('search-contract');
const save = (name, data) => writeFileSync(new URL(`../mcp-server/server/${name}.json`, import.meta.url), JSON.stringify(data, null, 2) + '\n');
save('memory-tools', { instructions: memory.MEMORY_INSTRUCTIONS, tools: Object.entries(memory.memorySchemas).map(([name, schema]) => ({ name, description: memory.memoryDescriptions[name], inputSchema: z.toJSONSchema(schema, { io: 'input' }), outputSchema: z.toJSONSchema(memory.memoryResultSchema), annotations: { readOnlyHint: name === 'memory_history', destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
save('search-schema', { inputSchema: z.toJSONSchema(search.searchInputSchema, { io: 'input' }), outputSchema: z.toJSONSchema(search.searchOutputSchema) });
