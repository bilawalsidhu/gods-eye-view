import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { decryptJson, deriveVaultKey, encryptJson } from './crypto.js';

const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 21);

test('encrypted JSON round trips with an AES-GCM vault key', async () => {
  const keyMaterial = await deriveVaultKey('synthetic passphrase', salt, webcrypto);
  const value = { id: 'case-1', status: 'open', candidate: { name: 'Synthetic Name' } };

  const envelope = await encryptJson(keyMaterial, value, iv, webcrypto);
  const decrypted = await decryptJson(keyMaterial, envelope, webcrypto);

  assert.deepEqual(decrypted, value);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.algorithm, 'AES-GCM-256');
});

test('ciphertext does not contain serialized plaintext', async () => {
  const keyMaterial = await deriveVaultKey('synthetic passphrase', salt, webcrypto);
  const value = { mandate: 'private-synthetic-mandate' };

  const envelope = await encryptJson(keyMaterial, value, iv, webcrypto);

  assert.doesNotMatch(envelope.ciphertext, /private-synthetic-mandate/);
  assert.doesNotMatch(JSON.stringify(envelope), /synthetic passphrase/);
});

test('tampered envelopes reject as DECRYPTION_FAILED', async () => {
  const keyMaterial = await deriveVaultKey('synthetic passphrase', salt, webcrypto);
  const envelope = await encryptJson(keyMaterial, { id: 'case-1' }, iv, webcrypto);
  const firstCharacter = envelope.ciphertext[0] === 'A' ? 'B' : 'A';
  const tampered = { ...envelope, ciphertext: `${firstCharacter}${envelope.ciphertext.slice(1)}` };

  await assert.rejects(
    decryptJson(keyMaterial, tampered, webcrypto),
    (error) => error?.code === 'DECRYPTION_FAILED',
  );
});
