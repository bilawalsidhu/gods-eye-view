import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPackageBoundaries,
  writePackageBoundaries,
} from '../../scripts/check-package-boundaries.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(
  t,
  entry = 'export const value = 1;',
  extraExports = {},
) {
  const root = await mkdtemp(path.join(repoRoot, 'tmp_package_boundaries_'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'boundary-fixture',
      type: 'module',
      exports: { './feature': './entry.js', ...extraExports },
    }),
  );
  await writeFile(
    path.join(root, 'scripts/package-boundaries.json'),
    JSON.stringify({
      feature: { exports: ['./feature'], modules: ['entry.js'], external: [] },
    }),
  );
  await writeFile(path.join(root, 'entry.js'), entry);
  return root;
}

test('a declared browser export builds without running app setup', async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, 'vite.config.js'),
    "throw new Error('must not load app config');",
  );
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 1 },
  ]);
});

test('an unclassified package export fails the boundary gate', async (t) => {
  const root = await fixture(t, undefined, { './another': './another.js' });
  await assert.rejects(
    checkPackageBoundaries(root),
    /exactly one boundary group/,
  );
});

test('even an unused import of application code violates ownership', async (t) => {
  const root = await fixture(
    t,
    "import { app } from './startup.js'; export const value = 1;",
  );
  await writeFile(path.join(root, 'startup.js'), 'export const app = 2;');
  await assert.rejects(checkPackageBoundaries(root), /unowned module.*startup/);
});

test('Node builtins cannot enter a browser export', async (t) => {
  const root = await fixture(
    t,
    "import fs from 'node:fs'; export const value = fs;",
  );
  await assert.rejects(checkPackageBoundaries(root), /unowned module|browser/);
});

test('dynamic imports obey the same component ownership rule', async (t) => {
  const root = await fixture(
    t,
    "export const load = () => import('./startup.js');",
  );
  await writeFile(path.join(root, 'startup.js'), 'export const app = 2;');
  await assert.rejects(checkPackageBoundaries(root), /unowned module.*startup/);
});

test('a Node build export must be explicitly classified and scoped', async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'boundary-fixture',
      type: 'module',
      exports: { './feature': { node: './entry.js' } },
    }),
  );
  await writeFile(
    path.join(root, 'scripts/package-boundaries.json'),
    JSON.stringify({
      feature: {
        runtime: 'node',
        exports: ['./feature'],
        modules: ['entry.js'],
        external: [],
      },
    }),
  );
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 1 },
  ]);
  await writeFile(
    path.join(root, 'entry.js'),
    "import './startup.js'; export const value = 1;",
  );
  await writeFile(path.join(root, 'startup.js'), 'export const app = 2;');
  await assert.rejects(checkPackageBoundaries(root), /unowned module.*startup/);
});

test('a lifecycle owner cannot acquire a layer panel even through an unused import', async (t) => {
  const root = await fixture(
    t,
    "import './panel.js'; export class LayerLifecycle {}",
  );
  await writeFile(path.join(root, 'panel.js'), 'export class LayerPanel {}');
  await writeFile(
    path.join(root, 'scripts/package-boundaries.json'),
    JSON.stringify({
      'layer-lifecycle': {
        exports: ['./feature'],
        modules: ['entry.js'],
        external: [],
      },
    }),
  );
  await assert.rejects(checkPackageBoundaries(root), /unowned module.*panel/);
});

test('a module entry ending in a slash owns every file under that directory', async (t) => {
  const root = await fixture(
    t,
    "import { a } from './shared/a.js'; export const value = a;",
  );
  await mkdir(path.join(root, 'shared/nested'), { recursive: true });
  await writeFile(
    path.join(root, 'shared/a.js'),
    "export { b as a } from './nested/b.js';",
  );
  await writeFile(path.join(root, 'shared/nested/b.js'), 'export const b = 1;');
  await writeFile(
    path.join(root, 'scripts/package-boundaries.json'),
    JSON.stringify({
      feature: {
        exports: ['./feature'],
        modules: ['entry.js', 'shared/'],
        external: [],
      },
    }),
  );
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 3 },
  ]);
  // The prefix is a directory, not a file-name prefix: shared.js stays unowned.
  await writeFile(
    path.join(root, 'shared/nested/b.js'),
    "export { c as b } from '../../shared.js';",
  );
  await writeFile(path.join(root, 'shared.js'), 'export const c = 1;');
  await assert.rejects(
    checkPackageBoundaries(root),
    /unowned module.*shared\.js/,
  );
});

test('regeneration adds unowned modules, including unused and dynamic imports', async (t) => {
  const root = await fixture(
    t,
    "import { unused } from './unused.js'; export const load = () => import('./lazy.js');",
  );
  await writeFile(path.join(root, 'unused.js'), 'export const unused = 1;');
  await writeFile(path.join(root, 'lazy.js'), 'export const lazy = 2;');
  assert.deepEqual(await writePackageBoundaries(root), [
    { name: 'feature', added: ['lazy.js', 'unused.js'], removed: [] },
  ]);
  const manifest = JSON.parse(
    await readFile(path.join(root, 'scripts/package-boundaries.json'), 'utf8'),
  );
  assert.deepEqual(manifest.feature.modules, [
    'entry.js',
    'lazy.js',
    'unused.js',
  ]);
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 3 },
  ]);
});

test('regeneration removes unreached files without making the check reject stale entries', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'scripts/package-boundaries.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.feature.modules.push('stale.js');
  await writeFile(path.join(root, 'stale.js'), 'export const stale = 1;');
  await writeFile(file, JSON.stringify(manifest));
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 1 },
  ]);
  assert.deepEqual(await writePackageBoundaries(root), [
    { name: 'feature', added: [], removed: ['stale.js'] },
  ]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).feature.modules, [
    'entry.js',
  ]);
});

test('regeneration removes deleted entries and adds an unowned export entry', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'scripts/package-boundaries.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.feature.modules = ['deleted.js', 'deleted/'];
  await writeFile(file, JSON.stringify(manifest));
  assert.deepEqual(await writePackageBoundaries(root), [
    {
      name: 'feature',
      added: ['entry.js'],
      removed: ['deleted.js', 'deleted/'],
    },
  ]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).feature.modules, [
    'entry.js',
  ]);
});

test('regeneration keeps a directory only while it owns a reached module', async (t) => {
  const root = await fixture(
    t,
    "export { value } from './shared/nested/value.js'; export { other } from './shared.js';",
  );
  await mkdir(path.join(root, 'shared/nested'), { recursive: true });
  await writeFile(
    path.join(root, 'shared/nested/value.js'),
    'export const value = 1;',
  );
  await writeFile(path.join(root, 'shared.js'), 'export const other = 2;');
  const file = path.join(root, 'scripts/package-boundaries.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.feature.modules.push('shared/');
  await writeFile(file, JSON.stringify(manifest));
  assert.deepEqual(await writePackageBoundaries(root), [
    { name: 'feature', added: ['shared.js'], removed: [] },
  ]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).feature.modules, [
    'entry.js',
    'shared/',
    'shared.js',
  ]);
  await writeFile(
    path.join(root, 'entry.js'),
    "export { other } from './shared.js';",
  );
  assert.deepEqual(await writePackageBoundaries(root), [
    { name: 'feature', added: [], removed: ['shared/'] },
  ]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).feature.modules, [
    'entry.js',
    'shared.js',
  ]);
});

test('regeneration preserves kept entry order and all other manifest fields', async (t) => {
  const root = await fixture(
    t,
    "import './z.js'; import './b.js'; import './a.js'; export const value = 1;",
    { './build': { node: './build.js' } },
  );
  for (const name of ['z.js', 'b.js', 'a.js', 'build.js']) {
    await writeFile(path.join(root, name), 'export const value = 1;');
  }
  const file = path.join(root, 'scripts/package-boundaries.json');
  const manifest = {
    feature: {
      exports: ['./feature'],
      modules: ['z.js', 'entry.js'],
      external: [],
    },
    engineImportExceptions: [
      { file: 'entry.js', package: 'example', reason: 'Fixture exception.' },
    ],
    build: {
      runtime: 'node',
      exports: ['./build'],
      modules: ['build.js'],
      external: [],
    },
  };
  await writeFile(file, JSON.stringify(manifest));
  assert.deepEqual(await writePackageBoundaries(root), [
    { name: 'feature', added: ['a.js', 'b.js'], removed: [] },
  ]);
  manifest.feature.modules.push('a.js', 'b.js');
  const updated = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(updated, manifest);
  assert.deepEqual(Object.keys(updated), Object.keys(manifest));
});

test('a failed regeneration leaves the manifest unchanged', async (t) => {
  const root = await fixture(t, undefined, { './broken': './missing.js' });
  const file = path.join(root, 'scripts/package-boundaries.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.feature.modules = [];
  manifest.broken = { exports: ['./broken'], modules: [], external: [] };
  const original = JSON.stringify(manifest);
  await writeFile(file, original);
  await assert.rejects(writePackageBoundaries(root), /missing\.js/);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('the CLI reports changes and a second --write leaves the manifest untouched', async (t) => {
  const root = await fixture(t, "export { value } from './value.js';");
  await writeFile(path.join(root, 'value.js'), 'export const value = 1;');
  await writeFile(path.join(root, 'stale.js'), 'export const stale = 1;');
  const file = path.join(root, 'scripts/package-boundaries.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.feature.modules.push('stale.js');
  await writeFile(file, JSON.stringify(manifest));
  await mkdir(path.join(root, 'build'));
  for (const name of [
    'scripts/check-package-boundaries.mjs',
    'build/vueOptions.js',
  ]) {
    await copyFile(path.join(repoRoot, name), path.join(root, name));
  }
  const run = (args) =>
    execFileSync(
      process.execPath,
      ['scripts/check-package-boundaries.mjs', ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GOOGLE_MAPS_API_KEY: '', CESIUM_ION_TOKEN: '' },
      },
    );
  assert.equal(
    run(['--write']),
    'Updated feature: 1 added, 1 removed.\n  + value.js\n  - stale.js\n',
  );
  const first = await readFile(file, 'utf8');
  assert.ok(first.includes('"exports": ["./feature"]'));
  assert.ok(first.endsWith('\n'));
  assert.equal(run(['--write']), '');
  assert.equal(await readFile(file, 'utf8'), first);
  assert.equal(run([]), 'Checked feature: 1 exports, 2 owned modules.\n');

  let entry = "export { value } from './value.js';";
  for (let i = 0; i < 21; i++) {
    await writeFile(path.join(root, `extra${i}.js`), 'export const extra = 1;');
    entry += `\nimport './extra${i}.js';`;
  }
  await writeFile(path.join(root, 'entry.js'), entry);
  assert.equal(run(['--write']), 'Updated feature: 21 added, 0 removed.\n');
});
