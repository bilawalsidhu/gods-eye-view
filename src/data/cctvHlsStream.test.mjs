import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHlsPuller,
  fetchHlsBytes,
  parseHlsMedia,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';
const playlist =
  '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXTINF:2,\nc.ts\n';
const base = 'https://camera.example/live/list.m3u8';

test('cold starts and sequence rollbacks fetch only two HD segments, while advancing polls fetch new segments', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let first = 100;
  const requested = [];
  const body = new Uint8Array(6.5 * 1024 * 1024);
  const manager = createHlsPuller({
    fetchImpl: async (url) => {
      if (url === base)
        return new Response(
          `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${first}\n` +
            Array.from(
              { length: 12 },
              (_, i) => `#EXTINF:2,\n${first + i}.ts\n`,
            ).join(''),
        );
      requested.push(url);
      return new Response(body);
    },
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('live-edge', base);
  await entry.polling;
  assert.deepEqual(
    requested,
    [110, 111].map((n) => new URL(`${n}.ts`, base).href),
  );
  assert.equal(entry.segments.size, 2);
  assert.equal(manager.stats().bytes, 2 * body.length);
  assert.equal(
    entry.nextSeq,
    2,
    'cold startup downloads nothing that needs eviction',
  );

  first = 103;
  t.mock.timers.tick(HLS_LIMITS.pollMs);
  await entry.polling;
  assert.deepEqual(
    requested.slice(2),
    [112, 113, 114].map((n) => new URL(`${n}.ts`, base).href),
  );
  assert.ok([...entry.segments.values()].every((s) => !s.discontinuity));

  first = 0;
  t.mock.timers.tick(HLS_LIMITS.pollMs);
  await entry.polling;
  assert.deepEqual(
    requested.slice(5),
    [10, 11].map((n) => new URL(`${n}.ts`, base).href),
  );
  assert.equal(entry.nextSeq, 7);
  assert.equal(entry.segments.get(5).discontinuity, true);
  assert.equal(entry.segments.get(6).discontinuity, false);
  assert.ok(manager.stats().bytes <= HLS_LIMITS.sessionBytes);
});

test('public HD segments over 6 MiB fit without increasing the session cache budget', async (t) => {
  const body = new Uint8Array(6 * 1024 * 1024 + 1024);
  const manager = createHlsPuller({
    fetchImpl: async (url) => new Response(url === base ? playlist : body),
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('hd', base);
  await entry.polling;
  assert.equal(entry.segments.size, 2);
  assert.equal(manager.stats().bytes, 2 * body.length);
  assert.ok(manager.stats().bytes <= HLS_LIMITS.sessionBytes);
});

test('playlist parser uses sequence, refuses escaping and unsupported references', () => {
  assert.deepEqual(
    parseHlsMedia(playlist, base).map((s) => s.seq),
    [12, 13, 14],
  );
  for (const bad of [
    playlist.replace('a.ts', 'https://evil.example/a.ts'),
    playlist.replace('a.ts', '//evil.example/a.ts'),
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n' + playlist,
    playlist.replace('12', '-1'),
    playlist.replace('2,', 'Infinity,'),
  ])
    assert.throws(() => parseHlsMedia(bad, base));
});

test('downloads reject redirect responses, oversized declared and chunked bodies', async () => {
  let init;
  await assert.rejects(
    fetchHlsBytes(base, {
      maxBytes: 5,
      fetchImpl: async (_url, options) => {
        init = options;
        return new Response('', {
          status: 302,
          headers: { Location: 'https://evil.example' },
        });
      },
    }),
  );
  assert.equal(init.redirect, 'error');
  await assert.rejects(
    fetchHlsBytes(base, {
      maxBytes: 5,
      fetchImpl: async () => new Response('abcdef'),
    }),
  );
  await assert.rejects(
    fetchHlsBytes(base, {
      maxBytes: 5,
      fetchImpl: async () =>
        new Response('a', { headers: { 'content-length': '100' } }),
    }),
  );
});

test('one session is reserved before await; disk-free cache and capacity remain bounded', async () => {
  const manager = createHlsPuller({
    limits: {
      ...HLS_LIMITS,
      sessions: 1,
      segmentBytes: 4,
      sessionBytes: 6,
      segments: 2,
      pollMs: 100000,
    },
    fetchImpl: async (url) =>
      new Response(url.endsWith('.m3u8') ? playlist : 'abc'),
  });
  const [a, b] = await Promise.all([
    manager.ensure('a', base),
    manager.ensure('a', base),
  ]);
  assert.equal(a, b);
  await assert.rejects(manager.ensure('b', base));
  assert.equal(await manager.waitReady(a), true);
  assert.deepEqual(manager.stats(), { sessions: 1, bytes: 6 });
  const text = await manager.buildPlaylist(a, 'a');
  assert.match(text, /seg_0\.ts\?session=/);
  assert.equal(manager.getSegment('a', 'stale-token', 0), null);
  assert.equal(manager.getSegment('a', a.token, 0).length, 3);
  manager.stop('a', 'stale-token');
  assert.equal(manager.stats().sessions, 1);
  manager.stop('a', a.token);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  await manager.shutdown();
});

test('shutdown cancels in-flight downloads and late responses cannot refill cache', async () => {
  let observed;
  const manager = createHlsPuller({
    fetchImpl: async (_url, { signal }) => {
      observed = signal;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      );
    },
  });
  const entry = await manager.ensure('a', base);
  await manager.shutdown();
  assert.equal(observed.aborted, true);
  assert.equal(entry.stopping, true);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  await assert.rejects(manager.ensure('a', base));
});

test('idle cleanup stops all polling without a background sweep', async () => {
  let calls = 0;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, idleMs: 15, pollMs: 100000 },
    fetchImpl: async (url) => {
      calls++;
      return new Response(url.endsWith('.m3u8') ? playlist : 'abc');
    },
  });
  await manager.ensure('a', base);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  const stoppedCalls = calls;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, stoppedCalls);
  await manager.shutdown();
});

test('agency sequence rollback creates a monotonic local discontinuity', async () => {
  let current = playlist;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 5 },
    fetchImpl: async (url) =>
      new Response(url.endsWith('.m3u8') ? current : 'abc'),
  });
  const entry = await manager.ensure('a', base);
  await manager.waitReady(entry);
  const before = await manager.buildPlaylist(entry, 'a');
  assert.match(before, /seg_0\.ts/);
  current = playlist.replace('SEQUENCE:12', 'SEQUENCE:0');
  await new Promise((r) => setTimeout(r, 30));
  const after = await manager.buildPlaylist(entry, 'a');
  assert.match(
    after,
    /#EXT-X-DISCONTINUITY\n#EXTINF:2\.000,\n\/api\/cctv\/media\/a\/seg_2\.ts/,
  );
  await manager.shutdown();
});

test('upstream discontinuity tags survive the media parser', () => {
  const parsed = parseHlsMedia(
    playlist.replace('a.ts', 'a.ts\n#EXT-X-DISCONTINUITY'),
    base,
  );
  assert.equal(parsed[0].discontinuity, false);
  assert.equal(parsed[1].discontinuity, true);
});

test('a reused agency sequence with changed segment URI cannot remain stale', async () => {
  let current = playlist;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 5 },
    fetchImpl: async (url) =>
      new Response(url.endsWith('.m3u8') ? current : 'abc'),
  });
  const entry = await manager.ensure('a', base);
  await manager.waitReady(entry);
  current = playlist.replaceAll('.ts', '.ts?generation=2');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(
    await manager.buildPlaylist(entry, 'a'),
    /#EXT-X-DISCONTINUITY\n#EXTINF:2\.000,\n\/api\/cctv\/media\/a\/seg_2\.ts/,
  );
  await manager.shutdown();
});

test('two consumers share downloads but release and abandoned expiry are independent', async () => {
  let downloads = 0;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 100000, leasesPerSession: 2 },
    fetchImpl: async (url) => {
      downloads++;
      return new Response(url.endsWith('.m3u8') ? playlist : 'abc');
    },
  });
  const [a, b] = await Promise.all([
    manager.ensure('camera', base, 'viewer-a'),
    manager.ensure('camera', base, 'viewer-b'),
  ]);
  assert.equal(a, b);
  await manager.waitReady(a);
  assert.equal(downloads, 3); // One manifest and two startup segments, shared by both consumers.
  assert.equal(a.leases.size, 2);
  await assert.rejects(manager.ensure('camera', base, 'viewer-c'));
  manager.release('camera', 'viewer-a');
  assert.equal(manager.stats().sessions, 1);
  assert.equal(manager.getSegment('camera', a.token, 0, 'viewer-a'), null);
  assert.equal(manager.getSegment('camera', a.token, 0, 'viewer-b').length, 3);
  assert.match(
    await manager.buildPlaylist(b, 'camera', 'viewer-b'),
    /lease=viewer-b/,
  );
  manager.release('camera', 'viewer-a'); // Duplicate/late release cannot stop B.
  assert.equal(b.controller.signal.aborted, false);
  manager.release('camera', 'viewer-b');
  assert.equal(b.controller.signal.aborted, true);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  await manager.shutdown();
});

test('an abandoned consumer expires while a renewed consumer keeps the session', async () => {
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, idleMs: 80, pollMs: 100000 },
    fetchImpl: async (url) =>
      new Response(url.endsWith('.m3u8') ? playlist : 'abc'),
  });
  const entry = await manager.ensure('camera', base, 'abandoned');
  await manager.ensure('camera', base, 'active');
  await new Promise((r) => setTimeout(r, 50));
  await manager.ensure('camera', base, 'active');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(entry.leases.has('abandoned'), false);
  assert.equal(entry.leases.has('active'), true);
  assert.equal(entry.controller.signal.aborted, false);
  await manager.shutdown();
});

test('an expired old segment is skipped once as the live window advances', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let current = playlist;
  let expiredFetches = 0;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, segmentBytes: 1024 },
    fetchImpl: async (url) => {
      if (url.endsWith('.m3u8')) return new Response(current);
      if (url.endsWith('a.ts')) {
        expiredFetches++;
        return new Response('', { status: 404 });
      }
      return new Response('current');
    },
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('expired', base);
  await entry.polling;
  assert.equal(await manager.waitReady(entry), true);
  assert.equal(entry.segments.size, 2);
  assert.equal(manager.stats().bytes, 14);
  const output = await manager.buildPlaylist(entry, 'expired');
  assert.match(output, /#EXT-X-DISCONTINUITY\n#EXTINF/);

  for (const next of ['', '#EXTINF:2,\nd.ts\n', '#EXTINF:2,\ne.ts\n']) {
    current += next;
    t.mock.timers.tick(HLS_LIMITS.pollMs);
    await entry.polling;
  }
  assert.equal(expiredFetches, 1);
  assert.deepEqual(
    [...entry.segments.values()].map((segment) => segment.discontinuity),
    [true, false, false, false],
  );
  assert.deepEqual([...entry.upstream.keys()], [12, 13, 14, 15, 16]);
  assert.equal(
    (await manager.buildPlaylist(entry, 'expired')).match(
      /#EXT-X-DISCONTINUITY\n/g,
    ).length,
    1,
  );
});

test('recent missing segments and access failures still exhaust the retry budget', async (t) => {
  for (const [file, status] of [
    ['c.ts', 404],
    ['b.ts', 404],
    ['a.ts', 403],
  ]) {
    const manager = createHlsPuller({
      limits: { ...HLS_LIMITS, segmentBytes: 1024, pollMs: 1, readyMs: 1000 },
      fetchImpl: async (url) =>
        url.endsWith('.m3u8')
          ? new Response(
              status === 404
                ? playlist.replace('#EXTINF:2,\na.ts\n', '')
                : playlist,
            )
          : url.endsWith(file)
            ? new Response('', { status })
            : new Response('current'),
    });
    t.after(() => manager.shutdown());
    const entry = await manager.ensure(`${file}-${status}`, base);
    assert.equal(await manager.waitReady(entry), false);
    assert.equal(entry.stopping, true);
    assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  }
});

test('1080p segments fit the bounded downloader while oversized responses still fail', async () => {
  const bytes = new Uint8Array(8 * 1024 * 1024 + 1024);
  const body = await fetchHlsBytes(base, {
    maxBytes: HLS_LIMITS.segmentBytes,
    fetchImpl: async () => new Response(bytes),
  });
  assert.equal(body.length, bytes.length);
  await assert.rejects(
    fetchHlsBytes(base, {
      maxBytes: HLS_LIMITS.segmentBytes,
      fetchImpl: async () =>
        new Response('x', {
          headers: { 'content-length': String(HLS_LIMITS.segmentBytes + 1) },
        }),
    }),
    /too large/,
  );
});
