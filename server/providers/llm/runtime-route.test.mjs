import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmRuntimeHandler } from './runtime-route.js';
import { resetRuntimeForTesting } from './runtime.js';

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) { this.body = payload; },
    json() { return JSON.parse(this.body || '{}'); },
  };
}

function fakeReq({ method = 'GET', body = null } = {}) {
  const listeners = {};
  const req = {
    method,
    on(event, fn) { (listeners[event] ||= []).push(fn); return req; },
    destroy() {},
  };
  queueMicrotask(() => {
    if (body !== null) (listeners.data || []).forEach((fn) => fn(Buffer.from(body)));
    (listeners.end || []).forEach((fn) => fn());
  });
  return req;
}

// No binaries and no reachable ports: these tests must describe the code's
// behaviour, not whatever happens to be running on the developer's machine.
const noBinaries = {
  execImpl: (c, a, o, cb) => cb(new Error('not found'), '', ''),
  fetchImpl: async () => {
    throw new Error('ECONNREFUSED');
  },
};

test('a refused request never reaches the launcher', async () => {
  let started = false;
  const handler = createLlmRuntimeHandler({
    admit: () => ({ ok: false, status: 403, error: 'Refused' }),
    env: {},
    ...noBinaries,
    execImpl: () => {
      started = true;
    },
  });
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: '{"action":"start","provider":"llamacpp"}' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(started, false, 'the gate must run before anything is executed');
});

test('GET reports what is installed without starting anything', async () => {
  resetRuntimeForTesting();
  const handler = createLlmRuntimeHandler({ env: {}, ...noBinaries });
  const res = fakeRes();
  await handler(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(payload.spawnAllowed, true);
  assert.equal(payload.runtime.running, false);
  assert.equal(payload.providers.llamacpp.installed, false);
  assert.equal(payload.providers.ollama.installed, false);
});

test('an unknown action is rejected', async () => {
  const handler = createLlmRuntimeHandler({ env: {}, ...noBinaries });
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: '{"action":"rm -rf"}' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /must be 'start' or 'stop'/);
});

test('a malformed body is a 400, not a crash', async () => {
  const handler = createLlmRuntimeHandler({ env: {}, ...noBinaries });
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'not json' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /JSON/);
});

test('an oversized body is refused rather than buffered', async () => {
  const handler = createLlmRuntimeHandler({ env: {}, ...noBinaries });
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: 'x'.repeat(20 * 1024) }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /too large/);
});

test('other verbs are rejected', async () => {
  const handler = createLlmRuntimeHandler({ env: {}, ...noBinaries });
  const res = fakeRes();
  await handler(fakeReq({ method: 'DELETE' }), res);
  assert.equal(res.statusCode, 405);
});

test('starting a runtime that is not installed answers 409, not 500', async () => {
  resetRuntimeForTesting();
  const handler = createLlmRuntimeHandler({ env: {}, ...noBinaries });
  const res = fakeRes();
  await handler(
    fakeReq({ method: 'POST', body: '{"action":"start","provider":"llamacpp","model":"/x.gguf"}' }),
    res,
  );
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /not installed|discovered models|No \.gguf/);
});

test('stop is safe when nothing is running', async () => {
  resetRuntimeForTesting();
  const handler = createLlmRuntimeHandler({ env: {}, ...noBinaries });
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: '{"action":"stop"}' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().runtime.running, false);
});
