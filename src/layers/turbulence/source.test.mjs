import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurbulenceSource } from './source.js';

const envelope = {
  schemaVersion: 1,
  fetchedAt: 1,
  stale: false,
  partial: true,
  unavailable: false,
  reason: null,
  forecasts: [],
  warnings: [],
  reports: [],
};

test('fetches the same-origin route, uncached, and validates it', async () => {
  const calls = [];
  const source = createTurbulenceSource({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(envelope);
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(calls[0].url, '/api/turbulence');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(snapshot.partial, true);
  assert.deepEqual(snapshot.forecasts, []);
});

test('an HTTP error or a foreign payload rejects', async () => {
  const failing = createTurbulenceSource({
    fetchImpl: async () => new Response('no', { status: 502 }),
  });
  await assert.rejects(failing.getSnapshot(), /Turbulence HTTP 502/);
  const foreign = createTurbulenceSource({
    fetchImpl: async () => Response.json({ rows: [] }),
  });
  await assert.rejects(
    foreign.getSnapshot(),
    /Unsupported turbulence snapshot/,
  );
});

test('the caller can cancel, and a slow proxy times out', async () => {
  const hang = (url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  const controller = new AbortController();
  const pending = createTurbulenceSource({ fetchImpl: hang }).getSnapshot({
    signal: controller.signal,
  });
  controller.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
  await assert.rejects(
    createTurbulenceSource({ fetchImpl: hang, timeoutMs: 5 }).getSnapshot(),
    /timed out/,
  );
});
