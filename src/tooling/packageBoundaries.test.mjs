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
  {
    dependencies,
    groups = {
      feature: { exports: ['./feature'], modules: ['entry.js'], external: [] },
    },
  } = {},
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
      dependencies,
    }),
  );
  await writeFile(
    path.join(root, 'scripts/package-boundaries.json'),
    JSON.stringify(groups),
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

test('only the local option reads the local boundary file', async (t) => {
  const root = await fixture(t, "export { value } from './helper.js';");
  await writeFile(path.join(root, 'helper.js'), 'export const value = 2;');
  await localBoundaries(root, { feature: { modules: ['helper.js'] } });
  await assert.rejects(checkPackageBoundaries(root), /unowned module.*helper/);
  assert.deepEqual(await checkPackageBoundaries(root, { local: true }), [
    { name: 'feature', exports: 1, modules: 2 },
  ]);
});

test('local modules extend an existing Node group without changing its runtime', async (t) => {
  const root = await fixture(
    t,
    "export { basename } from './helper.js';",
    { './feature': { node: './entry.js' } },
    {
      groups: {
        feature: {
          runtime: 'node',
          exports: ['./feature'],
          modules: ['entry.js'],
          external: [],
        },
      },
    },
  );
  await writeFile(
    path.join(root, 'helper.js'),
    "export { basename } from 'node:path';",
  );
  await localBoundaries(root, { feature: { modules: ['helper.js'] } });
  assert.deepEqual(await checkPackageBoundaries(root, { local: true }), [
    { name: 'feature', exports: 1, modules: 2 },
  ]);
});

test('a module added locally to one group stays unowned by another', async (t) => {
  const root = await fixture(
    t,
    "export { value } from './helper.js';",
    { './other': './other.js' },
    {
      groups: {
        feature: {
          exports: ['./feature'],
          modules: ['entry.js'],
          external: [],
        },
        other: { exports: ['./other'], modules: ['other.js'], external: [] },
      },
    },
  );
  await writeFile(path.join(root, 'helper.js'), 'export const value = 2;');
  await writeFile(
    path.join(root, 'other.js'),
    "export { value } from './helper.js';",
  );
  await localBoundaries(root, { feature: { modules: ['helper.js'] } });
  await assert.rejects(
    checkPackageBoundaries(root, { local: true }),
    /Package boundary other imports an unowned module: helper\.js/,
  );
});

test('local boundaries append external dependencies without replacing the main ones', async (t) => {
  const root = await fixture(
    t,
    "import 'first'; import 'second'; export const value = 1;",
    {},
    {
      dependencies: { first: '*', second: '*' },
      groups: {
        feature: {
          exports: ['./feature'],
          modules: ['entry.js'],
          external: ['first'],
        },
      },
    },
  );
  await localBoundaries(root, { feature: { external: ['second'] } });
  assert.deepEqual(await checkPackageBoundaries(root, { local: true }), [
    { name: 'feature', exports: 1, modules: 1 },
  ]);
});

test('invalid local boundary data names the file and the group', async (t) => {
  const root = await fixture(
    t,
    undefined,
    {},
    {
      dependencies: { first: '*' },
    },
  );
  const prefix =
    'Invalid local package boundaries in scripts/package-boundaries.local.json: ';
  for (const [groups, detail] of [
    [null, 'expected an object of group names'],
    [[], 'expected an object of group names'],
    [{ extra: { modules: [] } }, 'unknown group extra'],
    [{ feature: null }, 'feature'],
    [{ feature: [] }, 'feature'],
    [{ feature: { modules: 'helper.js' } }, 'feature'],
    [{ feature: { exports: ['./feature'] } }, 'feature'],
    [{ feature: { runtime: 'browser' } }, 'feature'],
  ]) {
    await localBoundaries(root, groups);
    await assert.rejects(checkPackageBoundaries(root, { local: true }), {
      message: prefix + detail,
    });
  }
  await localBoundaries(root, { feature: { external: [['first']] } });
  await assert.rejects(checkPackageBoundaries(root, { local: true }), {
    message: 'Boundary external must be a dependency name: feature',
  });
  await writeFile(
    path.join(root, 'scripts/package-boundaries.local.json'),
    '{',
  );
  await assert.rejects(
    checkPackageBoundaries(root, { local: true }),
    /package-boundaries\.local\.json: Expected property name/,
  );
});

test('the local option fails when the local boundary file is missing', async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    checkPackageBoundaries(root, { local: true }),
    /ENOENT.*package-boundaries\.local\.json/,
  );
});
