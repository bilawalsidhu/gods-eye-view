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

// Conditional polling is opt-in: the map layer sends the snapshot validator it
// holds, while tool callers (src/tools/services.js) always need the rows.
function recordingSource(response) {
  const calls = [];
  const source = createFirmsSource({
    fetchImpl: async (url, options) => {
      calls.push(options);
      return response;
    },
  });
  return { source, calls };
}

test('a caller holding a snapshot validator sends it and learns nothing changed', async () => {
  let drained = false;
  const { source, calls } = recordingSource({
    ok: false,
    status: 304,
    headers: new Headers({ etag: 'W/"firms-1-f"' }),
    json: async () => assert.fail('a 304 has no body to parse'),
    // Chrome lists a response whose empty body is never read as
    // net::ERR_ABORTED, so every unchanged poll looked like a failure.
    text: async () => {
      drained = true;
      return '';
    },
  });
  assert.deepEqual(await source.getSnapshot({ etag: 'W/"firms-1-f"' }), {
    notModified: true,
  });
  assert.equal(calls[0].headers['If-None-Match'], 'W/"firms-1-f"');
  assert.equal(drained, true, 'the empty body is read to completion');
});

test('a full snapshot reports the validator that names it', async () => {
  const { source } = recordingSource({
    ok: true,
    status: 200,
    headers: new Headers({ etag: 'W/"firms-2-f"' }),
    json: async () => ({ fires: [], fetchedAt: 2 }),
  });
  const snapshot = await source.getSnapshot({ etag: 'W/"firms-1-f"' });
  assert.equal(snapshot.etag, 'W/"firms-2-f"');
  assert.deepEqual(snapshot.fires, []);
});

test('callers without a validator never send a conditional request', async () => {
  for (const options of [undefined, {}, { etag: null }]) {
    const { source, calls } = recordingSource({
      ok: true,
      status: 200,
      json: async () => ({ fires: [] }),
    });
    const snapshot = await source.getSnapshot(options);
    assert.equal(calls[0].headers?.['If-None-Match'], undefined);
    assert.equal(
      snapshot.etag,
      null,
      'a response without a validator offers none',
    );
  }
});
