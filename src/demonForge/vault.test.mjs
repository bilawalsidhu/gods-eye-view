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
