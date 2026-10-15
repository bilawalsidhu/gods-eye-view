import test from 'node:test';
import assert from 'node:assert/strict';
import { createScannerSource } from './source.js';

test('scanner source only addresses its own proxy routes', async () => {
  const paths = [];
  const source = createScannerSource({
    fetchImpl: async (path) => {
      paths.push(path);
      return new Response(
        JSON.stringify(
          path.includes('/calls/')
            ? { calls: [{ id: '1', time: 1, url: 'https://x.openmhz.com/1.m4a' }] }
            : { feeds: [{ id: 'a', name: 'A', lat: 1, lon: 2, type: 'stream' }] },
        ),
      );
    },
  });
  assert.equal((await source.getFeeds()).length, 1);
  assert.equal((await source.getCalls('a/../b')).length, 1);
  assert.equal(source.getStreamUrl('a b'), '/api/scanner/stream/a%20b');
  assert.deepEqual(paths, [
    '/api/scanner/feeds',
    '/api/scanner/calls/a%2F..%2Fb',
  ]);
});

test('scanner source rejects failed and malformed responses', async () => {
  const failing = createScannerSource({
    fetchImpl: async () => new Response('{}', { status: 502 }),
  });
  await assert.rejects(() => failing.getFeeds(), /502/);
  const malformed = createScannerSource({
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(() => malformed.getFeeds(), /Malformed/);
});
