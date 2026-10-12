import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeGeorgiaCatalog,
  createGeorgiaSession,
  validateGeorgiaMediaUrl,
} from '../../server/providers/cctv/georgia511.js';
import {
  createHlsPuller,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { cctvProxy } from '../../server/providers/cctv.js';

const manifest = JSON.parse(
  await fs.readFile(
    new URL(
      '../../config/cctv_sources.georgia511.example.json',
      import.meta.url,
    ),
  ),
);
const sources = normalizeGeorgiaCatalog(manifest);
const camera = sources.find((s) => s.id === 'georgia511-42');
const master = `https://${camera.georgiaHost}/rtplive/${camera.georgiaStreamName}/playlist.m3u8`;
const list =
  '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n';

test('synthetic catalog preserves registered identities and refuses invalid metadata', () => {
  assert.equal(sources.length, 1);
  const counts = {};
  for (const s of sources) counts[s.county] = (counts[s.county] || 0) + 1;
  assert.deepEqual(counts, { Cobb: 1 });
  assert.equal(camera.georgiaViewId, 43);
  assert.equal(camera.viewerUrl, 'https://511ga.org/map#camera-42');
  assert.ok(!JSON.stringify(sources).includes('token='));
  const row = manifest.cameras[0];
  for (const change of [
    { county: 'Unknown' },
    { viewerUrl: 'http://127.0.0.1' },
    { wkt: 'POINT (0 0)' },
    { name: '../escape' },
    { views: [{ ...row.views[0], videoHost: '127.0.0.1' }] },
  ]) {
    assert.deepEqual(
      normalizeGeorgiaCatalog({ cameras: [{ ...row, ...change }] }),
      [],
    );
  }
});

test('every media reference is pinned to the registered host and stream path', () => {
  assert.equal(
    validateGeorgiaMediaUrl(master + '?opaque=value', camera, { master: true }),
    master + '?opaque=value',
  );
  for (const bad of [
    master.replace('https:', 'http:'),
    master.replace(camera.georgiaHost, '127.0.0.1'),
    master.replace(camera.georgiaHost, camera.georgiaHost + '.evil.example'),
    master.replace('/rtplive/', '/other/'),
    master.replace(camera.georgiaStreamName, 'OTHER'),
    master.replace('/playlist.m3u8', '/../playlist.m3u8'),
    master.replace('https://', 'https://user:pass@'),
    master.replace('/playlist', ':444/playlist'),
    master + '#fragment',
  ])
    assert.throws(() => validateGeorgiaMediaUrl(bad, camera));
  assert.throws(() => createGeorgiaSession({ ...camera, pack: 'file' }));
});

test('anonymous issuer is coalesced, cached for 60 seconds, bounded and cancellable', async () => {
  let clock = 0,
    calls = 0;
  const controller = new AbortController();
  const session = createGeorgiaSession(camera, {
    now: () => clock,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://511ga.org/Camera/GetVideoUrl?imageId=43');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(Object.keys(init.headers), ['User-Agent']);
      return new Response(JSON.stringify(master + '?opaque=' + calls));
    },
  });
  const [a, b] = await Promise.all([
    session.resolveUrl({ signal: controller.signal }),
    session.resolveUrl({ signal: controller.signal }),
  ]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  clock = 59999;
  await session.resolveUrl({ signal: controller.signal });
  assert.equal(calls, 1);
  clock = 60000;
  assert.notEqual(await session.resolveUrl({ signal: controller.signal }), a);
  assert.equal(calls, 2);
  session.dispose();
  await assert.rejects(session.resolveUrl({ signal: controller.signal }));
});

test('issuer refusals, alternate objects, redirects and oversized bodies fail without URL disclosure', async () => {
  for (const response of [
    new Response('private', { status: 403 }),
    new Response(JSON.stringify({ url: master })),
    new Response(JSON.stringify('http://127.0.0.1/private?secret=value')),
    new Response('', { status: 302 }),
    new Response('x'.repeat(17000)),
  ]) {
    const session = createGeorgiaSession(camera, {
      fetchImpl: async () => response,
    });
    await assert.rejects(
      session.resolveUrl({ signal: new AbortController().signal }),
      (error) =>
        !error.message.includes('private') &&
        !error.message.includes('secret') &&
        error.fatal,
    );
  }
});

test('429 cooldown honors Retry-After across recreated sessions', async () => {
  let calls = 0;
  const source = { ...camera, georgiaViewId: 999999 };
  const options = {
    now: () => 1000,
    fetchImpl: async () => {
      calls++;
      return new Response('', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });
    },
  };
  for (let n = 0; n < 2; n++)
    await assert.rejects(
      createGeorgiaSession(source, options).resolveUrl({
        signal: new AbortController().signal,
      }),
      (error) => error.status === 429 && error.retryAfterSeconds === 120,
    );
  assert.equal(calls, 1);
});

test('media throttling also blocks fresh issuance until Retry-After', async () => {
  const source = { ...camera, georgiaViewId: 999998 };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    return url.includes('GetVideoUrl')
      ? new Response(JSON.stringify(master))
      : new Response('', { status: 429, headers: { 'Retry-After': '90' } });
  };
  const options = { fetchImpl, now: () => 1000 };
  const puller = createHlsPuller({ fetchImpl });
  const entry = await puller.ensure(
    source.id,
    source.url,
    'lease',
    createGeorgiaSession(source, options),
  );
  await entry.polling;
  assert.equal(entry.stopping, true);
  assert.equal(entry.safeError.status, 429);
  await assert.rejects(
    createGeorgiaSession(source, options).resolveUrl({
      signal: new AbortController().signal,
    }),
    (error) => error.status === 429 && error.retryAfterSeconds === 90,
  );
  assert.equal(calls, 2);
  await puller.shutdown();
});

test('refresh preserves local session and forward sequence; release clears URLs and late issuance', async () => {
  let clock = 0,
    issues = 0;
  const fetchImpl = async (url) =>
    new Response(
      url.includes('GetVideoUrl')
        ? JSON.stringify(master + '?opaque=' + ++issues)
        : url.includes('.m3u8')
          ? list
          : 'abc',
    );
  const session = createGeorgiaSession(camera, { fetchImpl, now: () => clock });
  const puller = createHlsPuller({
    fetchImpl,
    limits: { ...HLS_LIMITS, pollMs: 5 },
  });
  const entry = await puller.ensure(camera.id, camera.url, 'lease', session);
  await puller.waitReady(entry);
  const token = entry.token;
  clock = 60000;
  await new Promise((r) => setTimeout(r, 40));
  const output = await puller.buildPlaylist(entry, camera.id, 'lease');
  assert.equal(issues, 2);
  assert.equal(entry.token, token);
  assert.match(output, /#EXT-X-DISCONTINUITY\n#EXTINF:2.000,\n.*seg_2.ts/);
  assert.ok(!output.includes('opaque') && !output.includes(camera.georgiaHost));
  puller.release(camera.id, 'lease');
  assert.equal(entry.url, null);
  assert.equal(entry.segments.size, 0);
  assert.equal(entry.controller.signal.aborted, true);
  await puller.shutdown();
  let resolve;
  const pending = createGeorgiaSession(camera, {
    fetchImpl: async () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const other = createHlsPuller({ limits: { ...HLS_LIMITS, sessions: 1 } });
  const waiting = await other.ensure(camera.id, camera.url, 'lease', pending);
  await assert.rejects(other.ensure('second', camera.url, 'lease', pending));
  other.release(camera.id, 'lease');
  resolve(new Response(JSON.stringify(master)));
  await waiting.polling;
  assert.equal(waiting.url, null);
  assert.deepEqual(other.stats(), { sessions: 0, bytes: 0 });
  await other.shutdown();
});

test('catalog preserves configured baseline; sources, stream and frame never issue video or paid fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-georgia-test-'));
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(path.join(root, 'config'));
    await fs.writeFile(
      path.join(root, 'config/cctv_sources.austin.json'),
      JSON.stringify([
        {
          id: 'baseline',
          name: 'Existing',
          lat: 30,
          lon: -97,
          url: 'https://example.com/frame.jpg',
        },
      ]),
    );
    await fs.writeFile(
      path.join(root, 'config/cctv_sources.georgia511.json'),
      JSON.stringify(manifest),
    );
    const catalog = await createCctvCatalog({ sourceRoot: root })();
    assert.equal(catalog.length, 2);
    assert.equal(catalog[0].id, 'baseline');
    globalThis.fetch = async () => {
      throw new Error('NO upstream requests are permitted for these routes');
    };
    let handler;
    cctvProxy({ sourceRoot: root }).configureServer({
      middlewares: {
        use(_path, fn) {
          handler = fn;
        },
      },
    });
    for (const route of [
      '/sources',
      '/stream/' + camera.id,
      '/frame/' + camera.id,
    ]) {
      let status, body;
      await handler(
        { url: route },
        {
          writeHead(s) {
            status = s;
          },
          end(text) {
            body = text;
          },
        },
      );
      assert.equal(status, route.startsWith('/frame') ? 503 : 200);
      assert.ok(!body.includes('opaque') && !body.includes(camera.georgiaHost));
      if (route === '/sources')
        assert.equal(
          JSON.parse(body).sources.filter((s) => s.pack === 'georgia511')
            .length,
          1,
        );
    }
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});
