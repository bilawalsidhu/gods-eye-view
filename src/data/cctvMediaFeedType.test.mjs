// /api/cctv/media is the live-feed relay. A still camera used to be relayed
// through it as well, by an ordinary redirect-following fetch with no content
// type check and no body cap, which side-stepped everything /api/cctv/frame
// enforces for the same URL. These pin that a still is refused there and only
// reachable through /frame, while live feeds keep their relay.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { cctvProxy } from '../../server/providers/cctv.js';

const STILL = {
  id: 'still-fixture',
  name: 'Still fixture',
  lat: 30.27,
  lon: -97.74,
  feedType: 'image',
  url: 'https://cams.upstream.invalid/still.jpg',
};
// 'jpg' normalizes to 'image'; the alias must not reopen the relay.
const STILL_ALIAS = {
  ...STILL,
  id: 'still-alias',
  feedType: 'jpg',
  url: 'https://cams.upstream.invalid/alias.jpg',
};
const VIDEO = {
  id: 'video-fixture',
  name: 'Video fixture',
  lat: 30.27,
  lon: -97.74,
  feedType: 'video',
  url: 'https://cams.upstream.invalid/live.mp4',
};
const WEBM = {
  id: 'webm-fixture',
  name: 'WebM fixture',
  lat: 30.27,
  lon: -97.74,
  feedType: 'webm',
  url: 'https://cams.upstream.invalid/live.webm',
};
const MJPEG = {
  id: 'mjpeg-fixture',
  name: 'MJPEG fixture',
  lat: 30.27,
  lon: -97.74,
  feedType: 'mjpeg',
  url: 'https://cams.upstream.invalid/live.mjpg',
};

/** A minimal upstream Response with a streaming body. */
function upstreamResponse({ status = 200, headers = {}, body = 'payload' }) {
  const store = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => store.get(String(name).toLowerCase()) ?? null },
    body: Readable.toWeb(Readable.from([Buffer.from(String(body))])),
  };
}

/** Collects what a handler wrote, the way a Node ServerResponse would. */
function recordingResponse() {
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = { ...res.headers, ...headers };
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      res.body = Buffer.concat(chunks).toString('utf8');
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

/**
 * Mount the real provider over the fixture cameras and answer every upstream
 * request from the supplied function.
 */
function mount(t, respond) {
  const before = {
    json: process.env.CCTV_SOURCES_JSON,
    file: process.env.CCTV_SOURCES_FILE,
    austin: process.env.CCTV_FORCE_AUSTIN,
    serverKey: process.env.GOOGLE_MAPS_SERVER_API_KEY,
    browserKey: process.env.GOOGLE_MAPS_API_KEY,
  };
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    STILL,
    STILL_ALIAS,
    VIDEO,
    WEBM,
    MJPEG,
  ]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  // No Street View key: a /frame miss lands on the synthetic billboard rather
  // than a network call this file does not model.
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  const nativeFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), redirect: init.redirect });
    return respond({ url: String(url), init });
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const [name, value] of [
      ['CCTV_SOURCES_JSON', before.json],
      ['CCTV_SOURCES_FILE', before.file],
      ['CCTV_FORCE_AUSTIN', before.austin],
      ['GOOGLE_MAPS_SERVER_API_KEY', before.serverKey],
      ['GOOGLE_MAPS_API_KEY', before.browserKey],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  let handler = null;
  cctvProxy().configureServer({
    middlewares: {
      use: (_route, fn) => {
        handler = fn;
      },
    },
  });
  assert.ok(handler, 'the CCTV provider must mount a middleware');

  const call = async (path, headers = {}) => {
    const { res, done } = recordingResponse();
    await handler({ url: path, headers, method: 'GET', on() {} }, res);
    await done;
    return res;
  };
  const health = async (id) => {
    const res = await call('/health');
    return JSON.parse(res.body).cameras.find((entry) => entry.id === id);
  };
  return { call, health, requests };
}

test('a still camera is refused by /media without any upstream request', async (t) => {
  // Everything the old relay would have done with this camera: redirect to a
  // private address, then answer with HTML.
  const app = mount(t, ({ url }) =>
    url.includes('169.254.169.254')
      ? upstreamResponse({
          headers: { 'content-type': 'text/html' },
          body: '<html>metadata</html>',
        })
      : upstreamResponse({
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: '',
        }),
  );
  for (const camera of [STILL, STILL_ALIAS]) {
    const res = await app.call(`/media/${camera.id}`);
    assert.equal(res.statusCode, 404, camera.id);
    assert.equal(res.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(res.body), {
      error: 'No live media for this camera; use the frame endpoint',
    });
    assert.doesNotMatch(res.body, /metadata/);
    // Being asked on the wrong route is not a camera fault.
    assert.equal(await app.health(camera.id), undefined);
  }
  assert.deepEqual(app.requests, [], 'a still camera reached its upstream');
});

test('an unregistered camera id is refused by /media the same way', async (t) => {
  const app = mount(t, () => {
    throw new Error('an unknown camera must not fetch');
  });
  const res = await app.call('/media/not-a-camera');
  assert.equal(res.statusCode, 404);
  assert.equal(app.requests.length, 0);
});

test('a video camera is still relayed by /media', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      headers: { 'content-type': 'video/mp4', 'content-length': '5' },
      body: 'video',
    }),
  );
  const res = await app.call(`/media/${VIDEO.id}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'video/mp4');
  assert.equal(res.headers['X-CCTV-Source'], 'live-media');
  assert.equal(res.body, 'video');
  assert.deepEqual(
    app.requests.map(({ url }) => url),
    [VIDEO.url],
  );
  assert.equal((await app.health(VIDEO.id)).status, 'ok');
});

test('an MJPEG camera is still relayed by /media', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      headers: { 'content-type': 'multipart/x-mixed-replace; boundary=frame' },
      body: '--frame',
    }),
  );
  const res = await app.call(`/media/${MJPEG.id}`);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /^multipart\/x-mixed-replace/);
  assert.equal(res.body, '--frame');
  assert.deepEqual(
    app.requests.map(({ url }) => url),
    [MJPEG.url],
  );
});

test('a still camera is still served through /frame with its bounded fetch', async (t) => {
  const app = mount(t, () =>
    upstreamResponse({
      headers: { 'content-type': 'image/jpeg' },
      body: 'jpeg-bytes',
    }),
  );
  const res = await app.call(`/frame/${STILL.id}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/jpeg');
  assert.equal(res.headers['X-CCTV-Source'], 'upstream-image');
  assert.equal(res.body, 'jpeg-bytes');
  assert.deepEqual(app.requests, [{ url: STILL.url, redirect: 'manual' }]);
});

test('/frame does not follow a still camera off its origin', async (t) => {
  // The protection /media used to bypass, shown on the route that keeps it.
  const app = mount(t, ({ url }) =>
    url === STILL.url
      ? upstreamResponse({
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: '',
        })
      : upstreamResponse({
          headers: { 'content-type': 'image/jpeg' },
          body: 'private',
        }),
  );
  const res = await app.call(`/frame/${STILL.id}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-CCTV-Source'], 'synthetic');
  assert.doesNotMatch(res.body, /private/);
  assert.deepEqual(
    app.requests.map(({ url }) => url),
    [STILL.url],
  );
});

/** An upstream Response whose body records whether it was cancelled. */
function trackedUpstream({ status = 200, headers = {}, body = 'payload' }) {
  const state = { cancelled: false };
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { status, headers },
  );
  return { response, state };
}

test('/media refuses an upstream type that does not match the feed kind', async (t) => {
  let current;
  const app = mount(t, () => current.response);
  for (const [camera, contentType, body] of [
    [VIDEO, 'text/html', '<!doctype html><p>x</p>'],
    [VIDEO, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    [VIDEO, 'application/vnd.apple.mpegurl', '#EXTM3U'],
    [VIDEO, 'video/webm', 'video'],
    [VIDEO, undefined, 'video'],
    [WEBM, 'video/mp4', 'video'],
    [MJPEG, 'multipart/x-mixed-replace', '--frame'],
    [MJPEG, 'multipart/x-mixed-replace; boundary=', '--frame'],
    [MJPEG, 'image/jpeg', 'jpeg'],
    [MJPEG, 'text/html; boundary=frame', '<!doctype html><p>x</p>'],
  ]) {
    current = trackedUpstream({
      headers: contentType === undefined ? {} : { 'content-type': contentType },
      body,
    });
    const label = `${camera.id}: ${contentType}`;
    const res = await app.call(`/media/${camera.id}`);
    assert.equal(res.statusCode, 502, label);
    assert.equal(res.headers['Content-Type'], 'application/json', label);
    assert.deepEqual(JSON.parse(res.body), { error: 'Media proxy failed' });
    assert.equal(current.state.cancelled, true, `${label}: upstream cancelled`);
    const health = await app.health(camera.id);
    assert.equal(health.status, 'degraded', label);
    assert.equal(health.message, 'Unexpected media type', label);
  }
});

test('/media relays each feed kind under its canonical type, including a partial response', async (t) => {
  let current;
  const app = mount(t, () => current);
  for (const [camera, upstream, expected] of [
    [VIDEO, { 'content-type': 'Video/MP4; codecs="avc1.42E01E"' }, 'video/mp4'],
    [
      VIDEO,
      {
        'content-type': 'video/mp4',
        'content-range': 'bytes 0-4/100',
        'content-length': '5',
        'accept-ranges': 'bytes',
      },
      'video/mp4',
    ],
    [WEBM, { 'content-type': 'video/webm' }, 'video/webm'],
    [
      MJPEG,
      { 'content-type': 'multipart/x-mixed-replace;boundary="frame"' },
      'multipart/x-mixed-replace; boundary=frame',
    ],
    [
      MJPEG,
      { 'content-type': 'multipart/x-mixed-replace; boundary="a b"' },
      'multipart/x-mixed-replace; boundary="a b"',
    ],
  ]) {
    const status = upstream['content-range'] ? 206 : 200;
    current = upstreamResponse({ status, headers: upstream, body: 'bytes' });
    const res = await app.call(`/media/${camera.id}`);
    assert.equal(res.statusCode, status, camera.id);
    assert.equal(res.headers['Content-Type'], expected);
    assert.equal(res.body, 'bytes');
    if (status === 206)
      assert.equal(res.headers['Content-Range'], 'bytes 0-4/100');
    assert.equal((await app.health(camera.id)).status, 'ok');
  }
});

test('/media does not follow a live camera off its origin', async (t) => {
  const app = mount(t, ({ url }) =>
    url === VIDEO.url
      ? upstreamResponse({
          status: 302,
          headers: { location: 'https://elsewhere.invalid/live.mp4' },
          body: '',
        })
      : upstreamResponse({
          headers: { 'content-type': 'video/mp4' },
          body: 'elsewhere',
        }),
  );
  const res = await app.call(`/media/${VIDEO.id}`);
  assert.equal(res.statusCode, 502);
  assert.doesNotMatch(res.body, /elsewhere/);
  assert.deepEqual(app.requests, [{ url: VIDEO.url, redirect: 'manual' }]);
});

test('every CCTV route refuses cross-site requests and admits the app itself', async (t) => {
  const app = mount(t, ({ url }) =>
    upstreamResponse({
      headers: {
        'content-type': url === VIDEO.url ? 'video/mp4' : 'image/jpeg',
      },
      body: 'bytes',
    }),
  );
  const host = 'localhost:5173';
  const paths = [
    '/sources',
    '/health',
    `/stream/${STILL.id}`,
    `/frame/${STILL.id}`,
    `/media/${VIDEO.id}`,
  ];
  for (const headers of [
    { host, 'sec-fetch-site': 'cross-site' },
    { host, 'sec-fetch-site': 'same-site' },
    { host, origin: 'https://elsewhere.example' },
    { host, origin: 'null' },
  ])
    for (const path of paths) {
      const res = await app.call(path, headers);
      assert.equal(res.statusCode, 403, `${path} ${JSON.stringify(headers)}`);
    }
  assert.deepEqual(app.requests, [], 'a refused request reached an upstream');
  for (const headers of [
    { host, 'sec-fetch-site': 'same-origin' },
    { host, origin: `http://${host}` },
    {},
  ]) {
    const frame = await app.call(`/frame/${STILL.id}`, headers);
    assert.equal(frame.statusCode, 200);
    assert.equal(frame.headers['X-CCTV-Source'], 'upstream-image');
    const media = await app.call(`/media/${VIDEO.id}`, headers);
    assert.equal(media.statusCode, 200);
    assert.equal(media.headers['Content-Type'], 'video/mp4');
  }
});

test('/frame falls back past a non-raster upstream and Street View frame', async (t) => {
  let streetViewType;
  const app = mount(t, ({ url }) =>
    url.startsWith('https://maps.googleapis.com/')
      ? trackedUpstream({
          headers:
            streetViewType === undefined
              ? {}
              : { 'content-type': streetViewType },
          body: 'street-view',
        }).response
      : upstreamResponse({
          headers: { 'content-type': 'image/svg+xml' },
          body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        }),
  );
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'fixture-key';
  for (const type of [
    'image/svg+xml',
    'text/html',
    'application/xml',
    undefined,
  ]) {
    streetViewType = type;
    const res = await app.call(`/frame/${STILL.id}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['X-CCTV-Source'], 'synthetic', String(type));
    assert.doesNotMatch(res.body, /street-view/);
  }
  streetViewType = 'image/JPEG; charset=x';
  const res = await app.call(`/frame/${STILL.id}`);
  assert.equal(res.headers['X-CCTV-Source'], 'streetview');
  assert.equal(res.headers['Content-Type'], 'image/jpeg');
  assert.equal(res.body, 'street-view');
});

test('a forwarded same-origin request reaches every CCTV route but not the Street View fallback', async (t) => {
  const app = mount(t, ({ url }) => {
    if (url.startsWith('https://maps.googleapis.com/'))
      return trackedUpstream({
        headers: { 'content-type': 'image/jpeg' },
        body: 'street-view',
      }).response;
    return url === VIDEO.url
      ? upstreamResponse({ headers: { 'content-type': 'video/mp4' } })
      : upstreamResponse({ status: 503, body: '' });
  });
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'fixture-key';
  const host = 'localhost:5173';
  const streetViewCalls = () =>
    app.requests.filter(({ url }) =>
      url.startsWith('https://maps.googleapis.com/'),
    ).length;
  for (const forwarded of [
    { 'x-forwarded-for': '203.0.113.9' },
    { via: '1.1 proxy' },
    { forwarded: 'for=203.0.113.9' },
    { 'x-real-ip': '203.0.113.9' },
    { 'x-forwarded-for': '' },
    { 'x-forwarded-for': '  ' },
    { 'cf-connecting-ip': '' },
  ]) {
    const headers = { host, 'sec-fetch-site': 'same-origin', ...forwarded };
    const label = JSON.stringify(forwarded);
    assert.equal((await app.call('/sources', headers)).statusCode, 200, label);
    const media = await app.call(`/media/${VIDEO.id}`, headers);
    assert.equal(media.statusCode, 200, label);
    assert.equal(media.headers['Content-Type'], 'video/mp4', label);
    const frame = await app.call(`/frame/${STILL.id}`, headers);
    assert.equal(frame.statusCode, 200, label);
    assert.equal(frame.headers['X-CCTV-Source'], 'synthetic', label);
    assert.equal(frame.headers['Content-Type'], 'image/svg+xml', label);
    // Cross-site stays refused whatever the forwarding headers say.
    for (const path of ['/sources', `/frame/${STILL.id}`, `/media/${VIDEO.id}`])
      assert.equal(
        (
          await app.call(path, {
            ...forwarded,
            host,
            'sec-fetch-site': 'cross-site',
          })
        ).statusCode,
        403,
        `${label} ${path}`,
      );
  }
  assert.equal(streetViewCalls(), 0, 'a forwarded request spent the key');
  const direct = await app.call(`/frame/${STILL.id}`, {
    host,
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(direct.headers['X-CCTV-Source'], 'streetview');
  assert.equal(direct.body, 'street-view');
  assert.equal(streetViewCalls(), 1);
});
