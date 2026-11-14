import test from 'node:test';
import assert from 'node:assert/strict';
import * as player from './player.js';
import { cctvProxy } from '../cctv.js';
import { EventEmitter } from 'node:events';

const source = {
  url: 'https://stream3.exdesign.ru/hls/ostrov-9/index.m3u8',
  streamPageUrl: 'https://webcam.exdesign.ru/ostrov-9/',
};
const html = (token) =>
  `<script>playhls('live', '//stream3.exdesign.ru/hls/ostrov-9/index.m3u8?token=${token}');</script>`;

test('resolves only public Ivideon HLS redirects on the operator CDN', async () => {
  const camera = {
    url: 'https://openapi-alpha.ivideon.com/cameras/100-example:0/live_stream?access_token=public&format=hls',
  };
  const target =
    'https://nl205.extcam.com/hls/live?server=100-example&camera=0&access_token=public';
  const resolver = player.createPlayerResolver({
    fetchImpl: async () =>
      new Response(null, { status: 302, headers: { location: target } }),
  });
  assert.equal(await resolver.resolve(camera), target);
  for (const url of [
    'https://127.0.0.1/hls/live',
    'https://nl205.extcam.com.evil.example/hls/live',
    target.replace('100-example', '100-other'),
  ]) {
    const bad = player.createPlayerResolver({
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: url } }),
    });
    await assert.rejects(bad.resolve(camera));
  }
});

test('RTSP public playback refuses deleted, password-protected or domain-restricted cameras', async () => {
  for (const status of ['deleted', 'password', 'domain_forbidden']) {
    const resolver = player.createPlayerResolver({
      fetchImpl: async () => new Response(JSON.stringify({ status })),
    });
    await assert.rejects(
      resolver.resolve({ url: 'https://rtsp.ru/embed/7b49D38G/' }),
      /unavailable/,
    );
  }
});

test('RTSP resolves a public camera to its pinned media-server HLS URL', async () => {
  const resolver = player.createPlayerResolver({
    fetchImpl: async (url) => {
      if (url === 'https://rtsp.ru/api/embed/Example1/token/')
        return new Response(
          JSON.stringify({
            status: 'ok',
            cam: { uniqId: 'Example1', domain: '' },
            url: 'https://ms.rtsp.me',
            token: 'public-session',
          }),
        );
      assert.equal(url, 'https://ms.rtsp.me/token/public-session');
      return new Response(
        JSON.stringify({
          hls: 'https://ms.rtsp.me/public/session/hls/Example1.m3u8',
        }),
      );
    },
  });
  assert.equal(
    await resolver.resolve({ url: 'https://rtsp.ru/embed/Example1/' }),
    'https://ms.rtsp.me/public/session/hls/Example1.m3u8',
  );
});

test('resolves a signed player URL, reuses it and refreshes after the cache window', async () => {
  let now = 0;
  let token = 'first';
  const resolver = player.createPlayerResolver({
    now: () => now,
    fetchImpl: async () => new Response(html(token)),
  });
  assert.equal(await resolver.resolve(source), `${source.url}?token=first`);
  token = 'second';
  assert.equal(await resolver.resolve(source), `${source.url}?token=first`);
  now = 300001;
  assert.equal(await resolver.resolve(source), `${source.url}?token=second`);
  resolver.invalidate(source);
  token = 'third';
  assert.equal(await resolver.resolve(source), `${source.url}?token=third`);
});

test('never accepts a player URL for another camera or host', async () => {
  for (const target of [
    'https://127.0.0.1/private.m3u8',
    'https://stream3.exdesign.ru/hls/other/index.m3u8',
    'https://user:pass@stream3.exdesign.ru/hls/ostrov-9/index.m3u8',
  ]) {
    const resolver = player.createPlayerResolver({
      fetchImpl: async () => new Response(`<source src="${target}">`),
    });
    await assert.rejects(resolver.resolve(source), /matching HLS/);
  }
});

test('refuses redirects, oversized bodies and non-operator pages', async () => {
  for (const response of [
    new Response('', {
      status: 302,
      headers: { location: 'http://127.0.0.1' },
    }),
    new Response('x'.repeat(262145)),
  ]) {
    const resolver = player.createPlayerResolver({
      fetchImpl: async () => response,
    });
    await assert.rejects(resolver.resolve(source));
  }
  const resolver = player.createPlayerResolver();
  await assert.rejects(
    resolver.resolve({ ...source, streamPageUrl: 'http://127.0.0.1/' }),
  );
  assert.equal(await resolver.resolve({ url: source.url }), source.url);
});

test('coalesces simultaneous page requests and backs off after failures', async () => {
  let finish;
  let now = 0;
  const resolver = player.createPlayerResolver({
    now: () => now,
    fetchImpl: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const first = resolver.resolve(source);
  const second = resolver.resolve(source);
  finish(new Response(html('shared')));
  assert.deepEqual(await Promise.all([first, second]), [
    `${source.url}?token=shared`,
    `${source.url}?token=shared`,
  ]);
  const failing = player.createPlayerResolver({
    now: () => now,
    fetchImpl: async () =>
      now === 0
        ? new Response('', { status: 503 })
        : new Response(html('recovered')),
  });
  await assert.rejects(failing.resolve(source));
  now = 1;
  await assert.rejects(failing.resolve(source));
  now = 30001;
  assert.equal(await failing.resolve(source), `${source.url}?token=recovered`);
});

test('configured player cameras serve playable HLS through the existing proxy', async (t) => {
  for (const [name, value] of Object.entries({
    CCTV_SOURCES_JSON: JSON.stringify([
      {
        ...source,
        id: 'player',
        name: 'Player',
        lat: 55.75,
        lon: 37.62,
        feedType: 'hls',
      },
    ]),
    CCTV_SOURCES_FILE: 'missing.json',
    CCTV_FORCE_AUSTIN: '0',
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() =>
      previous === undefined
        ? delete process.env[name]
        : (process.env[name] = previous),
    );
  }
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === source.streamPageUrl) return new Response(html('fresh'));
    if (url === `${source.url}?token=fresh`)
      return new Response(
        '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n',
      );
    if (/\/hls\/ostrov-9\/[ab]\.ts$/.test(url))
      return new Response('video bytes');
    throw new Error('Unexpected upstream URL');
  });
  let handler;
  const httpServer = new EventEmitter();
  cctvProxy().configureServer({
    httpServer,
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  t.after(() => httpServer.emit('close'));
  const call = async (url) => {
    const res = new EventEmitter();
    res.writeHead = (status, headers) => {
      res.statusCode = status;
      res.headers = headers;
    };
    res.end = (body) => {
      res.body = body;
      res.writableEnded = true;
    };
    await handler({ url, method: 'GET', headers: {} }, res);
    return res;
  };
  const result = await call(
    '/media/player?lease=12345678-1234-1234-1234-123456789abc',
  );
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /#EXTM3U/);
  const segmentPath = result.body
    .split('\n')
    .find((line) => line.startsWith('/api/'));
  const segment = await call(segmentPath.replace('/api/cctv', ''));
  assert.equal(segment.statusCode, 200);
  assert.equal(segment.body.toString(), 'video bytes');
});
