import test from 'node:test';
import assert from 'node:assert/strict';
import { supportedVoiceProviders } from './providerCapabilities.js';

const factories = { openai() {}, gemini() {} };

test('a host with both factories still enables only OpenAI by default', () => {
  assert.deepEqual(supportedVoiceProviders(undefined, factories), ['openai']);
  assert.throws(
    () => supportedVoiceProviders(undefined, { gemini() {} }),
    /No supported/,
  );
});

test('optional Gemini requires explicit opt-in and a real factory', () => {
  assert.deepEqual(supportedVoiceProviders(['openai', 'gemini'], factories), [
    'openai',
    'gemini',
  ]);
  assert.deepEqual(supportedVoiceProviders(['gemini'], factories), ['gemini']);
  assert.deepEqual(
    supportedVoiceProviders(['gemini', 'openai'], { openai() {} }),
    ['openai'],
  );
  for (const gemini of [undefined, null, {}, true])
    assert.throws(
      () => supportedVoiceProviders(['gemini'], { gemini }),
      /No supported/,
    );
});

test('provider configuration rejects an unusable registry and ignores unknown inherited names', () => {
  for (const requested of [null, 'gemini', {}, 1])
    assert.throws(
      () => supportedVoiceProviders(requested, factories),
      /must be an array/,
    );
  for (const requested of [[], ['unsupported'], ['toString']])
    assert.throws(
      () => supportedVoiceProviders(requested, factories),
      /No supported/,
    );
  const requested = ['gemini', 'unsupported', 'openai', 'gemini'];
  const selected = supportedVoiceProviders(requested, factories);
  assert.deepEqual(selected, ['gemini', 'openai']);
  requested.push('openai');
  assert.deepEqual(selected, ['gemini', 'openai']);
  assert.throws(() => selected.push('unsupported'), TypeError);
});

test('stale saved optional providers fall back only within the supported factory set', async () => {
  const { readVoiceProvider } = await import('./providerCommands.js');
  const saved = (value) => ({ getItem: () => value });
  const defaultSupported = supportedVoiceProviders(undefined, factories);
  assert.equal(readVoiceProvider(saved('gemini'), defaultSupported), 'openai');
  const optedIn = supportedVoiceProviders(['openai', 'gemini'], factories);
  assert.equal(readVoiceProvider(saved('gemini'), optedIn), 'gemini');
  assert.equal(readVoiceProvider(saved('unsupported'), optedIn), 'openai');
  assert.equal(readVoiceProvider(saved(null), optedIn), 'openai');
  const geminiOnly = supportedVoiceProviders(['gemini'], factories);
  assert.equal(readVoiceProvider(saved('openai'), geminiOnly), 'gemini');
  assert.equal(
    readVoiceProvider(
      {
        getItem: () => {
          throw new Error('storage denied');
        },
      },
      geminiOnly,
    ),
    'gemini',
  );
  const missingFactory = supportedVoiceProviders(['gemini', 'openai'], {
    openai() {},
  });
  assert.equal(readVoiceProvider(saved('gemini'), missingFactory), 'openai');
});
