import test from 'node:test';
import assert from 'node:assert/strict';
import {
  speakText,
  stopSpeech,
  isSpeechSupported,
} from './speechSynthesis.js';

test('isSpeechSupported handles non-browser environment gracefully', () => {
  assert.equal(typeof isSpeechSupported(), 'boolean');
});

test('speakText handles empty string without error', async () => {
  const result = await speakText('');
  assert.equal(result, false);
});

test('stopSpeech can be called without error', () => {
  assert.doesNotThrow(() => stopSpeech());
});
