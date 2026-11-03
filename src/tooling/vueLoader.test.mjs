import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cachedVueModule,
  compileVueModule,
  ownCacheDirectory,
  vueCacheDirectory,
  vueCacheKey,
} from '../../build/vueLoader.js';

const SOURCE =
  '<script setup>\nconst label = "Hi";\n</script>\n<template><b>{{ label }}</b></template>\n';
const FILE = '/virtual/Greeting.vue';

test('a component compiles once and later processes read the cached module', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-vue-cache-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const compiled = cachedVueModule(SOURCE, FILE, directory);
  assert.equal(compiled, compileVueModule(SOURCE, FILE));
  const entries = readdirSync(directory);
  assert.deepEqual(entries, [`${vueCacheKey(SOURCE, FILE)}.mjs`]);
  // A cached entry is returned as stored, without compiling again.
  writeFileSync(path.join(directory, entries[0]), 'export default "cached";');
  assert.equal(
    cachedVueModule(SOURCE, FILE, directory),
    'export default "cached";',
  );
});

test('an edited component or another path is a new cache entry', () => {
  const key = vueCacheKey(SOURCE, FILE);
  assert.notEqual(vueCacheKey(`${SOURCE}\n`, FILE), key);
  assert.notEqual(vueCacheKey(SOURCE, '/virtual/Other.vue'), key);
  assert.equal(vueCacheKey(SOURCE, FILE), key);
});

test('GEV_VUE_CACHE=0 compiles every time; otherwise the cache sits in a per-user directory', () => {
  assert.equal(vueCacheDirectory({ GEV_VUE_CACHE: '0' }), null);
  if (process.platform !== 'win32') {
    const directory = vueCacheDirectory({});
    assert.equal(path.dirname(directory), tmpdir());
    assert.match(path.basename(directory), /^gev-vue-sfc-/);
  }
  // Windows temp directories may be shared, so the cache lives in the
  // user's profile, or not at all.
  assert.equal(
    vueCacheDirectory(
      { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
      'win32',
    ),
    path.join('C:\\Users\\a\\AppData\\Local', 'gev-vue-sfc'),
  );
  assert.equal(vueCacheDirectory({}, 'win32'), null);
  assert.equal(
    cachedVueModule(SOURCE, FILE, null),
    compileVueModule(SOURCE, FILE),
  );
});

test('a cache directory that cannot be written still returns the compiled module', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-vue-cache-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A file where the cache directory should be makes every write fail.
  const blocked = path.join(directory, 'blocked');
  writeFileSync(blocked, '');
  assert.equal(
    cachedVueModule(SOURCE, FILE, blocked),
    compileVueModule(SOURCE, FILE),
  );
});

test(
  'a cache directory others can write to, or a link to one, is never read',
  {
    skip: process.platform === 'win32',
  },
  (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gev-vue-cache-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const shared = path.join(root, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    // A module planted where the cache would look must not run.
    writeFileSync(
      path.join(shared, `${vueCacheKey(SOURCE, FILE)}.mjs`),
      'export default "planted";',
    );
    assert.equal(ownCacheDirectory(shared), false);
    assert.equal(
      cachedVueModule(SOURCE, FILE, shared),
      compileVueModule(SOURCE, FILE),
    );
    const own = path.join(root, 'own');
    mkdirSync(own, { mode: 0o700 });
    const link = path.join(root, 'link');
    symlinkSync(own, link);
    assert.equal(ownCacheDirectory(link), false);
    assert.equal(ownCacheDirectory(own), true);
  },
);
