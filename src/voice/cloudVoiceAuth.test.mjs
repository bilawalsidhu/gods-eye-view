import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_VOICE_AUTH_STORAGE_KEY,
  readStoredCloudVoiceAuthMode,
  writeStoredCloudVoiceAuthMode,
} from './cloudVoiceAuth.js';
import { memoryStorage } from '../testSupport/memoryStorage.mjs';

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
