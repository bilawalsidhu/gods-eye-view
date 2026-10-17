import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_VOICE_AUTH_STORAGE_KEY,
  readStoredCloudVoiceAuthMode,
  writeStoredCloudVoiceAuthMode,
} from './cloudVoiceAuth.js';

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('cloud voice auth defaults to API key and persists OAuth independently', () => {
  const storage = memoryStorage();
  assert.equal(readStoredCloudVoiceAuthMode(storage), 'api-key');
  assert.equal(writeStoredCloudVoiceAuthMode('oauth', storage), 'oauth');
  assert.equal(readStoredCloudVoiceAuthMode(storage), 'oauth');
  assert.equal(writeStoredCloudVoiceAuthMode('unknown', storage), 'api-key');
  assert.equal(
    readStoredCloudVoiceAuthMode(
      memoryStorage({ [CLOUD_VOICE_AUTH_STORAGE_KEY]: 'oauth' }),
    ),
    'oauth',
  );
});
