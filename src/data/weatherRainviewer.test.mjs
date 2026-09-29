import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  weatherProxy,
  parseRainViewerManifest,
} from '../../server/providers/weather.js';
import { createRainViewerGovernor } from '../../server/providers/rainViewerGovernor.js';

const seconds = 1790215200;
const TIME = new Date(seconds * 1000).toISOString();
const frame = (time = seconds, path = '/v2/radar/47d5f2b2ef80') => ({
  time,
  path,
});
const manifest = (past = [frame()]) => ({
  version: '2.0',
  host: 'http://127.0.0.1/evil',
  radar: { past, nowcast: [frame(seconds + 600)] },
});
function png(width = 256) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(256, 20);
  return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
}
function install(options = {}) {
  let handler;
  weatherProxy({ now: () => seconds * 1000, ...options }).configureServer({
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  return async (url) => {
    const res = new EventEmitter();
    res.writeHead = (status, headers) =>
      Object.assign(res, { status, headers });
    res.end = (body) => {
      res.body = body;
    };
    await handler({ url, method: 'GET' }, res);
    return res;
  };
}
const tile = (extra = {}) =>
  '/tile?' +
  new URLSearchParams({
    product: 'radar-global',
    time: TIME,
    z: 7,
    x: 0,
    y: 0,
    ...extra,
  });
const body = (res) => JSON.parse(res.body);

test('RainViewer parses sorted observed frames only, drops malformed frames and bounds the fresh map', () => {
  const past = Array.from({ length: 20 }, (_, i) =>
    frame(seconds - i * 600, `/v2/radar/frame${i}`),
  );
  past.push(
    null,
    {},
    frame(0),
    frame(-1),
    frame('1790215200'),
    frame(1.5),
    frame(1e30),
    frame(seconds, '/v2/radar/../escape'),
    frame(seconds, 'https://evil.test'),
    frame(seconds, '/v2/radar/' + 'a'.repeat(65)),
    frame(seconds, '/v2/radar/abc?x=1'),
  );
  const parsed = parseRainViewerManifest(JSON.stringify(manifest(past)));
  assert.equal(parsed.times.length, 13);
  assert.deepEqual(parsed.times, [...parsed.times].sort());
  assert.equal(parsed.times.at(-1), TIME);
  assert.equal(Object.keys(parsed.framePaths).length, 13);
  assert.equal(parsed.framePaths[TIME], '/v2/radar/frame0');
  assert.throws(() => parseRainViewerManifest(JSON.stringify(manifest([]))));
  assert.throws(() => parseRainViewerManifest('{}'));
});

test('RainViewer pins both URLs, uses PNG validation, caches tiles and refreshes a replaced frame map', async () => {
  let clock = seconds * 1000;
  let past = [frame()];
  const calls = [];
  const request = install({
    now: () => clock,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.includes('weather-maps.json')
        ? Response.json(manifest(past))
        : png();
    },
  });
  const first = body(await request('/manifest?product=radar-global'));
  assert.equal(first.title, 'Global radar reflectivity');
  assert.equal(first.tilingScheme, 'web-mercator');
  assert.equal(first.maxLevel, 7);
  assert.equal(first.attribution, 'RainViewer');
  assert.equal(first.imageUrl, null);
  assert.equal(
    calls[0].url,
    'https://api.rainviewer.com/public/weather-maps.json',
  );
  const response = await request(tile());
  assert.equal(response.status, 200);
  assert.equal(
    response.headers['Cache-Control'],
    'public, max-age=86400, immutable',
  );
  assert.equal(
    calls[1].url,
    'https://tilecache.rainviewer.com/v2/radar/47d5f2b2ef80/256/7/0/0/2/1_1.png',
  );
  assert.equal(calls[1].options.redirect, 'error');
  assert.deepEqual((await request(tile())).body, response.body);
  assert.equal(calls.length, 2);
  clock += 299_999;
  await request('/manifest?product=radar-global');
  assert.equal(calls.length, 2);
  clock++;
  past = [frame(seconds + 600, '/v2/radar/new')];
  await request('/manifest?product=radar-global');
  const old = await request(tile());
  assert.equal(old.status, 400);
  assert.equal(body(old).error, 'unknown_weather_time');
  assert.equal(
    calls.length,
    3,
    'expired map entries cannot serve even a cached tile',
  );
});

test('RainViewer rejects invalid coordinates, sizes, destinations and whole images before upstream', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      throw new Error();
    },
  });
  for (const coords of [
    { z: 8 },
    { x: 128 },
    { y: 128 },
    { z: 0, x: 1 },
    { z: 0, y: 1 },
    ...['z', 'x', 'y'].flatMap((key) =>
      ['1e3', '0x1', '-0', '-1'].map((value) => ({ [key]: value })),
    ),
    { size: 512 },
    { size: 1024 },
    { size: '0256' },
    { host: 'https://evil.test' },
  ]) {
    assert.equal(
      (await request(tile(coords))).status,
      400,
      JSON.stringify(coords),
    );
  }
  const image = await request('/image?product=radar-global&time=' + TIME);
  assert.equal(image.status, 400);
  assert.equal(body(image).error, 'whole_image_unsupported');
  assert.equal(calls, 0);
});

test('RainViewer metadata retains stale observations and enforces capped reads and 30-second failure backoff', async () => {
  let clock = seconds * 1000,
    calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return Response.json(manifest());
      throw new Error('offline');
    },
  });
  await request('/manifest?product=radar-global');
  clock += 300_000;
  assert.equal(
    body(await request('/manifest?product=radar-global')).stale,
    true,
  );
  clock += 29_999;
  assert.equal(
    body(await request('/manifest?product=radar-global')).latest,
    TIME,
  );
  assert.equal(calls, 2);
  clock++;
  await request('/manifest?product=radar-global');
  assert.equal(calls, 3);
  for (const declared of [false, true]) {
    const capped = install({
      fetchImpl: async () =>
        new Response(' '.repeat(256 * 1024 + 1), {
          headers: declared ? { 'Content-Length': String(256 * 1024 + 1) } : {},
        }),
    });
    assert.equal(
      body(await capped('/manifest?product=radar-global')).unavailable,
      true,
    );
  }
});

test('RainViewer governor is rolling, bounded and supplies the earliest retry time', () => {
  const admit = createRainViewerGovernor();
  for (let i = 0; i < 80; i++) assert.equal(admit(i * 10), 0);
  assert.equal(admit(1000), 59);
  assert.equal(admit(59_999), 1);
  assert.equal(admit(60_000), 0);
  assert.equal(admit(60_000), 1);
  assert.equal(admit(120_000), 0);
});

test('RainViewer server governor stops at 80 upstream tiles across times, admits cache hits and resumes after a minute', async () => {
  let clock = seconds * 1000,
    tiles = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async (url) => {
      if (url.includes('weather-maps.json')) return Response.json(manifest());
      tiles++;
      return png();
    },
  });
  for (let x = 0; x < 80; x++)
    assert.equal((await request(tile({ x }))).status, 200);
  const blocked = await request(tile({ x: 80 }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.equal(tiles, 80);
  assert.equal((await request(tile())).status, 200);
  assert.equal(tiles, 80);
  clock += 60_000;
  assert.equal((await request(tile({ x: 80 }))).status, 200);
  assert.equal(tiles, 81);
});

test('RainViewer rejects non-PNG and wrong PNG dimensions', async () => {
  for (const response of [
    () => png(512),
    () => new Response('bad'),
    () => new Response('bad', { headers: { 'Content-Type': 'image/png' } }),
  ]) {
    const request = install({
      fetchImpl: async (url) =>
        url.includes('weather-maps.json')
          ? Response.json(manifest())
          : response(),
    });
    assert.equal((await request(tile())).status, 503);
  }
});

function fakeGovernorClock() {
  let time = 0;
  const timers = new Set();
  const now = () => time;
  const sleep = (ms, _value, { signal }) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const timer = {
        at: time + ms,
        resolve: () => {
          signal.removeEventListener('abort', abort);
          timers.delete(timer);
          resolve();
        },
      };
      const abort = () => {
        timers.delete(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      timers.add(timer);
    });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    now,
    sleep,
    flush,
    async advance(ms) {
      await flush();
      time += ms;
      for (const timer of [...timers]) if (timer.at <= time) timer.resolve();
      await flush();
    },
  };
}

test('RainViewer queues a 100-request burst in FIFO order through the rolling window', async () => {
  const governor = createRainViewerGovernor();
  const clock = fakeGovernorClock();
  const admitted = [];
  const requests = Array.from({ length: 100 }, (_, i) =>
    governor
      .admit(clock.now, { sleep: clock.sleep, maxWaitMs: 60_000 })
      .then((retry) => {
        assert.equal(retry, 0);
        admitted.push(i);
      }),
  );
  await clock.flush();
  assert.deepEqual(
    admitted,
    Array.from({ length: 80 }, (_, i) => i),
  );
  await clock.advance(59_999);
  assert.equal(admitted.length, 80);
  await clock.advance(1);
  await Promise.all(requests);
  assert.deepEqual(
    admitted,
    Array.from({ length: 100 }, (_, i) => i),
  );
});

test('RainViewer bounds the queue and wait budget with retry seconds', async () => {
  const governor = createRainViewerGovernor();
  const clock = fakeGovernorClock();
  for (let i = 0; i < 80; i++) governor(0);
  assert.equal(await governor.admit(clock.now, { sleep: clock.sleep }), 60);
  await clock.advance(40_000);
  const first = governor.admit(clock.now, { sleep: clock.sleep, maxQueued: 1 });
  assert.equal(
    await governor.admit(clock.now, { sleep: clock.sleep, maxQueued: 1 }),
    20,
  );
  await clock.advance(20_000);
  assert.equal(await first, 0);
});

test('RainViewer abort removes a waiter without consuming capacity or blocking its successor', async () => {
  const governor = createRainViewerGovernor();
  const clock = fakeGovernorClock();
  for (let i = 0; i < 80; i++) governor(0);
  await clock.advance(40_000);
  const controller = new AbortController();
  const aborted = governor.admit(clock.now, {
    sleep: clock.sleep,
    signal: controller.signal,
  });
  const rejection = assert.rejects(aborted, { name: 'AbortError' });
  const next = governor.admit(clock.now, { sleep: clock.sleep });
  controller.abort();
  await rejection;
  await clock.advance(20_000);
  assert.equal(await next, 0);
  for (let i = 0; i < 79; i++) assert.equal(governor(clock.now()), 0);
  assert.equal(governor(clock.now()), 60);
  await assert.rejects(
    governor.admit(clock.now, { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('RainViewer queued requests retain their original deadline across window rechecks', async () => {
  const governor = createRainViewerGovernor();
  const clock = fakeGovernorClock();
  for (let i = 0; i < 80; i++) governor(0);
  await clock.advance(40_000);
  const requests = Array.from({ length: 81 }, () =>
    governor.admit(clock.now, { sleep: clock.sleep }),
  );
  await clock.advance(20_000);
  const results = await Promise.all(requests);
  assert.deepEqual(results.slice(0, 80), Array(80).fill(0));
  assert.equal(results[80], 60);
});

test('RainViewer route waits at the upstream boundary while cache hits and duplicates cost no slots', async () => {
  const clock = fakeGovernorClock();
  let upstreamTiles = 0;
  const request = install({
    now: () => seconds * 1000 + clock.now(),
    rainViewerSleep: clock.sleep,
    fetchImpl: async (url) => {
      if (url.includes('weather-maps.json')) return Response.json(manifest());
      upstreamTiles++;
      return png();
    },
  });
  for (let x = 0; x < 80; x++)
    assert.equal((await request(tile({ x }))).status, 200);
  await clock.advance(40_000);
  const first = request(tile({ x: 80 }));
  const duplicate = request(tile({ x: 80 }));
  await clock.flush();
  assert.equal(upstreamTiles, 80);
  assert.equal((await request(tile())).status, 200);
  await clock.advance(20_000);
  assert.equal((await first).status, 200);
  assert.equal((await duplicate).status, 200);
  assert.equal(upstreamTiles, 81);
});
