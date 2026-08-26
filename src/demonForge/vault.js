import { decryptJson, deriveVaultKey, encryptJson } from './crypto.js';

const DATABASE_NAME = 'gods-eye-view.demon-forge.v1';
const STORE_NAME = 'cases';

function vaultError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createIndexedDbCaseStore() {
  let databasePromise;

  async function database() {
    if (!databasePromise) {
      if (!globalThis.indexedDB) throw new Error('IndexedDB is required for Demon Forge storage.');
      databasePromise = new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return databasePromise;
  }

  async function run(mode, operation) {
    const db = await database();
    const transaction = db.transaction(STORE_NAME, mode);
    const result = await operation(transaction.objectStore(STORE_NAME));
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return result;
  }

  return {
    put: (id, value) => run('readwrite', (store) => requestResult(store.put(value, id))),
    get: (id) => run('readonly', (store) => requestResult(store.get(id))),
    entries: async () => run('readonly', async (store) => {
      const [keys, values] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll())]);
      return keys.map((key, index) => [key, values[index]]);
    }),
    delete: (id) => run('readwrite', (store) => requestResult(store.delete(id))),
  };
}

function requireCaseId(caseId) {
  if (typeof caseId !== 'string' || !caseId.trim()) throw new TypeError('A case id is required.');
  return caseId;
}

export function createDemonForgeVault({ store = createIndexedDbCaseStore(), cryptoApi = globalThis.crypto, clock = Date.now } = {}) {
  let passphrase = null;

  function requireUnlocked() {
    if (passphrase === null) throw vaultError('VAULT_LOCKED');
  }

  function randomBytes(length) {
    return cryptoApi.getRandomValues(new Uint8Array(length));
  }

  async function decryptCase(envelope) {
    try {
      if (typeof envelope?.salt !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(envelope.salt)) {
        throw vaultError('DECRYPTION_FAILED');
      }
      const base64 = envelope.salt.replaceAll('-', '+').replaceAll('_', '/');
      const salt = Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')),
        (character) => character.charCodeAt(0),
      );
      const keyMaterial = await deriveVaultKey(passphrase, salt, cryptoApi);
      return await decryptJson(keyMaterial, envelope, cryptoApi);
    } catch (error) {
      passphrase = null;
      if (error?.code === 'DECRYPTION_FAILED') throw error;
      throw vaultError('DECRYPTION_FAILED');
    }
  }

  return Object.freeze({
    async unlock(nextPassphrase) {
      if (typeof nextPassphrase !== 'string') throw new TypeError('A passphrase is required.');
      passphrase = nextPassphrase;
    },

    async saveCase(caseRecord) {
      requireUnlocked();
      const id = requireCaseId(caseRecord?.id);
      const record = { ...caseRecord, id, updatedAtMs: clock() };
      const keyMaterial = await deriveVaultKey(passphrase, randomBytes(16), cryptoApi);
      const envelope = await encryptJson(keyMaterial, record, randomBytes(12), cryptoApi);
      await store.put(id, envelope);
      return { id, status: record.status ?? null, updatedAtMs: record.updatedAtMs };
    },

    async loadCase(caseId) {
      requireUnlocked();
      const envelope = await store.get(requireCaseId(caseId));
      return envelope ? decryptCase(envelope) : null;
    },

    async listCaseSummaries() {
      requireUnlocked();
      const entries = await store.entries();
      const summaries = [];
      for (const [id, envelope] of entries) {
        const record = await decryptCase(envelope);
        summaries.push({ id, status: record.status ?? null, updatedAtMs: record.updatedAtMs ?? null });
      }
      return summaries;
    },

    async deleteCase(caseId) {
      requireUnlocked();
      await store.delete(requireCaseId(caseId));
    },

    lock() {
      passphrase = null;
    },
  });
}
