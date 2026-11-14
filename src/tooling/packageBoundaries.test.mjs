import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkPackageBoundaries } from '../../scripts/check-package-boundaries.mjs';

async function fixture(
  t,
  entry = 'export const value = 1;',
  extraExports = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-boundaries-'));
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

async function localBoundaries(root, groups) {
  await writeFile(
    path.join(root, 'scripts/package-boundaries.local.json'),
    JSON.stringify(groups),
  );
}

test('an absent local boundary file leaves the main ownership rules unchanged', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 1 },
  ]);
  await writeFile(path.join(root, 'helper.js'), 'export const value = 2;');
  await writeFile(
    path.join(root, 'entry.js'),
    "export { value } from './helper.js';",
  );
  await assert.rejects(checkPackageBoundaries(root), /unowned module.*helper/);
});

test('local boundaries append modules and exports to an existing group', async (t) => {
  const root = await fixture(t, "export { value } from './helper.js';", {
    './extra': './extra.js',
  });
  await writeFile(path.join(root, 'helper.js'), 'export const value = 2;');
  await writeFile(path.join(root, 'extra.js'), 'export const extra = 3;');
  await localBoundaries(root, {
    feature: { modules: ['helper.js', 'extra.js'], exports: ['./extra'] },
  });
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 2, modules: 3 },
  ]);
});

test('local boundaries can add a new Node group', async (t) => {
  const root = await fixture(t, undefined, {
    './extra': { node: './extra.js' },
  });
  await writeFile(
    path.join(root, 'extra.js'),
    "export { basename } from 'node:path';",
  );
  await localBoundaries(root, {
    extra: {
      runtime: 'node',
      exports: ['./extra'],
      modules: ['extra.js'],
      external: [],
    },
  });
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 1 },
    { name: 'extra', exports: 1, modules: 1 },
  ]);
});

test('local boundaries append external dependencies without replacing the main ones', async (t) => {
  const root = await fixture(
    t,
    "import 'first'; import 'second'; export const value = 1;",
  );
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      exports: { './feature': './entry.js' },
      dependencies: { first: '*', second: '*' },
    }),
  );
  await writeFile(
    path.join(root, 'scripts/package-boundaries.json'),
    JSON.stringify({
      feature: {
        exports: ['./feature'],
        modules: ['entry.js'],
        external: ['first'],
      },
    }),
  );
  await localBoundaries(root, { feature: { external: ['second'] } });
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 1 },
  ]);
});

test('invalid local boundary data identifies the file and group', async (t) => {
  const root = await fixture(t);
  for (const groups of [
    null,
    [],
    { feature: null },
    { feature: [] },
    { feature: { modules: 'helper.js' } },
    { feature: { exports: [1] } },
    { feature: { unknown: [] } },
    { feature: { runtime: 'worker' } },
  ]) {
    await localBoundaries(root, groups);
    await assert.rejects(
      checkPackageBoundaries(root),
      /Invalid local package boundaries.*package-boundaries.local.json/,
    );
  }
  await writeFile(
    path.join(root, 'scripts/package-boundaries.local.json'),
    '{',
  );
  await assert.rejects(
    checkPackageBoundaries(root),
    /Invalid local package boundaries.*package-boundaries.local.json/,
  );
});

test('local boundaries cannot change an existing runtime', async (t) => {
  const root = await fixture(t);
  await localBoundaries(root, { feature: { runtime: 'node' } });
  await assert.rejects(
    checkPackageBoundaries(root),
    /Local boundary runtime conflicts.*feature/,
  );
  await localBoundaries(root, { feature: { runtime: 'browser' } });
  assert.deepEqual(await checkPackageBoundaries(root), [
    { name: 'feature', exports: 1, modules: 1 },
  ]);
});

test('combined local boundaries retain the main validation rules', async (t) => {
  const root = await fixture(t);
  for (const [groups, message] of [
    [{ feature: { modules: ['../outside.js'] } }, /repository paths.*feature/],
    [
      { feature: { external: ['undeclared'] } },
      /declared dependency.*undeclared/,
    ],
    [{ feature: { exports: ['./feature'] } }, /exactly one boundary group/],
    [{ extra: {} }, /Invalid local package boundaries/],
    [
      { extra: { exports: [], modules: [], external: [] } },
      /Invalid package boundary.*extra/,
    ],
  ]) {
    await localBoundaries(root, groups);
    await assert.rejects(checkPackageBoundaries(root), message);
  }
});

test('local boundary read errors are not treated as an absent file', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'scripts/package-boundaries.local.json'));
  await assert.rejects(checkPackageBoundaries(root), /EISDIR/);
});
