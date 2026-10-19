import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createApplicationKeyReader,
  createVaultKeyReader,
  loadDefaultVault,
} from './vaultKeys.js';

test('vault key reader returns stored keys and null otherwise', async () => {
  const getKey = createVaultKeyReader({
    readKey: async (id) => (id === 'A' ? 'secret-a' : null),
  });
  assert.equal(await getKey('A'), 'secret-a');
  assert.equal(await getKey('B'), null);
  assert.equal(await getKey(''), null);
  assert.equal(await getKey(null), null);
});

test('vault key reader fails closed on vault errors', async () => {
  const throwing = createVaultKeyReader({
    loadVault: async () => {
      throw new Error('nope');
    },
  });
  assert.equal(await throwing('A'), null);
  const broken = createVaultKeyReader({
    loadVault: async () => ({
      readKey: async () => {
        throw new Error('nope');
      },
    }),
  });
  assert.equal(await broken('A'), null);
  assert.equal(await createVaultKeyReader()('A'), null);
});

test('vault key reader blanks non-string values', async () => {
  const getKey = createVaultKeyReader({ readKey: async () => 42 });
  assert.equal(await getKey('A'), null);
});

test('loadDefaultVault returns null when nothing loads', async () => {
  assert.equal(
    await loadDefaultVault({ loadVaultStorage: async () => ({ store: null }) }),
    null,
  );
  assert.equal(
    await loadDefaultVault({
      loadVaultStorage: async () => {
        throw new Error('nope');
      },
    }),
    null,
  );
});

test('loadDefaultVault builds a vault from a store', async () => {
  const values = new Map([['K', 'v']]);
  const vault = await loadDefaultVault({
    loadVaultStorage: async () => ({
      store: {
        get: async ({ key }) => ({ value: values.get(key) ?? null }),
        set: async () => {},
        remove: async () => {},
      },
    }),
    createVault: ({ storage }) => ({
      readKey: async (id) => (await storage.get({ key: id }))?.value ?? null,
    }),
  });
  assert.equal(await vault.readKey('K'), 'v');
});

test('application key reader is a fail-closed function', async () => {
  const getKey = createApplicationKeyReader();
  assert.equal(typeof getKey, 'function');
});

test('resolveSceneKeys prefers vault tokens only when direct', async () => {
  const { resolveSceneKeys } = await import('./vaultKeys.js');
  const getVaultKey = async (id) =>
    id === 'GOOGLE_MAPS_API_KEY' ? 'vault-google'
    : id === 'CESIUM_ION_TOKEN' ? 'vault-cesium'
    : id === 'MAPILLARY_CLIENT_TOKEN' ? 'vault-mapillary'
    : null;
  assert.deepEqual(
    await resolveSceneKeys({
      getVaultKey,
      googleApiKey: 'build-google',
      cesiumToken: 'build-cesium',
      direct: true,
    }),
    {
      googleApiKey: 'vault-google',
      cesiumToken: 'vault-cesium',
      mapillaryToken: 'vault-mapillary',
    },
  );
  assert.deepEqual(
    await resolveSceneKeys({
      getVaultKey,
      googleApiKey: 'build-google',
      cesiumToken: 'build-cesium',
      direct: false,
    }),
    {
      googleApiKey: 'build-google',
      cesiumToken: 'build-cesium',
      mapillaryToken: '',
    },
  );
});

test('resolveSceneKeys falls back per key and on failure', async () => {
  const { resolveSceneKeys } = await import('./vaultKeys.js');
  assert.deepEqual(
    await resolveSceneKeys({
      getVaultKey: async () => null,
      googleApiKey: 'build-google',
      cesiumToken: 'build-cesium',
      direct: true,
    }),
    {
      googleApiKey: 'build-google',
      cesiumToken: 'build-cesium',
      mapillaryToken: '',
    },
  );
  assert.deepEqual(
    await resolveSceneKeys({
      getVaultKey: async () => {
        throw new Error('nope');
      },
      googleApiKey: 'build-google',
      cesiumToken: 'build-cesium',
      direct: true,
    }),
    {
      googleApiKey: 'build-google',
      cesiumToken: 'build-cesium',
      mapillaryToken: '',
    },
  );
  assert.deepEqual(await resolveSceneKeys({}), {
    googleApiKey: '',
    cesiumToken: '',
    mapillaryToken: '',
  });
});
