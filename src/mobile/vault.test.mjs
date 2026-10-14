import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY_IDS, createVault } from './vault.js';
import {
  INSECURE_BACKEND,
  SECURE_BACKEND,
  insecureBridge,
  storageBackend,
  withBackend,
} from './secureStorage.js';

/** In-memory stand-in for Capacitor Preferences ({get,set,remove} shape). */
function createStubStorage() {
  const values = new Map();
  return {
    values,
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

/** Non-secret canary: distinctive, never shaped like a real provider key. */
const CANARY = 'CANARY_SENTINEL_7Q9Z';

test('KEY_IDS lists every on-device provider key in contract order', () => {
  assert.deepEqual(KEY_IDS, [
    'OPENAI_API_KEY',
    'AISSTREAM_API_KEY',
    'FIRMS_MAP_KEY',
    'TOMTOM_API_KEY',
    'OPENSKY_CLIENT_ID',
    'OPENSKY_CLIENT_SECRET',
    'GOOGLE_MAPS_API_KEY',
  ]);
});

test('vault round-trips every KEY_ID through injected storage', async () => {
  const vault = createVault({
    storage: withBackend(createStubStorage(), 'secure'),
  });
  for (const id of KEY_IDS) {
    assert.equal(await vault.readKey(id), null);
    await vault.writeKey(id, `probe-value-for-${id}`);
    assert.equal(await vault.readKey(id), `probe-value-for-${id}`);
  }
  const status = await vault.keyStatus();
  assert.deepEqual(Object.keys(status).sort(), [...KEY_IDS].sort());
  for (const id of KEY_IDS) {
    assert.equal(status[id].set, true);
    assert.equal(status[id].backend, 'secure');
  }
});

test('vault rejects unknown key ids without touching storage', async () => {
  const inner = createStubStorage();
  const vault = createVault({ storage: withBackend(inner, 'secure') });
  await assert.rejects(
    () => vault.writeKey('NOPE_API_KEY', 'probe'),
    /key id/i,
  );
  await assert.rejects(() => vault.removeKey('NOPE_API_KEY'), /key id/i);
  assert.equal(await vault.readKey('NOPE_API_KEY'), null);
  assert.equal(inner.values.size, 0);
});

test('vault rejects empty and non-string writes', async () => {
  const storage = withBackend(createStubStorage(), 'secure');
  const vault = createVault({ storage });
  await assert.rejects(() => vault.writeKey('OPENAI_API_KEY', ''), /non-empty/);
  await assert.rejects(
    () => vault.writeKey('OPENAI_API_KEY', 12345),
    (error) => {
      assert.match(error.message, /non-empty/);
      assert.doesNotMatch(error.message, /12345/);
      return true;
    },
  );
  await assert.rejects(() => vault.writeKey('OPENAI_API_KEY', null));
  await assert.rejects(() => vault.writeKey('OPENAI_API_KEY', undefined));
  assert.equal(await vault.readKey('OPENAI_API_KEY'), null);
});

test('readKey returns null when storage throws', async () => {
  const vault = createVault({
    storage: {
      get: async () => {
        throw new Error('locked');
      },
      set: async () => {},
      remove: async () => {},
    },
  });
  assert.equal(await vault.readKey('OPENAI_API_KEY'), null);
});

test('no thrown error ever carries a key value', async () => {
  const leaky =
    (verb) =>
    async ({ value }) => {
      throw new Error(`storage ${verb} refused value ${value ?? CANARY}`);
    };
  const writeVault = createVault({
    storage: {
      get: async () => ({ value: null }),
      set: leaky('write'),
      remove: async () => {},
    },
  });
  await assert.rejects(
    () => writeVault.writeKey('OPENAI_API_KEY', CANARY),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(CANARY));
      return true;
    },
  );
  const removeVault = createVault({
    storage: {
      get: async () => ({ value: null }),
      set: async () => {},
      remove: leaky('remove'),
    },
  });
  await assert.rejects(
    () => removeVault.removeKey('OPENAI_API_KEY'),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(CANARY));
      return true;
    },
  );
  const readVault = createVault({
    storage: {
      get: leaky('read'),
      set: async () => {},
      remove: async () => {},
    },
  });
  assert.equal(await readVault.readKey('OPENAI_API_KEY'), null);
});

test('insecure backend is reported and blocks writes unless opted in', async () => {
  const guarded = createVault({ storage: createStubStorage() });
  const status = await guarded.keyStatus();
  for (const id of KEY_IDS) {
    assert.equal(status[id].set, false);
    assert.equal(status[id].backend, 'insecure');
  }
  await assert.rejects(
    () => guarded.writeKey('OPENAI_API_KEY', 'probe-value'),
    /insecure/i,
  );
  const optedIn = createVault({
    storage: createStubStorage(),
    insecureOk: true,
  });
  await optedIn.writeKey('OPENAI_API_KEY', 'probe-value');
  assert.equal(await optedIn.readKey('OPENAI_API_KEY'), 'probe-value');
  const optedStatus = await optedIn.keyStatus();
  assert.equal(optedStatus.OPENAI_API_KEY.backend, 'insecure');
});

test('removeKey clears the stored value', async () => {
  const vault = createVault({
    storage: withBackend(createStubStorage(), 'secure'),
    insecureOk: true,
  });
  await vault.writeKey('FIRMS_MAP_KEY', 'probe-value');
  await vault.removeKey('FIRMS_MAP_KEY');
  assert.equal(await vault.readKey('FIRMS_MAP_KEY'), null);
  assert.equal((await vault.keyStatus()).FIRMS_MAP_KEY.set, false);
});

test('keyStatus fails closed when storage throws', async () => {
  const vault = createVault({
    storage: {
      get: async () => {
        throw new Error('locked');
      },
      set: async () => {},
      remove: async () => {},
    },
    insecureOk: true,
  });
  const status = await vault.keyStatus();
  for (const id of KEY_IDS) assert.equal(status[id].set, false);
});

test('createVault rejects malformed storage without logging values', async () => {
  assert.throws(() => createVault({}), /storage/);
  assert.throws(() => createVault({ storage: {} }), /storage/);
  assert.throws(
    () =>
      createVault({ storage: { get: async () => ({}), set: async () => {} } }),
    /storage/,
  );
});

test('secureStorage bridge tags backends and passes values through', async () => {
  assert.equal(SECURE_BACKEND, 'secure');
  assert.equal(INSECURE_BACKEND, 'insecure');
  const inner = createStubStorage();
  assert.equal(storageBackend(inner), 'insecure');
  assert.equal(storageBackend(withBackend(inner, 'secure')), 'secure');
  const bridged = insecureBridge(inner);
  assert.equal(storageBackend(bridged), 'insecure');
  await bridged.set({ key: 'OPENAI_API_KEY', value: 'probe-value' });
  assert.deepEqual(await bridged.get({ key: 'OPENAI_API_KEY' }), {
    value: 'probe-value',
  });
  await bridged.remove({ key: 'OPENAI_API_KEY' });
  assert.deepEqual(await bridged.get({ key: 'OPENAI_API_KEY' }), {
    value: null,
  });
  assert.throws(() => withBackend(inner, 'vault'), /backend/);
});

test('secureStoreFromPlugin wraps the string API and tags it secure', async () => {
  const { secureStoreFromPlugin } = await import('./secureStorage.js');
  const values = new Map();
  const plugin = {
    getItem: async (key) => (values.has(key) ? values.get(key) : null),
    setItem: async (key, value) => {
      values.set(key, String(value));
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  const store = secureStoreFromPlugin(plugin);
  assert.equal(storageBackend(store), 'secure');
  await store.set({ key: 'OPENAI_API_KEY', value: CANARY });
  assert.deepEqual(await store.get({ key: 'OPENAI_API_KEY' }), {
    value: CANARY,
  });
  await store.remove({ key: 'OPENAI_API_KEY' });
  assert.deepEqual(await store.get({ key: 'OPENAI_API_KEY' }), {
    value: null,
  });
  assert.throws(() => secureStoreFromPlugin({}), /getItem/);
  assert.throws(() => secureStoreFromPlugin(null), /getItem/);
});

test('loadSecureStore refuses off-device and survives plugin failures', async () => {
  const { loadSecureStore } = await import('./secureStorage.js');
  let imports = 0;
  const countingImport = async () => {
    imports += 1;
    return { SecureStorage: { getKeyPrefix: async () => 'x' } };
  };
  assert.equal(await loadSecureStore({ isNative: false, importPlugin: countingImport }), null);
  assert.equal(imports, 0, 'off-device never imports the plugin');
  assert.equal(
    await loadSecureStore({
      isNative: true,
      importPlugin: async () => {
        throw new Error('unsynced');
      },
    }),
    null,
  );
  assert.equal(await loadSecureStore({ isNative: true, importPlugin: async () => ({}) }), null);
  const values = new Map();
  const secure = await loadSecureStore({
    isNative: true,
    importPlugin: async () => ({
      SecureStorage: {
        getKeyPrefix: async () => 'capacitor-storage_',
        getItem: async (key) => (values.has(key) ? values.get(key) : null),
        setItem: async (key, value) => {
          values.set(key, String(value));
        },
        removeItem: async (key) => {
          values.delete(key);
        },
      },
    }),
  });
  assert.equal(storageBackend(secure), 'secure');
});

test('loadVaultStorage prefers secure and falls back insecure-flagged', async () => {
  const { loadVaultStorage } = await import('./secureStorage.js');
  const preferences = createStubStorage();
  const secureValues = new Map();
  const securePlugin = {
    getKeyPrefix: async () => 'capacitor-storage_',
    getItem: async (key) => (secureValues.has(key) ? secureValues.get(key) : null),
    setItem: async (key, value) => {
      secureValues.set(key, String(value));
    },
    removeItem: async (key) => {
      secureValues.delete(key);
    },
  };
  const { secureStoreFromPlugin } = await import('./secureStorage.js');
  const secure = secureStoreFromPlugin(securePlugin);
  const first = await loadVaultStorage(preferences, {
    loadSecure: async () => secure,
  });
  assert.equal(first.backend, 'secure');
  assert.equal(first.store, secure);
  const fallback = await loadVaultStorage(preferences, {
    loadSecure: async () => null,
  });
  assert.equal(fallback.backend, 'insecure');
  assert.equal(storageBackend(fallback.store), 'insecure');
  const none = await loadVaultStorage(null, { loadSecure: async () => null });
  assert.deepEqual(none, { store: null, backend: 'insecure' });
});
