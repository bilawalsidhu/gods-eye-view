// A temporary snapshot failure (HTTP 5xx, timeout, network error) is not
// evidence that a camera has no public picture. Mounted-route regression for
// the #1314 review (radianx): two 503s used to mark the camera location-only
// for 24 h, the client then stopped requesting frames, and nothing probed it.
//
// Run with: npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { cctvProxy } from '../../server/providers/cctv.js';
import {
  NO_FEED_CAMERA_TTL_MS,
  NO_FEED_TRANSIENT_TTL_MS,
} from '../../server/providers/cctv/feedAvailability.js';

const CAM = {
  id: 'alias-cam',
  name: 'Alias camera',
  lat: -35.1,
  lon: -60.2,
  feedType: 'image',
  snapshotUrl: 'https://cams.upstream.invalid/snapshot.jpg',
  url: 'https://cams.upstream.invalid/snapshot.jpg',
};
const T0 = 1800000000000;

function fixture(t, fetchImpl) {
  const saved = { ...process.env };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-1314-transient-'));
  const server = new EventEmitter();
  process.env.CCTV_SOURCES_JSON = JSON.stringify([CAM]);
  process.env.CCTV_SOURCES_FILE = 'absent.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
  t.mock.method(globalThis, 'fetch', fetchImpl);
  let handler;
  const start = () =>
    cctvProxy({ sourceRoot: root }).configureServer({
      httpServer: server,
      middlewares: {
        use(_prefix, fn) {
          handler = fn;
        },
      },
    });
  start();
  t.after(() => {
    server.emit('close');
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const get = async (url) => {
    const res = new EventEmitter();
    res.writeHead = (status, headers = {}) => {
      res.status = status;
      res.headers = headers;
    };
    res.setHeader = () => {};
    res.end = (body) => {
      res.body = body;
      res.writableEnded = true;
      res.emit('finish');
    };
    await handler({ url, method: 'GET', headers: {} }, res);
    return res;
  };
  const feedType = async () =>
    JSON.parse((await get('/sources')).body).sources[0].feedType;
  const frame = () => get(`/frame/${CAM.id}`);
  return { get, feedType, frame };
}

const jpeg = () =>
  new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg' } });

test('503 twice: catalog goes to a short retry window, then recovers on its own', async (t) => {
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  let healthy = false;
  let calls = 0;
  const { feedType, frame } = fixture(t, async () => {
    calls += 1;
    return healthy ? jpeg() : new Response(null, { status: 503 });
  });
  assert.equal(await feedType(), 'image');
  await frame();
  assert.equal(await feedType(), 'image');
  await frame();
  assert.equal(await feedType(), 'none', 'retry window while the 503 is fresh');
  healthy = true;
  now = T0 + NO_FEED_TRANSIENT_TTL_MS - 1;
  assert.equal(await feedType(), 'none');
  now = T0 + NO_FEED_TRANSIENT_TTL_MS;
  assert.equal(await feedType(), 'image', 'advertised again long before 24 h');
  assert.ok(NO_FEED_TRANSIENT_TTL_MS < NO_FEED_CAMERA_TTL_MS);
  const res = await frame();
  assert.equal(res.status, 200);
  assert.equal(await feedType(), 'image');
  assert.equal(calls, 3);
});

test('still failing after the window: ONE retry re-opens the window (bounded probe)', async (t) => {
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const { feedType, frame } = fixture(t, async () => {
    calls += 1;
    return new Response(null, { status: 503 });
  });
  await frame();
  await frame();
  assert.equal(await feedType(), 'none');
  now += NO_FEED_TRANSIENT_TTL_MS;
  assert.equal(await feedType(), 'image');
  await frame();
  assert.equal(calls, 3, 'one request per window');
  assert.equal(await feedType(), 'none');
});

test('timeout / network error is also temporary', async (t) => {
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const { feedType, frame } = fixture(t, async () => {
    throw new TypeError('fetch failed');
  });
  await frame();
  await frame();
  assert.equal(await feedType(), 'none');
  now += NO_FEED_TRANSIENT_TTL_MS;
  assert.equal(await feedType(), 'image');
});

test('control: two 404s are a real missing feed, stay location-only for 24 h', async (t) => {
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const { feedType, frame } = fixture(
    t,
    async () => new Response(null, { status: 404 }),
  );
  await frame();
  await frame();
  assert.equal(await feedType(), 'none');
  now = T0 + NO_FEED_TRANSIENT_TTL_MS + 1;
  assert.equal(await feedType(), 'none');
  now = T0 + NO_FEED_CAMERA_TTL_MS - 1;
  assert.equal(await feedType(), 'none');
  now = T0 + NO_FEED_CAMERA_TTL_MS;
  assert.equal(await feedType(), 'image');
});

test('control: a 200 with a non-image body is a real missing feed', async (t) => {
  t.mock.method(Date, 'now', () => T0);
  const { feedType, frame } = fixture(
    t,
    async () =>
      new Response('<html></html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
  );
  await frame();
  await frame();
  assert.equal(await feedType(), 'none');
  t.mock.method(Date, 'now', () => T0 + NO_FEED_TRANSIENT_TTL_MS + 1);
  assert.equal(await feedType(), 'none');
});

test('control: a success between two 503s resets the count', async (t) => {
  t.mock.method(Date, 'now', () => T0);
  const answers = [503, 200, 503];
  const { feedType, frame } = fixture(t, async () => {
    const s = answers.shift();
    return s === 200 ? jpeg() : new Response(null, { status: s });
  });
  await frame();
  await frame();
  await frame();
  assert.equal(await feedType(), 'image');
});

test('control: a 404 after 503s makes the definitive 24 h mark', async (t) => {
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const answers = [503, 404];
  const { feedType, frame } = fixture(
    t,
    async () => new Response(null, { status: answers.shift() }),
  );
  await frame();
  await frame();
  now += NO_FEED_TRANSIENT_TTL_MS + 1;
  assert.equal(await feedType(), 'none');
});

test('a successful frame inside the retry window clears it at once', async (t) => {
  let healthy = false;
  t.mock.method(Date, 'now', () => T0);
  const { feedType, frame } = fixture(t, async () =>
    healthy ? jpeg() : new Response(null, { status: 503 }),
  );
  await frame();
  await frame();
  assert.equal(await feedType(), 'none');
  healthy = true;
  assert.equal((await frame()).status, 200);
  assert.equal(await feedType(), 'image');
});
