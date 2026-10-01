#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const FILES = ['package.json', 'package-lock.json', 'manifest.json', 'server.json'];
const CORE = '(0|[1-9][0-9]*)';
const TAG_PATTERN = new RegExp(`^v${CORE}\\.${CORE}\\.${CORE}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);
const DEFAULT_PACKAGE_DIR = fileURLToPath(new URL('../mcp-server/', import.meta.url));

export function parseReleaseTag(tag) {
  const match = typeof tag === 'string' ? TAG_PATTERN.exec(tag) : null;
  if (!match || match[0] !== tag || (match[4] && match[4].split('.').some(part => /^0[0-9]+$/.test(part)))) {
    throw new Error('Release tag must be v-prefixed canonical SemVer');
  }
  return tag.slice(1);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function versionPaths(name, data) {
  if (!object(data) || typeof data.version !== 'string') throw new Error(`Invalid release metadata: ${name}`);
  const paths = [['version']];
  if (name === 'package-lock.json') {
    if (!object(data.packages) || !object(data.packages['']) || typeof data.packages[''].version !== 'string') {
      throw new Error('Invalid package-lock root version');
    }
    paths.push(['packages', '', 'version']);
  }
  if (name === 'server.json') {
    if (!Array.isArray(data.packages)) throw new Error('Invalid registry packages');
    const npm = data.packages.flatMap((entry, index) => object(entry) && entry.registryType === 'npm' ? [index] : []);
    if (!npm.length || npm.some(index => typeof data.packages[index].version !== 'string')) {
      throw new Error('Registry metadata must contain versioned npm entries');
    }
    for (const index of npm) paths.push(['packages', index, 'version']);
  }
  return paths;
}

function get(data, path) { return path.reduce((value, key) => value[key], data); }
function set(data, path, value) {
  const parent = path.slice(0, -1).reduce((current, key) => current[key], data);
  parent[path.at(-1)] = value;
}

async function load(packageDir) {
  const records = [];
  for (const name of FILES) {
    let text, data;
    try {
      text = await readFile(resolve(packageDir, name), 'utf8');
      data = JSON.parse(text);
    } catch { throw new Error(`Cannot read release metadata: ${name}`); }
    records.push({ name, text, data, paths: versionPaths(name, data) });
  }
  return records;
}

function assertVersion(records, version) {
  for (const record of records) {
    for (const path of record.paths) {
      if (get(record.data, path) !== version) throw new Error(`Release version mismatch: ${record.name}:${JSON.stringify(path)}`);
    }
  }
}

export async function syncReleaseVersion({ tag, packageDir = DEFAULT_PACKAGE_DIR, checkOnly = false }) {
  const version = parseReleaseTag(tag);
  const records = await load(packageDir);
  if (checkOnly) {
    assertVersion(records, version);
    return { version, checkedFields: records.reduce((count, record) => count + record.paths.length, 0), changedFiles: 0 };
  }

  // Validate every input and prepare every change before writing any file.
  const planned = records.map(record => {
    const next = structuredClone(record.data);
    for (const path of record.paths) set(next, path, version);
    const restored = structuredClone(next);
    for (const path of record.paths) set(restored, path, get(record.data, path));
    if (!isDeepStrictEqual(restored, record.data)) throw new Error('Unexpected change outside release version fields');
    return { ...record, next, output: JSON.stringify(next, null, 2) + '\n' };
  });
  let changedFiles = 0;
  for (const record of planned) {
    if (record.output === record.text) continue;
    await writeFile(resolve(packageDir, record.name), record.output, 'utf8');
    changedFiles++;
  }

  // Re-read on-disk metadata; a packaging job must stop on any disagreement.
  const written = await load(packageDir);
  assertVersion(written, version);
  for (let index = 0; index < planned.length; index++) {
    if (!isDeepStrictEqual(written[index].data, planned[index].next)) throw new Error('Release metadata write verification failed');
  }
  return { version, checkedFields: written.reduce((count, record) => count + record.paths.length, 0), changedFiles };
}

async function main(args) {
  let tag, packageDir = DEFAULT_PACKAGE_DIR, checkOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--check' && !checkOnly) checkOnly = true;
    else if (arg === '--package-dir' && index + 1 < args.length) packageDir = resolve(args[++index]);
    else if (!tag && !arg.startsWith('--')) tag = arg;
    else throw new Error('Usage: sync-release-version.mjs <v-semver-tag> [--check] [--package-dir directory]');
  }
  const result = await syncReleaseVersion({ tag, packageDir, checkOnly });
  console.log(`Release metadata ${checkOnly ? 'verified' : 'synchronized'}: ${result.version}; ${result.checkedFields} fields; ${result.changedFiles} changed files`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
