import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHlsPuller,
  parseHlsMedia,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';

const base = 'https://camera.example/cam02/index.m3u8';
const media = [
  '#EXTM3U',
  '#EXT-X-MEDIA-SEQUENCE:12',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:5,',
  'a.mp4',
  '#EXTINF:5,',
  'b.mp4',
  '',
].join('\n');
const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="hvc1.1.6.L90.b0"',
  'video1_stream.m3u8',
  '',
].join('\n');
const limits = { ...HLS_LIMITS, pollMs: 100000 };

test('fMP4 parsing keeps init and media on the registered origin', () => {
  const parsed = parseHlsMedia(media, base);
  assert.deepEqual(
    parsed.map((s) => [s.seq, s.duration, s.initUri]),
    [
      [12, 5, 'https://camera.example/cam02/init.mp4'],
      [13, 5, 'https://camera.example/cam02/init.mp4'],
    ],
  );
  assert.equal(parsed[0].uri, 'https://camera.example/cam02/a.mp4');
  for (const invalid of [
    media.replace('init.mp4', 'https://other.example/init.mp4'),
    media.replace('init.mp4', '//other.example/init.mp4'),
    media.replace('init.mp4', 'https://user:pass@camera.example/init.mp4'),
    media.replace('a.mp4', 'https://other.example/a.mp4'),
    media.replace('URI="init.mp4"', 'URI="init.mp4",BYTERANGE="20@0"'),
    media.replace('URI="init.mp4"', 'URI="init.mp4",URI="other.mp4"'),
    media.replace('#EXT-X-MAP:URI="init.mp4"\n', ''),
    media.replace('a.mp4', 'a.ts'),
    media.replace('a.mp4', '#EXT-X-BYTERANGE:20@0\na.mp4'),
    media.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128'),
    media.replace('#EXTM3U', '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128'),
  ])
    assert.throws(() => parseHlsMedia(invalid, base));
});

test('fMP4 cache bounds and leases cover init and media', async (t) => {
  const requests = [];
  const manager = createHlsPuller({
    // Parse all three candidates so the byte budget actually evicts the first.
    limits: { ...limits, segments: 3, sessionBytes: 10 },
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(
        url === base
          ? master
          : url.endsWith('.m3u8')
            ? media + '#EXTINF:5,\nc.mp4\n'
            : url.endsWith('init.mp4')
              ? 'init'
              : 'abc',
      );
    },
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('cam', base, 'a');
  await entry.polling;
  await manager.ensure('cam', base, 'b');
  assert.deepEqual(manager.stats(), { sessions: 1, bytes: 10 });
  assert.equal(requests.filter((url) => url.endsWith('init.mp4')).length, 1);
  const playlist = await manager.buildPlaylist(entry, 'cam', 'a');
  assert.match(playlist, /#EXT-X-VERSION:7/);
  assert.match(playlist, /#EXT-X-MAP:URI="\/api\/cctv\/media\/cam\/init_0.mp4/);
  assert.match(playlist, /seg_1.mp4\?session=.*&lease=a/);
  assert.doesNotMatch(playlist, /camera\.example/);
  assert.equal(
    manager.getAsset('cam', entry.token, 'init_0.mp4', 'a').contentType,
    'video/mp4',
  );
  assert.equal(
    manager.getAsset('cam', entry.token, 'seg_1.mp4', 'a').body.toString(),
    'abc',
  );
  for (const name of [
    'seg_0.mp4',
    'seg_1.ts',
    'init_0.ts',
    'init_000.mp4',
    'seg_9007199254740992.mp4',
    '../init.mp4',
    'https://other.example/file.mp4',
  ])
    assert.equal(manager.getAsset('cam', entry.token, name, 'a'), null);
  assert.equal(manager.getAsset('cam', 'wrong', 'init_0.mp4', 'a'), null);
  assert.equal(manager.getAsset('missing', undefined, 'init_0.mp4'), null);
  manager.release('cam', 'a');
  assert.equal(manager.getAsset('cam', entry.token, 'init_0.mp4', 'a'), null);
  assert.ok(manager.getAsset('cam', entry.token, 'init_0.mp4', 'b'));
  manager.release('cam', 'b');
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
});

test('eviction frees init files after their last segment leaves', async (t) => {
  const rotated = media.replace(
    '#EXTINF:5,\nb.mp4',
    '#EXT-X-MAP:URI="new.mp4"\n#EXTINF:5,\nb.mp4',
  );
  const manager = createHlsPuller({
    limits: { ...limits, segments: 3, sessionBytes: 10 },
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('.m3u8')
          ? rotated + '#EXTINF:5,\nc.mp4\n'
          : /(?:init|new)\.mp4$/.test(url)
            ? 'init'
            : 'abc',
      ),
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('cam', base);
  await entry.polling;
  assert.deepEqual(manager.stats(), { sessions: 1, bytes: 10 });
  assert.equal(entry.inits.size, 1);
  assert.equal(manager.getAsset('cam', entry.token, 'init_0.mp4'), null);
  assert.ok(manager.getAsset('cam', entry.token, 'init_1.mp4'));
  const playlist = await manager.buildPlaylist(entry, 'cam');
  assert.match(playlist, /#EXT-X-DISCONTINUITY/);
  assert.match(playlist, /init_1.mp4/);
  assert.doesNotMatch(playlist, /init_0.mp4/);
});

const until = async (predicate) => {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), 'polling condition reached');
};

test('encoder restart refetches init and retains old maps', async (t) => {
  let current = media;
  let init = 'old';
  const manager = createHlsPuller({
    limits: { ...limits, pollMs: 5 },
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('.m3u8')
          ? current
          : url.endsWith('init.mp4')
            ? init
            : 'abc',
      ),
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('cam', base);
  await entry.polling;
  init = 'new';
  current = media.replace('SEQUENCE:12', 'SEQUENCE:0');
  await until(() => entry.segments.size === 4);
  assert.equal(
    manager.getAsset('cam', entry.token, 'init_0.mp4').body.toString(),
    'old',
  );
  assert.equal(
    manager.getAsset('cam', entry.token, 'init_1.mp4').body.toString(),
    'new',
  );
  const playlist = await manager.buildPlaylist(entry, 'cam');
  assert.match(playlist, /init_0.mp4/);
  assert.match(playlist, /#EXT-X-DISCONTINUITY\n#EXT-X-MAP:.*init_1.mp4/);
});

test('upstream discontinuity refreshes a reused init URI', async (t) => {
  const discontinuous = media.replace(
    '#EXTINF:5,\nb.mp4',
    '#EXT-X-DISCONTINUITY\n#EXTINF:5,\nb.mp4',
  );
  let initReads = 0;
  const manager = createHlsPuller({
    limits,
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('.m3u8')
          ? discontinuous
          : url.endsWith('init.mp4')
            ? String(++initReads)
            : 'abc',
      ),
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('cam', base);
  await entry.polling;
  assert.equal(initReads, 2);
  assert.equal(entry.inits.size, 2);
  assert.match(
    await manager.buildPlaylist(entry, 'cam'),
    /#EXT-X-DISCONTINUITY\n#EXT-X-MAP:.*init_1.mp4/,
  );
});

test('oversized or redirected init files never enter the cache', async (t) => {
  for (const response of [
    new Response('too large'),
    new Response('x', { headers: { 'content-length': '100' } }),
    new Response('', {
      status: 302,
      headers: { Location: 'https://other.example/init.mp4' },
    }),
  ]) {
    const requests = [];
    const manager = createHlsPuller({
      limits: { ...limits, initBytes: 4 },
      fetchImpl: async (url) => {
        requests.push(url);
        return url.endsWith('.m3u8') ? new Response(media) : response;
      },
    });
    t.after(() => manager.shutdown());
    const entry = await manager.ensure('cam', base);
    await entry.polling;
    assert.equal(manager.stats().bytes, 0);
    assert.equal(entry.inits.size, 0);
    assert.equal(
      requests.some((url) => url.endsWith('/a.mp4')),
      false,
    );
    await manager.shutdown();
  }
});

test('init plus media must fit the combined cache budget', async (t) => {
  const manager = createHlsPuller({
    limits: { ...limits, sessionBytes: 6 },
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('.m3u8')
          ? media
          : url.endsWith('init.mp4')
            ? 'init'
            : 'abc',
      ),
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('cam', base);
  await entry.polling;
  assert.equal(manager.stats().bytes, 0);
  assert.equal(entry.inits.size, 0);
  assert.equal(entry.segments.size, 0);
});

test('shutdown aborts pending init downloads', async (t) => {
  let initSignal;
  const manager = createHlsPuller({
    limits,
    fetchImpl: async (url, { signal }) => {
      if (url.endsWith('.m3u8')) return new Response(media);
      initSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    },
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('cam', base);
  await until(() => Boolean(initSignal));
  await manager.shutdown();
  assert.equal(initSignal.aborted, true);
  assert.equal(entry.stopping, true);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
});

test('MPEG-TS keeps its existing routes and media type', async (t) => {
  const manager = createHlsPuller({
    limits,
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('.m3u8')
          ? '#EXTM3U\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n'
          : 'abc',
      ),
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('cam', base);
  await entry.polling;
  const playlist = await manager.buildPlaylist(entry, 'cam');
  assert.match(playlist, /#EXT-X-VERSION:3/);
  assert.doesNotMatch(playlist, /#EXT-X-MAP/);
  assert.equal(
    manager.getAsset('cam', entry.token, 'seg_0.ts').contentType,
    'video/mp2t',
  );
  assert.equal(manager.getAsset('cam', entry.token, 'seg_0.mp4'), null);
});
