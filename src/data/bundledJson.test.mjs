import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBundledJson } from './bundledJson.js';

const MARINE = new URL(
  './local_data/natural_earth/marine.json',
  import.meta.url,
);
const importMarine = () =>
  import('./local_data/natural_earth/marine.json', { with: { type: 'json' } });

test('bundled JSON: a file URL uses the JSON import under Node', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch');
  const pack = await loadBundledJson(MARINE, importMarine);
  assert.ok(pack.features.some((ft) => ft.name === 'Gulf of Mexico'));
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('bundled JSON: a served URL is fetched as plain JSON', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response('{"features":[]}', {
      headers: { 'content-type': 'application/json' },
    });
  });
  const url = new URL(
    'http://localhost/src/data/local_data/natural_earth/marine.json',
  );
  const importJson = () => assert.fail('the browser path must not import JSON');
  assert.deepEqual(await loadBundledJson(url, importJson), { features: [] });
  assert.deepEqual(requests, [url.href]);
});

test('bundled JSON: an HTTP error rejects so the retryable loader can retry', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 404 }),
  );
  await assert.rejects(
    loadBundledJson(new URL('http://localhost/missing.json'), importMarine),
    /HTTP 404/,
  );
});
