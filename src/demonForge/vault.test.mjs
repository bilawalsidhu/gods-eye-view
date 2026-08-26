import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { createDemonForgeVault } from './vault.js';

function createFakeStore() {
  const values = new Map();
  return {
    values,
    async put(id, value) { values.set(id, value); },
    async get(id) { return values.get(id); },
    async entries() { return [...values.entries()]; },
    async delete(id) { values.delete(id); },
  };
}

function createInjectedCrypto() {
  const randomLengths = [];
  return {
    randomLengths,
    getRandomValues(bytes) {
      randomLengths.push(bytes.length);
      return webcrypto.getRandomValues(bytes);
    },
    subtle: webcrypto.subtle,
  };
}

function createDelayedStore() {
  const values = new Map();
  const gates = new Map();

  function gateFor(operation) {
    return gates.get(operation);
  }

  return {
    values,
    hold(operation) {
      let started;
      let release;
      const gate = {
        started: new Promise((resolve) => { started = resolve; }),
        released: new Promise((resolve) => { release = resolve; }),
        start: started,
        release,
      };
      gates.set(operation, gate);
      return gate;
    },
    async put(id, value) {
      const gate = gateFor('put');
      if (gate) {
        gate.start();
        await gate.released;
        gates.delete('put');
      }
      values.set(id, value);
    },
    async get(id) { return values.get(id); },
    async entries() { return [...values.entries()]; },
    async delete(id) {
      const gate = gateFor('delete');
      if (gate) {
        gate.start();
        await gate.released;
        gates.delete('delete');
      }
      values.delete(id);
    },
  };
}

async function assertEveryCaseMethodIsLocked(vault) {
  await assert.rejects(vault.loadCase('case-1'), (error) => error?.code === 'VAULT_LOCKED');
  await assert.rejects(vault.saveCase({ id: 'case-1' }), (error) => error?.code === 'VAULT_LOCKED');
  await assert.rejects(vault.listCaseSummaries(), (error) => error?.code === 'VAULT_LOCKED');
  await assert.rejects(vault.deleteCase('case-1'), (error) => error?.code === 'VAULT_LOCKED');
}

test('vault persists only an encrypted envelope and returns minimal summaries', async () => {
  const store = createFakeStore();
  const cryptoApi = createInjectedCrypto();
  const vault = createDemonForgeVault({ store, cryptoApi, clock: () => 1_700_000_000_000 });
  const record = {
    id: 'case-1',
    status: 'open',
    name: 'Synthetic Private Name',
    mandate: { sourceScopes: ['local'] },
    candidates: [{ name: 'Synthetic Candidate' }],
  };

  await vault.unlock('synthetic passphrase');
  await vault.saveCase(record);

  const stored = store.values.get('case-1');
  assert.deepEqual(Object.keys(stored).sort(), ['algorithm', 'ciphertext', 'iv', 'salt', 'version']);
  assert.doesNotMatch(JSON.stringify(stored), /Synthetic Private Name|Synthetic Candidate|synthetic passphrase/);
  assert.deepEqual(await vault.loadCase('case-1'), {
    ...record,
    updatedAtMs: 1_700_000_000_000,
  });
  assert.deepEqual(await vault.listCaseSummaries(), [
    { id: 'case-1', status: 'open', updatedAtMs: 1_700_000_000_000 },
  ]);
  assert.deepEqual(cryptoApi.randomLengths, [16, 12]);
});

test('lock rejects reads and writes', async () => {
  const vault = createDemonForgeVault({
    store: createFakeStore(),
    cryptoApi: createInjectedCrypto(),
    clock: () => 1_700_000_000_000,
  });

  await vault.unlock('synthetic passphrase');
  vault.lock();

  await assertEveryCaseMethodIsLocked(vault);
});

test('tampering or a wrong passphrase locks every case method', async () => {
  const store = createFakeStore();
  const cryptoApi = createInjectedCrypto();
  const writer = createDemonForgeVault({ store, cryptoApi, clock: () => 1_700_000_000_000 });
  await writer.unlock('synthetic passphrase');
  await writer.saveCase({ id: 'case-1', status: 'open' });

  const tampered = createDemonForgeVault({ store, cryptoApi, clock: () => 1_700_000_000_000 });
  const envelope = store.values.get('case-1');
  const firstCharacter = envelope.ciphertext[0] === 'A' ? 'B' : 'A';
  store.values.set('case-1', { ...envelope, ciphertext: `${firstCharacter}${envelope.ciphertext.slice(1)}` });
  await tampered.unlock('synthetic passphrase');
  await assert.rejects(tampered.loadCase('case-1'), (error) => error?.code === 'DECRYPTION_FAILED');
  await assertEveryCaseMethodIsLocked(tampered);

  await writer.saveCase({ id: 'case-1', status: 'open' });
  const wrongPassphrase = createDemonForgeVault({ store, cryptoApi, clock: () => 1_700_000_000_000 });
  await wrongPassphrase.unlock('not-the-synthetic-passphrase');
  await assert.rejects(wrongPassphrase.loadCase('case-1'), (error) => error?.code === 'DECRYPTION_FAILED');
  await assertEveryCaseMethodIsLocked(wrongPassphrase);
});

test('moving an envelope to a different outer case ID fails closed', async () => {
  const store = createFakeStore();
  const cryptoApi = createInjectedCrypto();
  const vault = createDemonForgeVault({ store, cryptoApi, clock: () => 1_700_000_000_000 });
  await vault.unlock('synthetic passphrase');
  await vault.saveCase({ id: 'case-1', status: 'open' });
  store.values.set('case-2', store.values.get('case-1'));

  await assert.rejects(vault.loadCase('case-2'), (error) => error?.code === 'DECRYPTION_FAILED');
  await assertEveryCaseMethodIsLocked(vault);
});

test('lock serializes behind delayed save and delete persistence', async () => {
  const store = createDelayedStore();
  const vault = createDemonForgeVault({
    store,
    cryptoApi: createInjectedCrypto(),
    clock: () => 1_700_000_000_000,
  });
  await vault.unlock('synthetic passphrase');

  const putGate = store.hold('put');
  const saving = vault.saveCase({ id: 'case-1', status: 'open' });
  await putGate.started;
  const lockingAfterSave = vault.lock();
  const saveQueuedAfterLock = vault.saveCase({ id: 'case-2', status: 'queued-after-lock' });
  let saveLockComplete = false;
  void lockingAfterSave.then(() => { saveLockComplete = true; });
  await Promise.resolve();
  assert.equal(saveLockComplete, false);
  assert.equal(store.values.has('case-1'), false);
  putGate.release();
  await saving;
  await lockingAfterSave;
  assert.equal(store.values.has('case-1'), true);
  await assert.rejects(saveQueuedAfterLock, (error) => error?.code === 'VAULT_LOCKED');
  assert.equal(store.values.has('case-2'), false);
  await assertEveryCaseMethodIsLocked(vault);

  await vault.unlock('synthetic passphrase');
  const deleteGate = store.hold('delete');
  const deleting = vault.deleteCase('case-1');
  await deleteGate.started;
  const lockingAfterDelete = vault.lock();
  let deleteLockComplete = false;
  void lockingAfterDelete.then(() => { deleteLockComplete = true; });
  await Promise.resolve();
  assert.equal(deleteLockComplete, false);
  assert.equal(store.values.has('case-1'), true);
  deleteGate.release();
  await deleting;
  await lockingAfterDelete;
  assert.equal(store.values.has('case-1'), false);
  await assertEveryCaseMethodIsLocked(vault);
});

test('invalid unlock input rejects through the promise contract', async () => {
  const vault = createDemonForgeVault({
    store: createFakeStore(),
    cryptoApi: createInjectedCrypto(),
    clock: () => 1_700_000_000_000,
  });

  const invalidUnlock = vault.unlock(null);

  assert.equal(typeof invalidUnlock?.then, 'function');
  await assert.rejects(invalidUnlock, TypeError);
});
