import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirmsSource } from './source.js';

test('a malformed successful response is never accepted as an empty fire snapshot', async () => {
  for (const payload of [{}, { fires: null }, { fires: {} }]) {
    const source = createFirmsSource({
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    });
    await assert.rejects(source.getSnapshot(), /Malformed fire snapshot/);
  }
});
test('optional-key guidance is distinct from denial or upstream failure', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const source = createFirmsSource({
      fetchImpl: async () => ({
        ok: false,
        status,
        json: async () => ({ error: 'no_key' }),
      }),
    });
    if (status === 503)
      assert.deepEqual(await source.getSnapshot(), { keyRequired: true });
    else
      await assert.rejects(
        source.getSnapshot(),
        new RegExp(`FIRMS HTTP ${status}`),
      );
  }
});
test('a missing FIRMS key falls back to the keyless GOES feed', async () => {
  const calls = [];
  const source = createFirmsSource({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === '/api/firms')
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'no_key' }),
        };
      return {
        ok: true,
        json: async () => ({ fires: [{ lat: 1, lon: 2 }], provider: 'goes' }),
      };
    },
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(calls, ['/api/firms', '/api/goes-fires']);
  assert.equal(snapshot.provider, 'goes');
  assert.equal(snapshot.fires.length, 1);
});

test('a configured FIRMS key never triggers the keyless fallback', async () => {
  const calls = [];
  const source = createFirmsSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ fires: [] }) };
    },
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(calls, ['/api/firms']);
  assert.equal(snapshot.provider, 'firms');
});

test('a FIRMS outage is not masked by the keyless fallback', async () => {
  const calls = [];
  const source = createFirmsSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: false, status: 500, json: async () => ({}) };
    },
  });
  await assert.rejects(source.getSnapshot(), /FIRMS HTTP 500/);
  assert.deepEqual(calls, ['/api/firms']);
});

test('a malformed GOES payload is rejected rather than rendered as empty', async () => {
  const source = createFirmsSource({
    fetchImpl: async (url) =>
      url === '/api/firms'
        ? { ok: false, status: 503, json: async () => ({ error: 'no_key' }) }
        : { ok: true, json: async () => ({ fires: null }) },
  });
  await assert.rejects(source.getSnapshot(), /Malformed fire snapshot/);
});

test('a non-503 GOES failure surfaces as an error, not as a missing key', async () => {
  const source = createFirmsSource({
    fetchImpl: async (url) =>
      url === '/api/firms'
        ? { ok: false, status: 503, json: async () => ({ error: 'no_key' }) }
        : { ok: false, status: 502, json: async () => ({}) },
  });
  await assert.rejects(source.getSnapshot(), /GOES fires HTTP 502/);
});

test('response-body completion honors cancellation without replacing records', async () => {
  const abort = new AbortController();
  const source = createFirmsSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { fires: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
