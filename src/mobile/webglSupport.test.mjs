import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBGL2_FALLBACK_MESSAGE,
  createWebgl2Context,
  probeWebgl2Status,
  showWebgl2Fallback,
} from './webglSupport.js';

test('probeWebgl2Status returns no-webgl2 for a null context', () => {
  assert.equal(probeWebgl2Status(null), 'no-webgl2');
});

test('probeWebgl2Status returns no-webgl2 when no context was created', () => {
  assert.equal(probeWebgl2Status(undefined), 'no-webgl2');
});

test('probeWebgl2Status returns ok for a live context', () => {
  assert.equal(probeWebgl2Status({}), 'ok');
});

test('createWebgl2Context returns null without throwing', () => {
  assert.equal(createWebgl2Context(null), null);
  assert.equal(
    createWebgl2Context({
      getContext() {
        throw new Error('no gl');
      },
    }),
    null,
  );
});

test('showWebgl2Fallback renders the keyless-2D message', () => {
  const container = { textContent: '' };
  const message = showWebgl2Fallback(container);
  assert.equal(message, WEBGL2_FALLBACK_MESSAGE);
  assert.equal(container.textContent, WEBGL2_FALLBACK_MESSAGE);
});
