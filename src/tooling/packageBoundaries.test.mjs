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
