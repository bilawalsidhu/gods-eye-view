import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMonteHermosoSources } from '../../server/providers/cctv/monteHermoso.js';
import {
  createHlsPuller,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';

test('Monte Hermoso registers a canonical public master and labels the map reference', () => {
  const [camera] = loadMonteHermosoSources();
  assert.equal(
    camera.url,
    'https://encoder-1b.montevision.com.ar/live/monte2.m3u8',
  );
  assert.equal(new URL(camera.url).search, '');
  assert.equal(camera.feedType, 'hls');
  assert.match(camera.name, /\(approx\. location\)$/);
  assert.match(camera.credit, /Montevisión/);
  assert.equal(camera.headingConfidence, 'low');
  assert.equal(camera.poseSource, undefined);
  // A caller must not mutate the next catalog refresh.
  camera.url = 'https://evil.example/stream.m3u8';
  assert.notEqual(loadMonteHermosoSources()[0].url, camera.url);
});

test('existing HLS relay follows the Montevisión master context into TS segments', async (t) => {
  const [camera] = loadMonteHermosoSources();
  const origin = new URL(camera.url).origin;
  const chunklist = camera.url + '?hls_ctx=fixture';
  const seen = [];
  const segment = new Uint8Array(188);
  segment[0] = 0x47;
  const puller = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 60000, idleMs: 60000 },
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === camera.url)
        return new Response(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,AVERAGE-BANDWIDTH=1\n/live/monte2.m3u8?hls_ctx=fixture\n',
        );
      if (url === chunklist)
        return new Response(
          '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-TARGETDURATION:4\n' +
            '#EXTINF:2.998,\nmonte2-10.ts?hls_ctx=fixture\n' +
            '#EXTINF:2.002,\nmonte2-11.ts?hls_ctx=fixture\n',
        );
      assert.ok(
        [
          origin + '/live/monte2-10.ts?hls_ctx=fixture',
          origin + '/live/monte2-11.ts?hls_ctx=fixture',
        ].includes(url),
        'only same-origin, context-bearing segments are fetched',
      );
      return new Response(segment);
    },
  });
  t.after(() => puller.shutdown());
  const entry = await puller.ensure(camera.id, camera.url, 'test-lease');
  assert.equal(await puller.waitReady(entry), true);
  const playlist = await puller.buildPlaylist(entry, camera.id, 'test-lease');
  assert.match(
    playlist,
    /\/api\/cctv\/media\/monte-hermoso-peatonal-dufaur\/seg_0\.ts/,
  );
  assert.doesNotMatch(playlist, /montevision\.com\.ar|hls_ctx/);
  assert.equal(
    puller.getSegment(camera.id, entry.token, 0, 'test-lease').length,
    188,
  );
  assert.deepEqual(seen.slice(0, 2), [camera.url, chunklist]);
  puller.release(camera.id, 'test-lease');
  assert.equal(puller.stats().sessions, 0);
});
