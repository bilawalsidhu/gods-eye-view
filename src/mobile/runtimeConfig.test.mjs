import test from 'node:test';
import assert from 'node:assert/strict';
import { endpointSet, joinApi, resolveApiBase } from './runtimeConfig.js';
import { readApiBase, writeApiBase } from './keyStore.js';

/** In-memory stand-in for Capacitor Preferences ({get,set,remove} shape). */
function createStubStorage() {
  const values = new Map();
  return {
    get: async ({ key }) => ({
      value: values.has(key) ? values.get(key) : null,
    }),
    set: async ({ key, value }) => {
      values.set(key, String(value));
    },
    remove: async ({ key }) => {
      values.delete(key);
    },
  };
}

test('resolveApiBase returns empty string for same-origin', () => {
  assert.equal(resolveApiBase(''), '');
  assert.equal(resolveApiBase(undefined), '');
});

test('resolveApiBase trims the host base with no trailing slash', () => {
  assert.equal(resolveApiBase('https://home:4173/'), 'https://home:4173');
});

test('joinApi prefixes service paths with the base', () => {
  assert.equal(joinApi('', '/api/terrain/heights'), '/api/terrain/heights');
  assert.equal(
    joinApi('https://home:4173', '/api/terrain/heights'),
    'https://home:4173/api/terrain/heights',
  );
});

test('endpointSet returns all five service keys prefixed', () => {
  assert.deepEqual(endpointSet('https://home:4173'), {
    boundaries: 'https://home:4173/api/overpass',
    terrain: 'https://home:4173/api/terrain/heights',
    regional: 'https://home:4173/api/regional-brief',
    weather: 'https://home:4173/api/weather-effects',
    summary: 'https://home:4173/api/openai/hud-summary',
  });
});

test('keyStore round-trips the backend URL through injected storage', async () => {
  const storage = createStubStorage();
  assert.equal(await readApiBase(storage), '');
  await writeApiBase(storage, 'https://home:4173');
  assert.equal(await readApiBase(storage), 'https://home:4173');
});

test('keyStore rejects an evil backend URL to same-origin', async () => {
  const storage = createStubStorage();
  await writeApiBase(storage, 'https://home:4173');
  await writeApiBase(storage, 'http://localhost:9999/evil?.js');
  assert.equal(await readApiBase(storage), '');
});

test('keyStore reads fail closed when storage throws', async () => {
  const broken = {
    get: async () => {
      throw new Error('locked');
    },
  };
  assert.equal(await readApiBase(broken), '');
});
