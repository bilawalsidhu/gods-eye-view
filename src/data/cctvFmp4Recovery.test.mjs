import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHlsPuller,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';

const base = 'https://camera.example/live/index.m3u8';
const MiB = 1024 * 1024;
const playlist = (first, count = 12, init = 'init.mp4', discontinuity) =>
  `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-MAP:URI="${init}"\n` +
  Array.from(
    { length: count },
    (_, i) =>
      (first + i === discontinuity ? '#EXT-X-DISCONTINUITY\n' : '') +
      `#EXTINF:2,\n${first + i}.m4s\n`,
  ).join('');

function assertCache(manager, entry) {
  const media = [...entry.segments.values()];
  const inits = [...entry.inits.values()];
  const bytes = [...media, ...inits].reduce(
    (sum, item) => sum + item.body.length,
    0,
  );
  assert.equal(manager.stats().bytes, bytes);
  assert.equal(entry.bytes, bytes);
  assert.ok(bytes <= HLS_LIMITS.sessionBytes);
  assert.ok(entry.upstream.size <= HLS_LIMITS.segments * 2);
  for (const init of inits) {
    const refs = media.filter((item) => item.initId === init.id).length;
    assert.ok(refs > 0, 'no orphan init retained');
    assert.equal(init.refs, refs);
  }
  for (const segment of media) assert.ok(entry.inits.has(segment.initId));
}

test('HD fMP4 combines live-edge startup, expired 404s, init refresh, eviction and rollback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let first = 100;
  let discontinuity;
  let generation = 1;
  const requested = [];
  const body = new Uint8Array(6.5 * MiB);
  const manager = createHlsPuller({
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      if (url === base)
        return new Response(playlist(first, 12, 'init.mp4', discontinuity));
      const name = new URL(url).pathname.split('/').at(-1);
      requested.push(name);
      if (name === 'init.mp4')
        return new Response(
          new Uint8Array(HLS_LIMITS.initBytes).fill(generation),
        );
      if (name === '112.m4s') return new Response('', { status: 404 });
      return new Response(body);
    },
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('hd', base, 'viewer');
  await manager.ensure('hd', base, 'other');
  await entry.polling;
  const poll = async () => {
    t.mock.timers.tick(HLS_LIMITS.pollMs);
    await entry.polling;
    assertCache(manager, entry);
    for (const init of entry.inits.values()) {
      const name = `init_${init.id}.mp4`;
      assert.equal(manager.getAsset('hd', entry.token, name, 'missing'), null);
      const a = manager.getAsset('hd', entry.token, name, 'viewer');
      const b = manager.getAsset('hd', entry.token, name, 'other');
      assert.equal(
        a.body,
        b.body,
        'both consumer leases share the retained init generation',
      );
    }
  };
  assert.deepEqual(requested, ['init.mp4', '110.m4s', '111.m4s']);
  assert.equal(entry.nextSeq, 2);
  assert.equal(await manager.waitReady(entry), true);
  assert.equal(entry.bytes, 13 * MiB + HLS_LIMITS.initBytes);
  await poll();
  assert.equal(
    requested.length,
    3,
    'unchanged window does not restart or refetch',
  );

  // The discontinuity is on the expired media: it must still invalidate
  // the shared init URI before the next retained segment is decoded.
  first = 104;
  discontinuity = 112;
  generation = 2;
  await poll();
  assert.deepEqual(requested.slice(3), [
    'init.mp4',
    '112.m4s',
    'init.mp4',
    '113.m4s',
    '114.m4s',
    '115.m4s',
  ]);
  assert.equal(entry.failures, 0);
  assert.deepEqual(
    [...entry.segments.values()].map((s) => s.discontinuity),
    [true, false, false],
  );
  const output = await manager.buildPlaylist(entry, 'hd', 'viewer');
  assert.match(output, /#EXT-X-VERSION:7/);
  assert.match(output, /#EXT-X-DISCONTINUITY\n#EXT-X-MAP:/);
  assert.equal(output.match(/#EXT-X-DISCONTINUITY\n/g)?.length, 1);
  assert.doesNotMatch(output, /camera\.example/);
  assert.equal(
    manager.getAsset('hd', entry.token, 'init_0.mp4', 'viewer'),
    null,
  );
  const currentInit = [...entry.inits.values()][0];
  assert.equal(currentInit.body[0], 2);
  await poll();
  assert.equal(
    requested.length,
    9,
    'skipped 404 is remembered with its init URI',
  );

  first = 105;
  await poll();
  assert.equal(requested.at(-1), '116.m4s');
  assert.equal(requested.filter((name) => name === '112.m4s').length, 1);
  assert.ok([...entry.segments.values()].every((s) => !s.discontinuity));
  assert.equal(entry.discontinuitiesRemoved, 1);
  assert.match(
    await manager.buildPlaylist(entry, 'hd', 'viewer'),
    /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/,
  );

  first = 0;
  discontinuity = undefined;
  generation = 3;
  await poll();
  assert.deepEqual(requested.slice(-3), ['init.mp4', '10.m4s', '11.m4s']);
  const retained = [...entry.segments.values()];
  assert.deepEqual(
    retained.map((s) => s.discontinuity),
    [false, true, false],
  );
  assert.equal(entry.inits.get(retained[0].initId).body[0], 2);
  assert.equal(entry.inits.get(retained[1].initId).body[0], 3);
  assert.notEqual(retained[0].initId, retained[1].initId);
  const name = `init_${retained[1].initId}.mp4`;
  assert.equal(manager.getAsset('hd', 'stale', name, 'viewer'), null);
  assert.equal(manager.getAsset('hd', entry.token, name, 'missing'), null);
  assert.equal(
    manager.getAsset('hd', entry.token, name, 'viewer').contentType,
    'video/mp4',
  );
  manager.release('hd', 'missing');
  assert.equal(
    entry.leases.size,
    2,
    'unknown release leaves both leases intact',
  );
  manager.release('hd', 'viewer');
  assert.equal(manager.getAsset('hd', entry.token, name, 'viewer'), null);
  assert.ok(manager.getAsset('hd', entry.token, name, 'other'));
  manager.release('hd', 'other');
  assert.equal(entry.inits.size, 0);
  assert.equal(entry.initByUri.size, 0);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
});

test('changing only the init URI restarts reused sequences and keeps old init ownership', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let init = 'old.mp4';
  const requested = [];
  const manager = createHlsPuller({
    fetchImpl: async (url) => {
      if (url === base) return new Response(playlist(100, 12, init));
      requested.push(url);
      return new Response(url.endsWith('.mp4') ? init : 'media');
    },
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('map', base);
  await entry.polling;
  init = 'new.mp4';
  t.mock.timers.tick(HLS_LIMITS.pollMs);
  await entry.polling;
  assert.equal(requested.length, 6);
  assert.deepEqual(
    [...entry.segments.values()].map((s) => s.discontinuity),
    [false, false, true, false],
  );
  assert.equal(
    manager.getAsset('map', entry.token, 'init_0.mp4').body.toString(),
    'old.mp4',
  );
  assert.equal(
    manager.getAsset('map', entry.token, 'init_1.mp4').body.toString(),
    'new.mp4',
  );
  t.mock.timers.tick(HLS_LIMITS.pollMs);
  await entry.polling;
  assert.equal(requested.length, 6);
  assertCache(manager, entry);
});

test('fMP4 newest-pair 404s, init 404s and access failures remain strict', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [file, status] of [
    ['2.m4s', 404],
    ['3.m4s', 404],
    ['0.m4s', 403],
    ['init.mp4', 404],
  ]) {
    let failures = 0;
    const manager = createHlsPuller({
      // Exercise the oldest entry too, so an init error could otherwise
      // be accidentally swallowed by the expired-media catch block.
      limits: { ...HLS_LIMITS, segmentBytes: 1024 },
      fetchImpl: async (url) => {
        if (url === base) return new Response(playlist(0, 4));
        if (url.endsWith('/' + file)) {
          failures++;
          return new Response('', { status });
        }
        return new Response('bytes');
      },
    });
    t.after(() => manager.shutdown());
    const entry = await manager.ensure('strict', base);
    await entry.polling;
    for (let i = 0; i < 2; i++) {
      t.mock.timers.tick(HLS_LIMITS.pollMs);
      await entry.polling;
    }
    assert.equal(failures, 3, file);
    assert.equal(entry.stopping, true, file);
    assert.equal(await manager.waitReady(entry), false);
    assert.equal(entry.inits.size, 0);
    assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
    await manager.shutdown();
  }
});

test('old media redirect, origin mismatch, TLS and size errors cannot become recoverable 404s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [
    () => {
      const response = new Response('', { status: 404 });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    },
    () => {
      const response = new Response('', { status: 404 });
      Object.defineProperty(response, 'url', {
        value: 'https://other.example/0.m4s',
      });
      return response;
    },
    () =>
      new Response('', {
        status: 302,
        headers: { location: 'https://other.example/0.m4s' },
      }),
    () => {
      throw new Error('certificate verification failed');
    },
    () =>
      new Response('oversized', {
        headers: { 'content-length': String(HLS_LIMITS.segmentBytes + 1) },
      }),
  ];
  for (const failure of errors) {
    const manager = createHlsPuller({
      limits: { ...HLS_LIMITS, segmentBytes: 1024 },
      fetchImpl: async (url) => {
        if (url === base) return new Response(playlist(0, 4));
        if (url.endsWith('/0.m4s')) return failure();
        return new Response('init');
      },
    });
    t.after(() => manager.shutdown());
    const entry = await manager.ensure('security', base);
    await entry.polling;
    assert.equal(
      entry.upstream.size,
      0,
      'security failures are not recorded as expired media',
    );
    for (let i = 0; i < 2; i++) {
      t.mock.timers.tick(HLS_LIMITS.pollMs);
      await entry.polling;
    }
    assert.equal(entry.stopping, true);
    assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
    await manager.shutdown();
  }
});

test('real fMP4 init and segment limits never expand the 24 MiB session budget', async (t) => {
  for (const [initSize, mediaSize, expectedSegments] of [
    [
      HLS_LIMITS.initBytes,
      HLS_LIMITS.segmentBytes - HLS_LIMITS.initBytes / 2,
      2,
    ],
    [HLS_LIMITS.initBytes, HLS_LIMITS.segmentBytes, 1],
    [HLS_LIMITS.initBytes + 1, 6.5 * MiB, 0],
    [HLS_LIMITS.initBytes, HLS_LIMITS.segmentBytes + 1, 0],
  ]) {
    const manager = createHlsPuller({
      fetchImpl: async (url) =>
        new Response(
          url === base
            ? playlist(0, 2)
            : new Uint8Array(url.endsWith('.mp4') ? initSize : mediaSize),
        ),
    });
    t.after(() => manager.shutdown());
    const entry = await manager.ensure('caps', base);
    await entry.polling;
    assert.equal(entry.segments.size, expectedSegments);
    assertCache(manager, entry);
    if (expectedSegments === 2) {
      assert.equal(entry.bytes, HLS_LIMITS.sessionBytes);
      assert.equal(await manager.waitReady(entry), true);
    } else {
      assert.equal(await manager.buildPlaylist(entry, 'caps'), null);
      assert.equal(entry.inits.size, expectedSegments);
    }
    await manager.shutdown();
  }
});

test('container switching still exhausts retries instead of mixing TS with retained fMP4', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let current = playlist(0, 2);
  const manager = createHlsPuller({
    fetchImpl: async (url) => new Response(url === base ? current : 'bytes'),
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('mixed', base);
  await entry.polling;
  current = '#EXTM3U\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n';
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(HLS_LIMITS.pollMs);
    await entry.polling;
  }
  assert.equal(entry.stopping, true);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
});
