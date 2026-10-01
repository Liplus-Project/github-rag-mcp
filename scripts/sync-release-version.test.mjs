import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseReleaseTag, syncReleaseVersion } from './sync-release-version.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const names = ['package.json', 'package-lock.json', 'manifest.json', 'server.json'];
const baseline = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(join(scripts, '../mcp-server', name))])));
const snapshot = async directory => Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(join(directory, name))])));
const unchanged = async (directory, saved) => {
  const current = await snapshot(directory);
  for (const name of names) assert.deepEqual(current[name], saved[name]);
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'github-rag-release-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(root).startsWith('github-rag-release-'));
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, 'mcp-server');
  await mkdir(directory);
  for (const name of names) await writeFile(join(directory, name), baseline[name]);
  return { root, directory };
}

for (const tag of ['v0.12.0', 'v1.2.3-rc.1', 'v2.0.0+build.007', 'v3.4.5-beta.0+ci.9']) {
  test(`synchronizes ${tag}, preserves unrelated metadata and replays without writes`, async t => {
    const { directory } = await fixture(t);
    const registryPath = join(directory, 'server.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.packages.push({ registryType: 'npm', identifier: 'synthetic-extra', version: '0.9.0' });
    registry.packages.push({ registryType: 'oci', identifier: 'synthetic-image', version: '5.6.7' });
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n');
    const original = await snapshot(directory);
    await assert.rejects(syncReleaseVersion({ tag, packageDir: directory, checkOnly: true }), /version mismatch/);
    await unchanged(directory, original);
    const result = await syncReleaseVersion({ tag, packageDir: directory });
    assert.equal(result.checkedFields, 7);
    const generated = await snapshot(directory);
    for (const name of names) {
      const expected = JSON.parse(original[name].toString('utf8'));
      expected.version = tag.slice(1);
      if (name === 'package-lock.json') expected.packages[''].version = tag.slice(1);
      if (name === 'server.json') for (const entry of expected.packages) if (entry.registryType === 'npm') entry.version = tag.slice(1);
      assert.deepEqual(JSON.parse(generated[name].toString('utf8')), expected);
    }
    assert.equal((await syncReleaseVersion({ tag, packageDir: directory })).changedFiles, 0);
    await syncReleaseVersion({ tag, packageDir: directory, checkOnly: true });
    await unchanged(directory, generated);
    const wrong = JSON.parse(generated['server.json'].toString('utf8'));
    wrong.packages[1].version = '0.0.1';
    await writeFile(registryPath, JSON.stringify(wrong, null, 2) + '\n');
    const mismatched = await snapshot(directory);
    await assert.rejects(syncReleaseVersion({ tag, packageDir: directory, checkOnly: true }), /version mismatch/);
    await unchanged(directory, mismatched);
  });
}

test('rejects invalid release tags before writing metadata', async t => {
  const { directory } = await fixture(t);
  const original = await snapshot(directory);
  const invalid = ['0.12.0', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2', 'v1.2.3-01', 'v1.2.3-alpha..1', 'v1.2.3+', 'v1.2.3\n', 'v1.2.3 snow', 'v1.2.3-rc.１'];
  for (const tag of invalid) {
    assert.throws(() => parseReleaseTag(tag), /canonical SemVer/);
    await assert.rejects(syncReleaseVersion({ tag, packageDir: directory }), /canonical SemVer/);
    await unchanged(directory, original);
  }
});

for (const fault of ['no-npm-entry', 'missing-lock-root', 'missing-version', 'invalid-json', 'missing-file']) {
  test(`rejects ${fault} before modifying any metadata`, async t => {
    const { directory } = await fixture(t);
    if (fault === 'no-npm-entry') {
      const registry = JSON.parse(baseline['server.json'].toString('utf8'));
      registry.packages = [];
      await writeFile(join(directory, 'server.json'), JSON.stringify(registry));
    } else if (fault === 'missing-lock-root') {
      const lock = JSON.parse(baseline['package-lock.json'].toString('utf8'));
      delete lock.packages[''];
      await writeFile(join(directory, 'package-lock.json'), JSON.stringify(lock));
    } else if (fault === 'missing-version') {
      const manifest = JSON.parse(baseline['manifest.json'].toString('utf8'));
      delete manifest.version;
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    } else if (fault === 'invalid-json') await writeFile(join(directory, 'manifest.json'), '{');
    else await rm(join(directory, 'server.json'));
    const saved = Object.fromEntries(await Promise.all(names.filter(name => fault !== 'missing-file' || name !== 'server.json').map(async name => [name, await readFile(join(directory, name))])));
    await assert.rejects(syncReleaseVersion({ tag: 'v0.12.0', packageDir: directory }));
    for (const [name, bytes] of Object.entries(saved)) assert.deepEqual(await readFile(join(directory, name)), bytes);
  });
}

test('CD relative command resolves default directory and both jobs run it before output', async t => {
  const { root, directory } = await fixture(t);
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/sync-release-version.mjs'), await readFile(join(scripts, 'sync-release-version.mjs')));
  const child = spawnSync(process.execPath, ['../scripts/sync-release-version.mjs', 'v0.12.0'], {
    cwd: directory, encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: dirname(process.execPath) },
  });
  assert.equal(child.status, 0, child.stderr);
  await syncReleaseVersion({ tag: 'v0.12.0', packageDir: directory, checkOnly: true });
  const workflow = await readFile(join(scripts, '../.github/workflows/cd.yml'), 'utf8');
  const bundle = workflow.slice(workflow.indexOf('  build-mcpb:'), workflow.indexOf('  attach-mcpb:'));
  const npm = workflow.slice(workflow.indexOf('  npm-publish:'));
  const command = 'run: node ../scripts/sync-release-version.mjs "$TAG_NAME"';
  for (const [job, output] of [[bundle, 'npx mcpb pack'], [npm, 'npm publish --access public']]) {
    assert.ok(job.includes(command));
    assert.ok(job.includes('working-directory: mcp-server'));
    assert.ok(job.includes('TAG_NAME: ${{ github.event.release.tag_name }}'));
    assert.ok(job.indexOf(command) < job.indexOf(output));
  }
});
