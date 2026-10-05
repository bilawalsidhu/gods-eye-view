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
      if (!globalThis.indexedDB)
        throw new Error('IndexedDB is required for Demon Forge storage.');
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
    put: (id, value) =>
      run('readwrite', (store) => requestResult(store.put(value, id))),
    get: (id) => run('readonly', (store) => requestResult(store.get(id))),
    entries: async () =>
      run('readonly', async (store) => {
        const [keys, values] = await Promise.all([
          requestResult(store.getAllKeys()),
          requestResult(store.getAll()),
        ]);
        return keys.map((key, index) => [key, values[index]]);
      }),
    delete: (id) =>
      run('readwrite', (store) => requestResult(store.delete(id))),
  };
}

function requireCaseId(caseId) {
  if (typeof caseId !== 'string' || !caseId.trim())
    throw new TypeError('A case id is required.');
  return caseId;
}

function sameLedgerEvent(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function preservesAppendOnlyHistory(previousRecord, nextRecord) {
  const previousLedger = Array.isArray(previousRecord?.ledger)
    ? previousRecord.ledger
    : [];
  const nextLedger = Array.isArray(nextRecord?.ledger) ? nextRecord.ledger : [];
  const previousWorkflow = Array.isArray(previousRecord?.workflow)
    ? previousRecord.workflow
    : [];
  const nextWorkflow = Array.isArray(nextRecord?.workflow)
    ? nextRecord.workflow
    : [];
  return (
    previousLedger.length <= nextLedger.length &&
    previousLedger.every((event, index) =>
      sameLedgerEvent(event, nextLedger[index]),
    ) &&
    previousWorkflow.length <= nextWorkflow.length &&
    previousWorkflow.every(
      (entry, index) =>
        JSON.stringify(entry) === JSON.stringify(nextWorkflow[index]),
    )
  );
}

export function createDemonForgeVault({
  store = createIndexedDbCaseStore(),
  cryptoApi = globalThis.crypto,
  clock = Date.now,
} = {}) {
  let passphrase = null;
  let lockGeneration = 0;
  let operationQueue = Promise.resolve();

  function serialize(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => undefined);
    return result;
  }

  function requireUnlocked() {
    if (passphrase === null) throw vaultError('VAULT_LOCKED');
  }

  function captureSession() {
    requireUnlocked();
    return { passphrase, lockGeneration };
  }

  function requireActiveSession(session) {
    if (passphrase === null || lockGeneration !== session.lockGeneration) {
      throw vaultError('VAULT_LOCKED');
    }
  }

  function lockSession() {
    passphrase = null;
    lockGeneration += 1;
  }

  function randomBytes(length) {
    return cryptoApi.getRandomValues(new Uint8Array(length));
  }

  async function decryptCase(envelope, expectedId, session) {
    try {
      if (
        typeof envelope?.salt !== 'string' ||
        !/^[A-Za-z0-9_-]+$/u.test(envelope.salt)
      ) {
        throw vaultError('DECRYPTION_FAILED');
      }
      const base64 = envelope.salt.replaceAll('-', '+').replaceAll('_', '/');
      const salt = Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')),
        (character) => character.charCodeAt(0),
      );
      const keyMaterial = await deriveVaultKey(
        session.passphrase,
        salt,
        cryptoApi,
      );
      const record = await decryptJson(keyMaterial, envelope, cryptoApi);
      if (record?.id !== expectedId) throw vaultError('DECRYPTION_FAILED');
      requireActiveSession(session);
      return record;
    } catch (error) {
      if (lockGeneration !== session.lockGeneration || passphrase === null) {
        throw vaultError('VAULT_LOCKED');
      }
      lockSession();
      if (error?.code === 'DECRYPTION_FAILED') throw error;
      throw vaultError('DECRYPTION_FAILED');
    }
  }

  return Object.freeze({
    unlock(nextPassphrase) {
      return serialize(() => {
        if (typeof nextPassphrase !== 'string' || !nextPassphrase.trim())
          throw new TypeError('A passphrase is required.');
        passphrase = nextPassphrase;
        lockGeneration += 1;
      });
    },

    saveCase(caseRecord, { create = false } = {}) {
      return serialize(async () => {
        const session = captureSession();
        const id = requireCaseId(caseRecord?.id);
        const existingEnvelope = await store.get(id);
        requireActiveSession(session);
        if (create && existingEnvelope) throw vaultError('CASE_EXISTS');
        if (existingEnvelope) {
          const previousRecord = await decryptCase(
            existingEnvelope,
            id,
            session,
          );
          requireActiveSession(session);
          if (!preservesAppendOnlyHistory(previousRecord, caseRecord)) {
            throw vaultError('CASE_HISTORY_REWRITE');
          }
        }
        const record = { ...caseRecord, id, updatedAtMs: clock() };
        const keyMaterial = await deriveVaultKey(
          session.passphrase,
          randomBytes(16),
          cryptoApi,
        );
        const envelope = await encryptJson(
          keyMaterial,
          record,
          randomBytes(12),
          cryptoApi,
        );
        requireActiveSession(session);
        await store.put(id, envelope);
        requireActiveSession(session);
        return {
          id,
          status: record.status ?? null,
          updatedAtMs: record.updatedAtMs,
        };
      });
    },

    loadCase(caseId) {
      return serialize(async () => {
        const session = captureSession();
        const id = requireCaseId(caseId);
        const envelope = await store.get(id);
        requireActiveSession(session);
        if (!envelope) return null;
        const record = await decryptCase(envelope, id, session);
        requireActiveSession(session);
        return record;
      });
    },

    listCaseSummaries() {
      return serialize(async () => {
        const session = captureSession();
        const entries = await store.entries();
        requireActiveSession(session);
        const summaries = [];
        for (const [id, envelope] of entries) {
          const record = await decryptCase(envelope, id, session);
          requireActiveSession(session);
          summaries.push({
            id,
            status: record.status ?? null,
            updatedAtMs: record.updatedAtMs ?? null,
          });
        }
        requireActiveSession(session);
        return summaries;
      });
    },

    deleteCase(caseId) {
      return serialize(async () => {
        const session = captureSession();
        const id = requireCaseId(caseId);
        requireActiveSession(session);
        await store.delete(id);
        requireActiveSession(session);
      });
    },

    lock() {
      return serialize(lockSession);
    },
  });
}
