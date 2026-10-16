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
      res.headers = headers || {};
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

  const call = async (path) => {
    const { res, done } = recordingResponse();
    await handler({ url: path, headers: {}, method: 'GET', on() {} }, res);
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
