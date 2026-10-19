import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cctvProxy } from '../../server/providers/cctv.js';
import {
  createHlsPuller,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';

const base = 'https://camera.example/live/master.m3u8';
const master =
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=848000\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=50400\nlow.m3u8\n';
const media = (prefix, seq = 12) =>
  `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${seq}\n#EXTINF:2,\n${prefix}a.ts\n#EXTINF:2,\n${prefix}b.ts\n`;
function fixture(t, respond, limits = {}) {
  const calls = [];
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 100000, ...limits },
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'error');
      return respond(url, options);
    },
  });
  t.after(() => manager.shutdown());
  return { manager, calls };
}

const threeRenditions =
  '#EXTM3U\n' +
  [800, 700, 600]
    .map((bw) => `#EXT-X-STREAM-INF:BANDWIDTH=${bw}\n${bw}.m3u8\n`)
    .join('');
// Match the consumer: each listed URI increments SN; each marker increments CC.
function playlistIdentities(text) {
  let sn = Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1]);
  let cc = Number(text.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/)[1]);
  const identities = new Map();
  for (const line of text.trim().split('\n')) {
    if (line === '#EXT-X-DISCONTINUITY') cc++;
    if (line && !line.startsWith('#')) identities.set(line, { sn: sn++, cc });
  }
  return identities;
}

async function publishedRollingWindows(t, failAtStartup = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failing = failAtStartup;
  let lowSeq = 30;
  const { manager, calls } = fixture(
    t,
    (url) => {
      if (url === base) return new Response(threeRenditions);
      if (url.endsWith('800.m3u8'))
        return new Response(
          media(failing ? 'failed-high-' : 'high-', failing ? 14 : 12),
        );
      if (url.endsWith('700.m3u8')) return new Response(media('middle-', 20));
      if (url.endsWith('600.m3u8'))
        return new Response(media(`low-${lowSeq}-`, lowSeq));
      if (url.endsWith('failed-high-b.ts') || url.endsWith('middle-b.ts'))
        return new Response('', { status: 404 });
      return new Response('ts');
    },
    { pollMs: HLS_LIMITS.pollMs },
  );
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  const initial = playlistIdentities(
    await manager.buildPlaylist(entry, 'camera'),
  );
  if (!failAtStartup) {
    failing = true;
    t.mock.timers.tick(HLS_LIMITS.pollMs);
    await entry.polling;
  }
  const privateStart = failAtStartup ? 0 : 2;
  for (const id of [privateStart, privateStart + 1])
    assert.equal(manager.getSegment('camera', entry.token, id), null);
  assert.equal(entry.failures, 0);
  assert.equal(
    calls.filter((url) => url === base).length,
    failAtStartup ? 1 : 2,
  );
  const snapshots = [
    playlistIdentities(await manager.buildPlaylist(entry, 'camera')),
  ];
  for (let i = 0; i < 6; i++) {
    lowSeq += 2;
    t.mock.timers.tick(HLS_LIMITS.pollMs);
    await entry.polling;
    assert.ok(entry.segments.size <= HLS_LIMITS.segments);
    assert.ok(entry.bytes <= HLS_LIMITS.sessionBytes);
    snapshots.push(
      playlistIdentities(await manager.buildPlaylist(entry, 'camera')),
    );
  }
  assert.equal(entry.segments.has(privateStart + 1), false);
  return { initial, snapshots };
}

test('published media sequences stay contiguous and stable across default-cap rolling eviction', async (t) => {
  for (const failAtStartup of [false, true]) {
    await t.test(
      failAtStartup
        ? 'first publication after failed partials'
        : 'fallback after published success',
      async (t) => {
        const { initial, snapshots } = await publishedRollingWindows(
          t,
          failAtStartup,
        );
        assert.deepEqual(
          [...initial.values()].map(({ sn }) => sn),
          [0, 1],
        );
        const first = snapshots[0];
        assert.deepEqual(
          [...first.values()].map(({ sn }) => sn),
          failAtStartup ? [0, 1] : [0, 1, 2, 3],
        );
        const seen = new Map(initial);
        let lastEnd = [...first.values()].at(-1).sn;
        for (const [i, snapshot] of snapshots.entries()) {
          const rows = [...snapshot.values()];
          assert.deepEqual(
            rows.map(({ sn }) => sn),
            rows.map((_, index) => rows[0].sn + index),
          );
          if (i) assert.equal(rows.at(-1).sn, lastEnd + 2);
          lastEnd = rows.at(-1).sn;
          let overlaps = 0;
          for (const [uri, identity] of snapshot) {
            if (seen.has(uri)) {
              overlaps++;
              assert.equal(
                identity.sn,
                seen.get(uri).sn,
                `retained media identity: ${uri}`,
              );
            }
            seen.set(uri, identity);
          }
          assert.ok(overlaps >= 2);
        }
        assert.ok([...snapshots.at(-1).values()][0].sn > 0);
      },
    );
  }
});

test('published discontinuity identities ignore evicted failed intermediate renditions', async (t) => {
  for (const failAtStartup of [false, true]) {
    await t.test(
      failAtStartup
        ? 'first published discontinuity'
        : 'retained fallback discontinuity',
      async (t) => {
        const { initial, snapshots } = await publishedRollingWindows(
          t,
          failAtStartup,
        );
        assert.deepEqual(
          [...snapshots[0].values()].map(({ cc }) => cc),
          failAtStartup ? [1, 1] : [0, 0, 1, 1],
        );
        const seen = new Map(initial);
        for (const snapshot of snapshots) {
          let overlaps = 0;
          for (const [uri, identity] of snapshot) {
            if (seen.has(uri)) {
              overlaps++;
              assert.equal(
                identity.cc,
                seen.get(uri).cc,
                `retained discontinuity identity: ${uri}`,
              );
            }
            seen.set(uri, identity);
          }
          assert.ok(overlaps >= 2);
        }
        assert.deepEqual(
          [...snapshots.at(-1).values()].map(({ cc }) => cc),
          Array(12).fill(1),
        );
      },
    );
  }
});

test('publication preserves a skipped-cache discontinuity after a failed same-rendition prefix is evicted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let phase = 0;
  const { manager } = fixture(
    t,
    (url) => {
      if (url === base) {
        const start = phase === 0 ? 0 : phase === 1 ? 2 : 14;
        const count = phase === 1 ? 12 : 2;
        return new Response(
          `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${start}\n` +
            Array.from(
              { length: count },
              (_, i) => `#EXTINF:2,\n${start + i}.ts\n`,
            ).join(''),
        );
      }
      if (url.endsWith('/13.ts')) return new Response('', { status: 404 });
      return new Response('ts');
    },
    { pollMs: HLS_LIMITS.pollMs },
  );
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  phase = 1;
  t.mock.timers.tick(HLS_LIMITS.pollMs);
  await entry.polling;
  assert.equal(entry.failures, 1);
  assert.equal(entry.segments.size, 12);
  assert.equal(manager.getSegment('camera', entry.token, 2), null);
  phase = 2;
  t.mock.timers.tick(HLS_LIMITS.pollMs);
  await entry.polling;
  const before = playlistIdentities(
    await manager.buildPlaylist(entry, 'camera'),
  );
  assert.equal(entry.segments.has(2), false);
  assert.equal([...before.values()][0].sn, 2);
  assert.deepEqual(
    [...before.values()].map(({ cc }) => cc),
    Array(12).fill(1),
  );
  t.mock.timers.tick(HLS_LIMITS.pollMs);
  await entry.polling;
  assert.deepEqual(
    playlistIdentities(await manager.buildPlaylist(entry, 'camera')),
    before,
  );
});

test('nonempty publication remains unchanged on repeat success and a stopped late poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let phase = 0;
  const reached = Promise.withResolvers();
  const late = Promise.withResolvers();
  const { manager, calls } = fixture(
    t,
    (url) => {
      if (url === base) return new Response(media('direct-', phase ? 14 : 12));
      if (phase && url.endsWith('b.ts')) {
        reached.resolve();
        return late.promise;
      }
      return new Response('ts');
    },
    { pollMs: HLS_LIMITS.pollMs },
  );
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  const initial = await manager.buildPlaylist(entry, 'camera');
  assert.deepEqual(
    [...playlistIdentities(initial).values()],
    [
      { sn: 0, cc: 0 },
      { sn: 1, cc: 0 },
    ],
  );
  assert.equal(manager.getSegment('camera', entry.token, 0).toString(), 'ts');
  t.mock.timers.tick(HLS_LIMITS.pollMs);
  await entry.polling;
  assert.equal(await manager.buildPlaylist(entry, 'camera'), initial);
  assert.equal(entry.nextPublishedSeq, 2);
  phase = 1;
  t.mock.timers.tick(HLS_LIMITS.pollMs);
  await reached.promise;
  try {
    assert.equal(await manager.buildPlaylist(entry, 'camera'), initial);
    assert.equal(manager.getSegment('camera', entry.token, 2), null);
  } finally {
    manager.stop('camera', entry.token);
    late.resolve(new Response('late'));
    await entry.polling;
  }
  assert.equal(entry.nextPublishedSeq, 2);
  assert.equal(await manager.buildPlaylist(entry, 'camera'), null);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  const count = calls.length;
  t.mock.timers.tick(100000);
  assert.equal(calls.length, count);
});

function partialRendition(url) {
  if (url === base) return new Response(threeRenditions);
  if (url.endsWith('.m3u8'))
    return new Response(media(`${new URL(url).pathname.split('/').at(-1)}-`));
  return url.endsWith('b.ts')
    ? new Response('', { status: 404 })
    : new Response('ts');
}

test('failed rendition partials cannot establish readiness or a published playlist', async (t) => {
  const { manager, calls } = fixture(t, partialRendition, { readyMs: 1 });
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  assert.equal(entry.failures, 1);
  assert.equal(entry.chunklistUrl, null);
  assert.equal(calls.filter((url) => url === base).length, 1);
  assert.equal(calls.filter((url) => url.endsWith('.m3u8')).length, 4);
  assert.equal(await manager.waitReady(entry), false);
  assert.equal(await manager.buildPlaylist(entry, 'camera'), null);
  for (const seq of entry.segments.keys())
    assert.equal(manager.getSegment('camera', entry.token, seq), null);
});

test('a rendition must complete before its downloaded segments become available', async (t) => {
  const reached = Promise.withResolvers();
  const late = Promise.withResolvers();
  const { manager } = fixture(
    t,
    (url) => {
      if (url === base)
        return new Response(media('direct-') + '#EXTINF:2,\ndirect-c.ts\n');
      if (url.endsWith('c.ts')) {
        reached.resolve();
        return late.promise;
      }
      return new Response('ts');
    },
    { readyMs: 1 },
  );
  const entry = await manager.ensure('camera', base);
  await reached.promise;
  try {
    assert.equal(entry.segments.size, 2);
    assert.equal(await manager.waitReady(entry), false);
    assert.equal(await manager.buildPlaylist(entry, 'camera'), null);
  } finally {
    late.resolve(new Response('ts'));
    await entry.polling;
  }
  assert.equal(await manager.waitReady(entry), true);
  assert.match(await manager.buildPlaylist(entry, 'camera'), /seg_2\.ts/);
});

test('failed fallback preserves only the retained successful window within the cache cap', async (t) => {
  for (const segments of [HLS_LIMITS.segments, 2]) {
    await t.test(`cache cap ${segments}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let failed = false;
      const { manager } = fixture(
        t,
        (url) => {
          if (failed) return partialRendition(url);
          if (url === base) return new Response(threeRenditions);
          return new Response(url.endsWith('.m3u8') ? media('good-') : 'good');
        },
        { pollMs: 2000, segments },
      );
      const entry = await manager.ensure('camera', base);
      await entry.polling;
      const before = await manager.buildPlaylist(entry, 'camera');
      assert.match(before, /seg_1\.ts/);
      failed = true;
      t.mock.timers.tick(2000);
      await entry.polling;
      assert.equal(entry.failures, 1);
      assert.ok(entry.segments.size <= segments);
      const after = await manager.buildPlaylist(entry, 'camera');
      if (segments === 2) assert.equal(after, null);
      else assert.equal(after, before);
    });
  }
});

function recordingResponse() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (body = '') => {
    res.body = Buffer.from(body).toString();
    res.writableEnded = true;
    res.emit('finish');
  };
  return res;
}

test('actual HLS middleware returns 503 rather than healthy live status for all-partial renditions', async (t) => {
  const before = { ...process.env };
  const server = new EventEmitter();
  t.after(() => {
    server.emit('close');
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  });
  for (const key of Object.keys(process.env))
    if (key.startsWith('CCTV_') || key.startsWith('GOOGLE_MAPS'))
      delete process.env[key];
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    {
      id: 'camera',
      name: 'fixture',
      lat: 40,
      lon: -105,
      feedType: 'hls',
      url: base,
    },
  ]);
  process.env.CCTV_SOURCES_FILE = 'absent-availability-fixture.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  t.mock.method(globalThis, 'fetch', async (url) => partialRendition(url));
  let handler;
  cctvProxy().configureServer({
    httpServer: server,
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  const res = recordingResponse();
  await handler(
    {
      url: '/media/camera?lease=11111111-1111-4111-8111-111111111111',
      method: 'GET',
      headers: {},
    },
    res,
  );
  assert.equal(res.statusCode, 503);
  const health = recordingResponse();
  await handler({ url: '/health', method: 'GET', headers: {} }, health);
  const camera = JSON.parse(health.body).cameras.find(
    (entry) => entry.id === 'camera',
  );
  assert.notEqual(camera?.status, 'ok');
  assert.notEqual(camera?.message, 'Live HLS connected');
});

test('empty segment responses never enter the cache or mapping and retain bounded failure teardown', async (t) => {
  for (const status of [200, 204]) {
    for (const fallback of [false, true]) {
      await t.test(
        `${status} ${fallback ? 'fallback' : 'direct'}`,
        async (t) => {
          t.mock.timers.enable({ apis: ['setTimeout'] });
          const { manager, calls } = fixture(
            t,
            (url) => {
              if (url === base)
                return new Response(fallback ? master : media('empty-'));
              if (url.endsWith('high.m3u8'))
                return new Response('', { status: 404 });
              if (url.endsWith('.m3u8')) return new Response(media('empty-'));
              return new Response(status === 204 ? null : '', { status });
            },
            { pollMs: 2000 },
          );
          const entry = await manager.ensure('camera', base);
          for (let failure = 1; failure <= 3; failure++) {
            if (failure > 1) t.mock.timers.tick(2000);
            await entry.polling;
            assert.equal(entry.segments.size, 0);
            assert.equal(entry.upstream.size, 0);
            assert.equal(entry.bytes, 0);
            assert.equal(entry.nextSeq, 0);
            assert.equal(entry.chunklistUrl, null);
            assert.equal(entry.failures, failure);
            assert.equal(await manager.buildPlaylist(entry, 'camera'), null);
            assert.equal(
              calls.filter((url) => url.endsWith('empty-a.ts')).length,
              failure,
            );
          }
          assert.equal(entry.stopping, true);
          assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
        },
      );
    }
  }
});

test('an empty fallback can be skipped for usable media within the three-attempt cap', async (t) => {
  for (const status of [200, 204]) {
    await t.test(String(status), async (t) => {
      const { manager, calls } = fixture(t, (url) => {
        if (url === base) return new Response(threeRenditions);
        if (url.endsWith('800.m3u8')) return new Response('', { status: 404 });
        if (url.endsWith('700.m3u8')) return new Response(media('empty-'));
        if (url.endsWith('600.m3u8')) return new Response(media('good-'));
        if (url.includes('empty-'))
          return new Response(status === 204 ? null : '', { status });
        return new Response('ts');
      });
      const entry = await manager.ensure('camera', base);
      await entry.polling;
      assert.equal(entry.chunklistUrl, 'https://camera.example/live/600.m3u8');
      assert.equal(entry.failures, 0);
      assert.equal(entry.segments.size, 2);
      assert.equal(entry.bytes, 4);
      assert.equal(entry.upstream.size, 2);
      assert.equal(await manager.waitReady(entry), true);
      assert.equal(calls.filter((url) => url.endsWith('.m3u8')).length, 4);
      assert.equal(calls.filter((url) => url.includes('empty-')).length, 1);
      assert.deepEqual(
        [...entry.segments.values()].map((s) => s.body.toString()),
        ['ts', 'ts'],
      );
    });
  }
});

test('empty updates preserve a valid window without resetting failures or caching empty sequences', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let empty = false;
  const { manager, calls } = fixture(
    t,
    (url) => {
      if (url === base) return new Response(media('direct-', empty ? 14 : 12));
      return new Response(empty ? '' : 'ts');
    },
    { pollMs: 2000, segments: 2, sessionBytes: 4 },
  );
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  const before = await manager.buildPlaylist(entry, 'camera');
  empty = true;
  for (let failure = 1; failure <= 2; failure++) {
    t.mock.timers.tick(2000);
    await entry.polling;
    assert.equal(entry.failures, failure);
    assert.equal(entry.bytes, 4);
    assert.equal(entry.upstream.has(14), false);
    assert.equal(await manager.buildPlaylist(entry, 'camera'), before);
  }
  assert.equal(calls.filter((url) => url.endsWith('direct-a.ts')).length, 3);
});

test('unavailable first advertised child falls back to a lower advertised rendition', async (t) => {
  const { manager, calls } = fixture(t, (url) => {
    if (url === base) return new Response(master);
    if (url.endsWith('high.m3u8')) return new Response('', { status: 404 });
    if (url.endsWith('low.m3u8')) return new Response(media('low-'));
    return new Response('low');
  });
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  assert.equal(entry.segments.size, 2);
  assert.equal(entry.url, base);
  assert.deepEqual(
    calls.map((url) => new URL(url).pathname),
    [
      '/live/master.m3u8',
      '/live/high.m3u8',
      '/live/low.m3u8',
      '/live/low-a.ts',
      '/live/low-b.ts',
    ],
  );
  assert.equal(manager.getSegment('camera', entry.token, 0).toString(), 'low');
  assert.match(await manager.buildPlaylist(entry, 'camera'), /seg_1\.ts/);
});

test('stop during fallback aborts downloads and fences late responses from a replacement session', async (t) => {
  for (const target of ['high.m3u8', 'low.m3u8', 'low-a.ts']) {
    await t.test(target, async (t) => {
      const reached = Promise.withResolvers();
      const late = Promise.withResolvers();
      let observedSignal;
      let blocked = false;
      const { manager, calls } = fixture(t, (url, { signal }) => {
        if (!blocked && url.endsWith(target)) {
          blocked = true;
          observedSignal = signal;
          reached.resolve();
          return late.promise; // Deliberately ignores cancellation until resolved.
        }
        if (url === base) return new Response(master);
        if (url.endsWith('high.m3u8')) return new Response('', { status: 404 });
        if (url.endsWith('low.m3u8')) return new Response(media('low-'));
        return new Response('low');
      });
      const old = await manager.ensure('camera', base);
      await reached.promise;
      manager.stop('camera', old.token);
      assert.equal(observedSignal.aborted, true);
      const replacement = await manager.ensure('camera', base);
      await replacement.polling;
      const before = calls.length;
      late.resolve(
        new Response(target.endsWith('.m3u8') ? media('late-') : 'late'),
      );
      await old.polling;
      assert.equal(calls.length, before);
      assert.equal(old.segments.size, 0);
      assert.equal(old.upstream.size, 0);
      assert.equal(old.bytes, 0);
      assert.equal(manager.getSegment('camera', old.token, 0), null);
      assert.equal(
        manager.getSegment('camera', replacement.token, 0).toString(),
        'low',
      );
      assert.deepEqual(manager.stats(), { sessions: 1, bytes: 6 });
    });
  }
});

test('all variants failing stops after three bounded polls without retrying duplicate or higher renditions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const many =
    '#EXTM3U\n' +
    [800, 800, 900, 700, 600, 500, 400]
      .map((bw) => `#EXT-X-STREAM-INF:BANDWIDTH=${bw}\n${bw}.m3u8\n`)
      .join('');
  const { manager, calls } = fixture(
    t,
    (url) =>
      url === base ? new Response(many) : new Response('', { status: 404 }),
    { pollMs: 2000 },
  );
  const entry = await manager.ensure('camera', base);
  for (let poll = 0; poll < 3; poll++) {
    if (poll) t.mock.timers.tick(2000);
    await entry.polling;
    assert.equal(calls.length, (poll + 1) * 4);
    assert.equal(entry.failures, poll + 1);
  }
  assert.deepEqual(
    calls.map((url) => new URL(url).pathname),
    Array(3)
      .fill([
        '/live/master.m3u8',
        '/live/800.m3u8',
        '/live/700.m3u8',
        '/live/600.m3u8',
      ])
      .flat(),
  );
  assert.equal(entry.stopping, true);
  assert.equal(await manager.buildPlaylist(entry, 'camera'), null);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  t.mock.timers.tick(100000);
  assert.equal(calls.length, 12);
});

test('mid-session failure refreshes the registered master and switches once with monotonic discontinuity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let generation = 0;
  const { manager, calls } = fixture(
    t,
    (url) => {
      if (url === base)
        return new Response(
          generation ? master.replace('low.m3u8', 'renewed-low.m3u8') : master,
        );
      if (url.endsWith('high.m3u8'))
        return new Response(media('high-', generation ? 14 : 12));
      if (url.endsWith('renewed-low.m3u8')) return new Response(media('low-'));
      if (generation && url.includes('high-'))
        return new Response('', { status: 404 });
      return new Response(url.includes('high-') ? 'high' : 'low');
    },
    { pollMs: 2000 },
  );
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  assert.deepEqual(
    [...entry.segments.values()].map((s) => s.body.toString()),
    ['high', 'high'],
  );
  assert.equal(
    calls.some((url) => url.endsWith('low.m3u8')),
    false,
  );
  generation++;
  t.mock.timers.tick(2000);
  await entry.polling;
  assert.deepEqual(
    [...entry.segments.values()].map((s) => [s.seq, s.body.toString()]),
    [
      [0, 'high'],
      [1, 'high'],
      [2, 'low'],
      [3, 'low'],
    ],
  );
  assert.deepEqual(
    [...entry.upstream.values()].map((url) => new URL(url).pathname),
    ['/live/low-a.ts', '/live/low-b.ts'],
  );
  assert.match(
    await manager.buildPlaylist(entry, 'camera'),
    /#EXT-X-DISCONTINUITY\n#EXTINF:2\.000,\n\/api\/cctv\/media\/camera\/seg_2\.ts/,
  );
  const before = calls.length;
  t.mock.timers.tick(2000);
  await entry.polling;
  assert.deepEqual(calls.slice(before), [
    'https://camera.example/live/renewed-low.m3u8',
  ]);
  assert.equal(calls.filter((url) => url === base).length, 2);
});

test('an expired lower child renews the same advertised quality instead of restarting at high', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let expired = false;
  const { manager, calls } = fixture(
    t,
    (url) => {
      if (url === base)
        return new Response(
          expired ? master.replace('low.m3u8', 'new-low.m3u8') : master,
        );
      if (url.endsWith('/high.m3u8') || (expired && url.endsWith('/low.m3u8')))
        return new Response('', { status: 404 });
      if (url.endsWith('.m3u8')) return new Response(media('low-'));
      return new Response('low');
    },
    { pollMs: 2000 },
  );
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  expired = true;
  const before = calls.length;
  t.mock.timers.tick(2000);
  await entry.polling;
  assert.deepEqual(
    calls.slice(before).map((url) => new URL(url).pathname),
    [
      '/live/low.m3u8',
      '/live/master.m3u8',
      '/live/new-low.m3u8',
      '/live/low-a.ts',
      '/live/low-b.ts',
    ],
  );
  // Even identical upstream sequence/segment URLs belong to a new rendition mapping.
  assert.equal(entry.segments.size, 4);
  assert.equal(entry.segments.get(2).discontinuity, true);
  assert.equal(entry.failures, 0);
});

test('malformed or escaping masters fail closed before any child request', async (t) => {
  const badMasters = {
    header: master.replace('#EXTM3U', '#NOT-HLS'),
    unpaired: master.replace('#EXT-X-STREAM-INF:BANDWIDTH=848000\n', ''),
    missingUri: master + '#EXT-X-STREAM-INF:BANDWIDTH=1\n',
    missingBandwidth: master.replace(
      'BANDWIDTH=848000',
      'RESOLUTION=1920x1080',
    ),
    invalidBandwidth: master.replace('BANDWIDTH=848000', 'BANDWIDTH=Infinity'),
    negativeBandwidth: master.replace('BANDWIDTH=848000', 'BANDWIDTH=-1'),
    crossOrigin: master.replace('low.m3u8', 'https://evil.example/low.m3u8'),
    protocolRelative: master.replace('low.m3u8', '//evil.example/low.m3u8'),
    userinfo: master.replace(
      'low.m3u8',
      'https://user:password@camera.example/low.m3u8',
    ),
    file: master.replace('low.m3u8', 'file:///low.m3u8'),
    encrypted: master.replace(
      '#EXTM3U',
      '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"',
    ),
  };
  for (const [name, text] of Object.entries(badMasters)) {
    await t.test(name, async (t) => {
      const { manager, calls } = fixture(t, () => new Response(text));
      const entry = await manager.ensure('camera', base);
      await entry.polling;
      assert.deepEqual(calls, [base]);
      assert.equal(entry.segments.size, 0);
      assert.equal(entry.failures, 1);
    });
  }
});

test('unsupported or escaping child media fails closed rather than trying another rendition', async (t) => {
  const valid = media('high-');
  const badMedia = {
    encrypted: valid.replace(
      '#EXTM3U',
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"',
    ),
    fmp4: valid.replace('#EXTM3U', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"'),
    byteRange: valid.replace('#EXTM3U', '#EXTM3U\n#EXT-X-BYTERANGE:10@0'),
    iframe: valid.replace('#EXTM3U', '#EXTM3U\n#EXT-X-I-FRAMES-ONLY'),
    crossOrigin: valid.replace('high-a.ts', 'https://evil.example/a.ts'),
    credentials: valid.replace(
      'high-a.ts',
      'https://user:password@camera.example/a.ts',
    ),
    notTs: valid.replace('high-a.ts', 'a.m4s'),
    malformed: valid.replace('#EXTINF:2,\n', ''),
    negativeSequence: valid.replace('SEQUENCE:12', 'SEQUENCE:-1'),
    nestedMaster: master,
  };
  for (const [name, text] of Object.entries(badMedia)) {
    await t.test(name, async (t) => {
      const { manager, calls } = fixture(
        t,
        (url) => new Response(url === base ? master : text),
      );
      const entry = await manager.ensure('camera', base);
      await entry.polling;
      assert.deepEqual(calls, [base, 'https://camera.example/live/high.m3u8']);
      assert.equal(entry.segments.size, 0);
      assert.equal(entry.failures, 1);
    });
  }
});

test('fallback preserves the per-request timeout and stops when the last lease is released', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reached = Promise.withResolvers();
  let timedSignal;
  const { manager, calls } = fixture(t, (url, { signal }) => {
    if (url === base) return new Response(master);
    if (url.endsWith('high.m3u8')) {
      timedSignal = signal;
      reached.resolve();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('timed out')), {
          once: true,
        }),
      );
    }
    return new Response(url.endsWith('.m3u8') ? media('low-') : 'low');
  });
  const entry = await manager.ensure('camera', base, 'viewer');
  await reached.promise;
  t.mock.timers.tick(HLS_LIMITS.timeoutMs - 1);
  assert.equal(timedSignal.aborted, false);
  t.mock.timers.tick(1);
  await entry.polling;
  assert.equal(timedSignal.aborted, true);
  assert.equal(entry.segments.size, 2);
  manager.release('camera', 'viewer');
  const before = calls.length;
  t.mock.timers.tick(100000);
  assert.equal(calls.length, before);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
});

test('redirected or URL-substituted child responses are rejected without following their targets', async (t) => {
  for (const mode of ['redirect', 'redirected', 'url']) {
    await t.test(mode, async (t) => {
      const { manager, calls } = fixture(t, (url) => {
        if (url === base) return new Response(master);
        if (url.endsWith('high.m3u8')) {
          if (mode === 'redirect')
            return new Response('', {
              status: 302,
              headers: { location: 'https://evil.example/list.m3u8' },
            });
          const response = new Response(media('high-'));
          Object.defineProperty(response, mode, {
            value: mode === 'url' ? 'https://evil.example/list.m3u8' : true,
          });
          return response;
        }
        return new Response(url.endsWith('.m3u8') ? media('low-') : 'low');
      });
      const entry = await manager.ensure('camera', base);
      await entry.polling;
      assert.equal(entry.segments.size, 2);
      assert.equal(
        calls.some(
          (url) => url.includes('evil.example') || url.includes('high-'),
        ),
        false,
      );
      assert.equal(
        manager.getSegment('camera', entry.token, 0).toString(),
        'low',
      );
    });
  }
});

test('a failed current rendition counts toward the three-attempt cap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let unavailable = false;
  const many =
    '#EXTM3U\n' +
    [800, 700, 600, 500]
      .map((bw) => `#EXT-X-STREAM-INF:BANDWIDTH=${bw}\n${bw}.m3u8\n`)
      .join('');
  const { manager, calls } = fixture(
    t,
    (url) => {
      if (url === base) return new Response(many);
      if (unavailable) return new Response('', { status: 404 });
      return new Response(url.endsWith('.m3u8') ? media('high-') : 'high');
    },
    { pollMs: 2000 },
  );
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  unavailable = true;
  const before = calls.length;
  t.mock.timers.tick(2000);
  await entry.polling;
  assert.deepEqual(
    calls.slice(before).map((url) => new URL(url).pathname),
    ['/live/800.m3u8', '/live/master.m3u8', '/live/700.m3u8', '/live/600.m3u8'],
  );
  assert.equal(entry.failures, 1);
});

test('direct media playlists keep their single-playlist polling and failure behavior', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let unavailable = false;
  const { manager, calls } = fixture(
    t,
    (url) => {
      if (url === base)
        return new Response(media('direct-', unavailable ? 14 : 12));
      return unavailable
        ? new Response('', { status: 404 })
        : new Response('ts');
    },
    { pollMs: 2000 },
  );
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  assert.equal(calls.length, 3);
  t.mock.timers.tick(2000);
  await entry.polling;
  assert.equal(calls.length, 4); // Same direct playlist, no duplicate segments.
  unavailable = true;
  t.mock.timers.tick(2000);
  await entry.polling;
  assert.deepEqual(calls.slice(4), [
    base,
    'https://camera.example/live/direct-a.ts',
  ]);
  assert.equal(entry.failures, 1);
});

test('an empty current media playlist cannot keep a stale session alive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let empty = false;
  const { manager, calls } = fixture(
    t,
    (url) =>
      new Response(
        url === base ? (empty ? '#EXTM3U\n' : media('direct-')) : 'ts',
      ),
    { pollMs: 2000 },
  );
  const entry = await manager.ensure('camera', base);
  await entry.polling;
  empty = true;
  for (let failure = 1; failure <= 3; failure++) {
    t.mock.timers.tick(2000);
    await entry.polling;
    assert.equal(entry.failures, failure);
  }
  assert.equal(calls.length, 6);
  assert.equal(entry.stopping, true);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
});

test('master and child playlist byte caps remain enforced during fallback', async (t) => {
  for (const atMaster of [true, false]) {
    await t.test(atMaster ? 'master' : 'child', async (t) => {
      const { manager, calls } = fixture(t, (url) => {
        if ((url === base) === atMaster)
          return new Response('x', {
            headers: { 'content-length': String(HLS_LIMITS.playlistBytes + 1) },
          });
        return new Response(master);
      });
      const entry = await manager.ensure('camera', base);
      await entry.polling;
      assert.equal(entry.segments.size, 0);
      assert.equal(entry.failures, 1);
      assert.equal(calls.length, atMaster ? 1 : 3);
    });
  }
});

test('oversized advertised segments fall back without increasing declared or streamed byte caps', async (t) => {
  for (const declared of [true, false]) {
    await t.test(declared ? 'content-length' : 'chunked body', async (t) => {
      const { manager, calls } = fixture(
        t,
        (url) => {
          if (url === base) return new Response(master);
          if (url.endsWith('high.m3u8')) return new Response(media('high-'));
          if (url.endsWith('low.m3u8')) return new Response(media('low-'));
          if (url.endsWith('high-b.ts'))
            return new Response('oversized', {
              headers: declared ? { 'content-length': '9' } : {},
            });
          return new Response(url.includes('high-') ? 'high' : 'low');
        },
        { segmentBytes: 4, sessionBytes: 10, segments: 3 },
      );
      const entry = await manager.ensure('camera', base);
      await entry.polling;
      assert.equal(entry.segments.size, 3);
      assert.equal(manager.stats().bytes, 10);
      assert.deepEqual(
        [...entry.segments.values()].map((s) => s.body.toString()),
        ['high', 'low', 'low'],
      );
      assert.deepEqual(
        [...entry.upstream.values()].map((url) => new URL(url).pathname),
        ['/live/low-a.ts', '/live/low-b.ts'],
      );
      assert.match(
        await manager.buildPlaylist(entry, 'camera'),
        /#EXT-X-DISCONTINUITY\n#EXTINF:2\.000,\n\/api\/cctv\/media\/camera\/seg_1\.ts/,
      );
      assert.equal(calls.filter((url) => url.endsWith('high-b.ts')).length, 1);
    });
  }
});
