// A refused key save reads in the panel's language: the server sends `code`
// and `params` beside its English `error`, the panel builds the sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitKeySetupRequest,
  KEY_SETUP_UPDATE_LIMIT,
  validateKeySetupUpdates,
} from './keySetupCore.mjs';
import { collectKeyUpdates, saveRefusalText } from './keySetup.js';
import { setLocale } from './i18n/index.js';
import { extractMessages } from '../scripts/i18n.mjs';

const local = {
  method: 'POST',
  remoteAddress: '127.0.0.1',
  hostHeader: 'localhost:4173',
  origin: 'http://localhost:4173',
  contentType: 'application/json',
};

// Every refusal the core can return, plus the ones only the endpoint sends
// (server/standalone/key-setup.js), with the English the server writes.
const refusals = () => [
  validateKeySetupUpdates(
    collectKeyUpdates([{ envVar: 'OPENAI_API_KEY', value: '"sk-abc123"' }]),
  ),
  validateKeySetupUpdates(
    collectKeyUpdates([{ envVar: 'OPENAI_API_KEY', value: 'sk abc123' }]),
  ),
  validateKeySetupUpdates({ OPENAI_API_KEY: 'x'.repeat(600) }),
  validateKeySetupUpdates({ OPENAI_API_KEY: ' ' }),
  validateKeySetupUpdates({ OPENAI_API_KEY: 42 }),
  validateKeySetupUpdates({ PATH: '/usr/bin' }),
  validateKeySetupUpdates({}),
  validateKeySetupUpdates([]),
  validateKeySetupUpdates(
    Object.fromEntries(
      Array.from({ length: KEY_SETUP_UPDATE_LIMIT + 1 }, (_, i) => [
        `K${i}`,
        'v',
      ]),
    ),
  ),
  admitKeySetupRequest({ ...local, proxyHeaders: { 'x-forwarded-for': '1' } }),
  admitKeySetupRequest({
    ...local,
    env: { PINOKIO_SHARE_CLOUDFLARE: 'true' },
  }),
  admitKeySetupRequest({ ...local, remoteAddress: '192.168.1.20' }),
  admitKeySetupRequest({ ...local, hostHeader: 'workstation.local:4173' }),
  admitKeySetupRequest({ ...local, origin: undefined }),
  admitKeySetupRequest({ ...local, origin: 'not a url' }),
  admitKeySetupRequest({ ...local, origin: 'https://evil.example' }),
  admitKeySetupRequest({ ...local, contentType: 'text/plain' }),
  { error: 'Method not allowed', code: 'method' },
  { error: 'Request too large', code: 'too-large' },
  { error: 'Invalid JSON', code: 'invalid-json' },
  {
    error:
      'OPENAI_API_KEY is configured outside Provider Settings and can only be changed where it was set',
    code: 'external',
    params: { name: 'OPENAI_API_KEY' },
  },
  {
    error:
      'The key was not saved: could not restrict the credential file to your account; nothing was saved',
    code: 'harden-failed',
  },
  {
    error:
      'The key was not saved: the existing configuration could not be read, so nothing was changed',
    code: 'store-unreadable',
  },
  {
    error: 'Could not write the env-file store',
    code: 'write-failed',
    params: { store: 'env-file' },
  },
];

test('every refusal carries a code', () => {
  for (const refusal of refusals()) {
    assert.equal(refusal.ok ?? false, false);
    assert.equal(typeof refusal.code, 'string', refusal.error);
  }
});

test('in English the panel shows exactly the server sentence', () => {
  setLocale('en');
  for (const refusal of refusals())
    assert.equal(saveRefusalText(refusal, 400), refusal.error);
});

test('an unknown code or a bare error falls back to the server text or the status', () => {
  setLocale('en');
  assert.equal(
    saveRefusalText({ error: 'Something new', code: 'new' }, 400),
    'Something new',
  );
  assert.equal(saveRefusalText({}, 502), 'Save failed (502).');
});

test('the refusal sentences are catalog messages', () => {
  const messages = extractMessages();
  setLocale('en');
  for (const refusal of refusals()) {
    const pattern = saveRefusalText(
      {
        code: refusal.code,
        params: { name: '{name}', limit: '{limit}', store: '{store}' },
      },
      400,
    );
    assert.ok(messages.has(pattern), pattern);
  }
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: a refused save reads in the panel language`, () => {
    setLocale(locale);
    try {
      for (const refusal of refusals()) {
        const text = saveRefusalText(refusal, 400);
        assert.notEqual(text, refusal.error, `${locale}: ${refusal.error}`);
        if (refusal.params?.name) assert.ok(text.includes(refusal.params.name));
      }
    } finally {
      setLocale('en');
    }
  });
}
