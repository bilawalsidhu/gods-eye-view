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
const mp4Playlist =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA-SEQUENCE:20\n' +
  '#EXT-X-MAP:URI="camera_init.mp4?token=private"\n' +
  '#EXTINF:2,\na.mp4?token=private\n#EXTINF:2,\nb.mp4?token=private\n#EXTINF:2,\nc.mp4?token=private\n';

test('high-resolution HLS segments play while the retained session cache stays bounded', async (t) => {
  // Giroc publishes roughly ten-second TS segments; one measured 6,437,120
  // bytes. The former 4 MiB download cap rejected it before playback began.
  const segmentBytes = 6_437_120;
  const master =
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4570000\ntracks-v1a1/mono.m3u8\n';
  const media =
    '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n' +
    [0, 1, 2, 3, 4].map((i) => `#EXTINF:10.272,\n${i}.ts\n`).join('');
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 100000 },
    fetchImpl: async (url) => {
      if (url === base) return new Response(master);
      if (url === 'https://camera.example/live/tracks-v1a1/mono.m3u8')
        return new Response(media);
      const match =
        /^https:\/\/camera\.example\/live\/tracks-v1a1\/([0-4])\.ts$/.exec(url);
      if (!match) throw new Error('Unexpected playlist reference');
      // No Content-Length: the actual streamed bytes must also be accepted.
      return new Response(Buffer.alloc(segmentBytes, Number(match[1])));
    },
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('giroc', base);
  await entry.polling;
  const result = await manager.buildPlaylist(entry, 'giroc');
  assert.ok(result, 'large valid segments should produce a playable playlist');
  assert.match(result, /#EXT-X-MEDIA-SEQUENCE:2\n/);
  assert.equal(manager.getSegment('giroc', entry.token, 0), null);
  const newest = manager.getSegment('giroc', entry.token, 4);
  assert.equal(newest.length, segmentBytes);
  assert.equal(newest[0], 4);
  assert.deepEqual(manager.stats(), { sessions: 1, bytes: 19_311_360 });
});

test('HLS downloads still reject declared and chunked bodies above 8 MiB', async () => {
  for (const declared of [true, false]) {
    let chunks = 0;
    let cancelled = false;
    await assert.rejects(
      fetchHlsBytes(base, {
        maxBytes: HLS_LIMITS.segmentBytes,
        fetchImpl: async () =>
          new Response(
            declared
              ? 'small body'
              : new ReadableStream({
                  pull(controller) {
                    // Each chunk fits on its own; only their cumulative size
                    // crosses the cap. Leave it open to verify cancellation.
                    controller.enqueue(
                      Buffer.alloc(4 * 1024 * 1024 + (++chunks === 2 ? 1 : 0)),
                    );
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
            {
              headers: declared
                ? { 'content-length': String(8 * 1024 * 1024 + 1) }
                : {},
            },
          ),
      }),
      /HLS response too large/,
    );
    if (!declared) assert.equal(cancelled, true);
  }
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

test('fMP4 parser carries the initialization map through segment trimming and pins all references', () => {
  const parsed = parseHlsMedia(mp4Playlist, base, 2);
  assert.deepEqual(
    parsed.map((item) => item.seq),
    [21, 22],
  );
  assert.ok(parsed.every((item) => item.extension === 'mp4'));
  assert.ok(
    parsed.every(
      (item) =>
        item.initUri ===
        'https://camera.example/live/camera_init.mp4?token=private',
    ),
  );
  for (const bad of [
    mp4Playlist.replace(
      'camera_init.mp4?token=private',
      '//evil.example/init.mp4',
    ),
    mp4Playlist.replace(
      'camera_init.mp4?token=private',
      'https://user@camera.example/init.mp4',
    ),
    mp4Playlist.replace(
      'camera_init.mp4?token=private',
      'http://camera.example/init.mp4',
    ),
    mp4Playlist.replace(
      'camera_init.mp4?token=private',
      'data:video/mp4,hello',
    ),
    mp4Playlist.replace('camera_init.mp4?token=private', 'init.ts'),
    mp4Playlist.replace(
      'URI="camera_init.mp4?token=private"',
      'URI="camera_init.mp4",BYTERANGE="10@0"',
    ),
    mp4Playlist.replace(
      'URI="camera_init.mp4?token=private"',
      'URI="camera_init.mp4",URI="other.mp4"',
    ),
    mp4Playlist.replace('#EXTINF:2,', '#EXT-X-BYTERANGE:10@0\n#EXTINF:2,'),
    mp4Playlist.replace(
      '#EXT-X-VERSION:7',
      '#EXT-X-KEY:METHOD=AES-128,URI="key"',
    ),
    mp4Playlist.replace(
      '#EXT-X-VERSION:7',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"',
    ),
    mp4Playlist.replace('#EXT-X-MAP:URI="camera_init.mp4?token=private"\n', ''),
    mp4Playlist.replace('a.mp4?token=private', '//evil.example/a.mp4'),
    mp4Playlist.replace(
      'a.mp4?token=private',
      'https://user@camera.example/a.mp4',
    ),
    mp4Playlist.replace('a.mp4?token=private', 'a.ts'),
  ])
    assert.throws(() => parseHlsMedia(bad, base));
  for (const limit of [0, -1, Infinity, 1.5])
    assert.throws(() => parseHlsMedia(mp4Playlist, base, limit));
});

test('fMP4 init is downloaded once, shares the session budget, and is served only to its lease', async () => {
  const seen = [];
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, segments: 2, sessionBytes: 8, pollMs: 100000 },
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(
        url.endsWith('.m3u8')
          ? mp4Playlist
          : url.includes('_init.mp4')
            ? 'in'
            : 'seg',
      );
    },
  });
  try {
    const entry = await manager.ensure('fmp4', base, 'viewer');
    await entry.polling;
    assert.deepEqual(manager.stats(), { sessions: 1, bytes: 8 });
    assert.equal(seen.filter((url) => url.includes('_init.mp4')).length, 1);
    const output = await manager.buildPlaylist(entry, 'fmp4', 'viewer');
    assert.match(output, /#EXT-X-VERSION:7/);
    assert.match(
      output,
      /#EXT-X-MAP:URI="\/api\/cctv\/media\/fmp4\/init_0\.mp4\?session=/,
    );
    assert.match(output, /seg_0\.mp4/);
    assert.doesNotMatch(output, /token=private|camera\.example/);
    assert.equal(
      manager.getInitSegment('fmp4', entry.token, 0, 'viewer').toString(),
      'in',
    );
    assert.equal(
      manager.getInitSegment('fmp4', 'old-token', 0, 'viewer'),
      null,
    );
    assert.equal(manager.getInitSegment('fmp4', entry.token, 0, 'other'), null);
    assert.equal(manager.getSegment('fmp4', entry.token, 0, 'viewer'), null);
    assert.equal(
      manager.getSegment('fmp4', entry.token, 0, 'viewer', 'mp4').toString(),
      'seg',
    );
    manager.release('fmp4', 'viewer');
    assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
    assert.equal(entry.initSegments.size, 0);
    assert.equal(
      manager.getInitSegment('fmp4', entry.token, 0, 'viewer'),
      null,
    );
  } finally {
    await manager.shutdown();
  }
});

test('fMP4 cache evicts an unreferenced initialization object and keeps local map identity', async () => {
  const changing =
    mp4Playlist +
    '#EXT-X-MAP:URI="second_init.mp4"\n#EXTINF:2,\nd.mp4\n#EXTINF:2,\ne.mp4\n';
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, sessionBytes: 8, pollMs: 100000 },
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('.m3u8')
          ? changing
          : url.includes('_init.mp4')
            ? 'in'
            : 'seg',
      ),
  });
  try {
    const entry = await manager.ensure('fmp4', base);
    await entry.polling;
    assert.deepEqual(manager.stats(), { sessions: 1, bytes: 8 });
    assert.equal(entry.initSegments.size, 1);
    assert.equal(manager.getInitSegment('fmp4', entry.token, 0), null);
    assert.equal(
      manager.getInitSegment('fmp4', entry.token, 1).toString(),
      'in',
    );
    const output = await manager.buildPlaylist(entry, 'fmp4');
    assert.match(output, /init_1\.mp4/);
    assert.doesNotMatch(output, /init_0\.mp4/);
  } finally {
    await manager.shutdown();
  }
});

test('an initialization-map change invalidates reused upstream sequences', async () => {
  let current = mp4Playlist;
  let resolverCameraId;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 5 },
    resolveUrl: async (url, _signal, cameraId) => {
      resolverCameraId = cameraId;
      return url;
    },
    fetchImpl: async (url) =>
      new Response(url.endsWith('.m3u8') ? current : 'bytes'),
  });
  try {
    const entry = await manager.ensure('fmp4', base);
    await entry.polling;
    current = mp4Playlist.replace('camera_init.mp4', 'second_init.mp4');
    for (let i = 0; i < 100 && entry.nextSeq < 6; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(resolverCameraId, 'fmp4');
    assert.equal(entry.nextSeq, 6);
    const output = await manager.buildPlaylist(entry, 'fmp4');
    assert.match(output, /init_0\.mp4/);
    assert.match(
      output,
      /#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="[^"\n]+init_1\.mp4/,
    );
    assert.match(output, /seg_5\.mp4/);
  } finally {
    await manager.shutdown();
  }
});

test('fMP4 init downloads and init-plus-segment retention stay bounded', async () => {
  for (const limits of [
    { ...HLS_LIMITS, initBytes: 1, pollMs: 100000 },
    { ...HLS_LIMITS, sessionBytes: 4, pollMs: 100000 },
  ]) {
    const manager = createHlsPuller({
      limits,
      fetchImpl: async (url) =>
        new Response(
          url.endsWith('.m3u8')
            ? mp4Playlist
            : url.includes('_init.mp4')
              ? 'in'
              : 'seg',
        ),
    });
    try {
      const entry = await manager.ensure('fmp4', base);
      await entry.polling;
      assert.equal(entry.failures, 1);
      assert.equal(entry.initSegments.size, 0);
      assert.deepEqual(manager.stats(), { sessions: 1, bytes: 0 });
    } finally {
      await manager.shutdown();
    }
  }
});

test('shutdown aborts an in-flight initialization download and cannot retain late bytes', async () => {
  let initStarted;
  const started = new Promise((resolve) => {
    initStarted = resolve;
  });
  let initSignal;
  const manager = createHlsPuller({
    fetchImpl: async (url, { signal }) => {
      if (url.endsWith('.m3u8')) return new Response(mp4Playlist);
      initSignal = signal;
      initStarted();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    },
  });
  const entry = await manager.ensure('fmp4', base);
  await started;
  await manager.shutdown();
  assert.equal(initSignal.aborted, true);
  assert.equal(entry.initSegments.size, 0);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
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
  assert.equal(manager.getSegment('a', a.token, 0, 'legacy', 'mp4'), null);
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
    /#EXT-X-DISCONTINUITY\n#EXTINF:2\.000,\n\/api\/cctv\/media\/a\/seg_3\.ts/,
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
    /#EXT-X-DISCONTINUITY\n#EXTINF:2\.000,\n\/api\/cctv\/media\/a\/seg_3\.ts/,
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
  assert.equal(downloads, 4); // One manifest and three segments, not per consumer.
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
