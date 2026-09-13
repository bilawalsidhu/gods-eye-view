import test from 'node:test';
import assert from 'node:assert/strict';

import { initLocalVoiceRow } from './localVoiceRow.js';

/** The smallest element the row actually touches. */
function stubElement() {
  return {
    dataset: {},
    hidden: true,
    disabled: false,
    textContent: '',
    handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    removeEventListener(type, handler) {
      if (this.handlers[type] === handler) delete this.handlers[type];
    },
    click() { this.handlers.click?.(); },
  };
}

function stubPanel() {
  const parts = {
    '[data-local-voice-state]': stubElement(),
    '[data-local-voice-install]': stubElement(),
    '[data-local-voice-command]': stubElement(),
    '[data-local-voice-progress]': stubElement(),
  };
  const root = { ...stubElement(), querySelector: (selector) => parts[selector] || null };
  return {
    parts,
    root,
    documentRef: { querySelector: (selector) => (selector === '[data-local-voice]' ? root : null) },
  };
}

const ok = (body) => ({ ok: true, json: async () => body });

test('the row offers one install and reports progress from the server', async () => {
  const { parts, root, documentRef } = stubPanel();
  const calls = [];
  let body = { binary: true, supported: true, ready: false, state: 'idle', steps: [], bytes: 0 };
  const fetchImpl = async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${url}`);
    return ok(body);
  };

  const row = await initLocalVoiceRow({ documentRef, fetchImpl });
  assert.equal(root.hidden, false);
  assert.equal(parts['[data-local-voice-state]'].textContent, 'NOT INSTALLED');
  assert.equal(parts['[data-local-voice-install]'].textContent, 'INSTALL');
  assert.equal(parts['[data-local-voice-install]'].hidden, false);
  assert.equal(parts['[data-local-voice-command]'].hidden, true, 'LocalAI is present, so no command to run');

  body = {
    binary: true,
    supported: true,
    ready: false,
    state: 'running',
    bytes: 250_000_000,
    steps: [{ id: 'weights:llm', kind: 'weights', label: 'Download openbmb/MiniCPM5-2B-MLX', state: 'running' }],
  };
  parts['[data-local-voice-install]'].click();
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.deepEqual(calls, ['GET /api/setup/local-voice', 'POST /api/setup/local-voice']);
  assert.match(parts['[data-local-voice-progress]'].textContent, /Download openbmb\/MiniCPM5-2B-MLX — 250 MB \(1\/1\)/);
  assert.equal(parts['[data-local-voice-install]'].hidden, true, 'no second start while it runs');
  row.dispose();
  parts['[data-local-voice-install]'].click();
  assert.equal(calls.length, 2, 'dispose removes the install listener');
});

test('a missing LocalAI shows the command instead of a button', async () => {
  const { parts, documentRef } = stubPanel();
  const fetchImpl = async () => ok({ binary: false, supported: true, ready: false, state: 'idle', steps: [] });
  await initLocalVoiceRow({ documentRef, fetchImpl });
  assert.equal(parts['[data-local-voice-command]'].hidden, false);
  assert.equal(parts['[data-local-voice-command]'].textContent, 'brew install localai');
  assert.equal(parts['[data-local-voice-install]'].hidden, true);
});

test('the row removes itself where the endpoint cannot answer', async () => {
  const { root, documentRef } = stubPanel();
  await initLocalVoiceRow({ documentRef, fetchImpl: async () => { throw new Error('prod build'); } });
  assert.equal(root.hidden, true);
});
