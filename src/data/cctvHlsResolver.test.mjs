import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHlsPuller,
  parseHlsMedia,
} from '../../server/providers/cctv/stream.js';
const base = 'https://camera.example/live/index.m3u8';
const manifest = () =>
  '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.mp4\n#EXTINF:2,\nb.mp4\n';

test('resolver origin escapes fail before any media fetch, including credentials and scheme downgrade', async (t) => {
  for (const resolved of [
    'https://evil.example/index.m3u8',
    base.replace('https:', 'http:'),
    base.replace('https://', 'https://user@'),
  ]) {
    let calls = 0;
    const manager = createHlsPuller({
      resolveUrl: async () => resolved,
      fetchImpl: async () => {
        calls++;
        return new Response('bad');
      },
    });
    t.after(() => manager.shutdown());
    const entry = await manager.ensure('camera', base);
    await entry.polling;
    assert.equal(calls, 0);
    assert.equal(entry.failures, 1);
    assert.equal(entry.bytes, 0);
  }
});

test('release while authorization is pending aborts and cannot start media or retain late bytes', async (t) => {
  let signal, finish;
  const started = Promise.withResolvers();
  const manager = createHlsPuller({
    resolveUrl: async (_url, s) => {
      signal = s;
      started.resolve();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    fetchImpl: async () => {
      assert.fail('media must not start after cancellation');
    },
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('camera', base, 'viewer');
  await started.promise;
  manager.release('camera', 'viewer');
  assert.equal(signal.aborted, true);
  finish(base + '?token=' + 'a'.repeat(64));
  await entry.polling;
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
});

test('segment trimming rejects invalid limits for TS and fMP4 without changing container policy', () => {
  for (const media of [manifest(), '#EXTM3U\n#EXTINF:2,\na.ts\n'])
    for (const limit of [0, -1, 1.5, Infinity, NaN])
      assert.throws(() => parseHlsMedia(media, base, limit), /segment limit/);
});
