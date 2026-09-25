import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { xweatherProxy } from '../../server/providers/xweather.js';
import { encodePng } from '../../server/providers/xweather/png.js';
import { xweatherStamp } from '../../server/providers/xweather/frames.js';
import { validateWeatherSnapshot } from '../layers/weather/source.js';

const NOW = Date.UTC(2026, 8, 24, 16, 31, 10);
const ID = 'cid-7f3a91';
const SECRET = 'sec-5b2e04';
const ORIGIN = 'https://maps.api.xweather.com';
const MIB = 1024 * 1024;

// Frames fall at :34 s on each layer's measured cadence (radar-global 2 min,
// lightning-flash 5 min; alerts' 3 min is Xweather's documented update rate,
// not measured). Like Xweather, 'current' is the newest frame and an
// absolute time resolves to the first frame at or after it.
const CADENCE = {
  'radar-global': 120_000,
  'lightning-flash': 300_000,
  alerts: 180_000,
};
const frameAt = (ms, cadence) =>
  ms - ((((ms - 34_000) % cadence) + cadence) % cadence);
const frameFrom = (ms, cadence) => frameAt(ms + cadence - 1, cadence);
const stampMs = (stamp) =>
  Date.UTC(
    +stamp.slice(0, 4),
    +stamp.slice(4, 6) - 1,
    +stamp.slice(6, 8),
    +stamp.slice(8, 10),
    +stamp.slice(10, 12),
    +stamp.slice(12, 14),
  );
const pixels = (rgba) => {
  const data = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return data;
};
const TILE = encodePng({
  width: 256,
  height: 256,
  data: pixels([200, 40, 40, 160]),
});
const CLEAR = encodePng({
  width: 256,
  height: 256,
  data: pixels([0, 0, 0, 0]),
});
const tileResponse = (bytes = TILE, headers = {}) =>
  new Response(bytes, {
    headers: { 'Content-Type': 'image/png', 'x-cost-tokens': '1', ...headers },
  });
const isLookup = (url) => /\/0\/0\/0\/(?:current|\d{14})\.png$/.test(url);

/** Xweather's free redirect for lookups; billed tiles for canonical frames. */
function fakeXweather({ calls = [], clock = () => NOW, tile } = {}) {
  return async (raw, options) => {
    const url = new URL(raw);
    calls.push({ url, options });
    const lookup = url.pathname.match(
      /^\/([^/]+)\/([^/]+)\/0\/0\/0\/(current|\d{14})\.png$/,
    );
    if (lookup) {
      const cadence = CADENCE[lookup[2]];
      const stamp = xweatherStamp(
        lookup[3] === 'current'
          ? frameAt(clock(), cadence)
          : frameFrom(stampMs(lookup[3]), cadence),
      );
      return new Response(null, {
        status: 302,
        headers: {
          location: `/${lookup[1]}/${lookup[2]}/0/0/0/${stamp}_${stamp}.png`,
          'x-cost-tokens': '0',
        },
      });
    }
    return tile ? tile(url, options) : tileResponse();
  };
}
function memoryFs() {
  const files = new Map();
  return {
    files,
    async readFile(file) {
      if (!files.has(file))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    async writeFile(file, text) {
      files.set(file, text);
    },
    async mkdir() {},
  };
}
function install(options = {}) {
  let handler;
  const plugin = xweatherProxy({
    now: () => NOW,
    env: { XWEATHER_CLIENT_ID: ID, XWEATHER_CLIENT_SECRET: SECRET },
    budgetFs: memoryFs(),
    ...options,
  });
  assert.equal(plugin.name, 'xweather');
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/xweather');
        handler = callback;
      },
    },
  });
  const begin = (url, remoteAddress) => {
    const res = new EventEmitter();
    res.headers = {};
    res.writeHead = (status, headers) => {
      res.statusCode = status;
      res.headers = headers;
    };
    res.end = (body) => {
      res.body = body;
    };
    const req = { url, method: 'GET', socket: { remoteAddress } };
    const done = handler(req, res).then(() => res);
    return { res, done };
  };
  return { begin, request: (url, address) => begin(url, address).done };
}
const body = (res) => JSON.parse(res.body);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const tileUrls = (calls) =>
  calls.filter(({ url }) => !isLookup(url.href)).map(({ url }) => url);
const tile = (time, { z = 3, x = 2, y = 2, size, product } = {}) =>
  `/tile?product=${product ?? 'xweather-radar'}&time=${encodeURIComponent(time)}&z=${z}&x=${x}&y=${y}${size ? `&size=${size}` : ''}`;
async function latest(request, address) {
  return body(await request('/manifest?product=xweather-radar', address))
    .latest;
}

test('status reports no key and the manifest is unavailable without credentials, with no upstream call', async () => {
  const calls = [];
  const { request } = install({ env: {}, fetchImpl: fakeXweather({ calls }) });
  const status = await request('/status');
  assert.equal(status.statusCode, 200);
  assert.deepEqual(body(status), {
    hasKey: false,
    month: '2026-09',
    used: 0,
    allowance: 15_000,
    over: false,
    upstreamError: null,
  });
  const manifest = await request('/manifest?product=xweather-radar');
  assert.equal(manifest.statusCode, 200);
  assert.equal(body(manifest).unavailable, true);
  assert.equal(body(manifest).tileTemplate, null);
  const image = await request(
    '/image?product=xweather-radar&time=2026-09-24T16%3A30%3A34.000Z',
  );
  assert.equal(image.statusCode, 503);
  assert.deepEqual(body(image), { error: 'no_key' });
  assert.equal(calls.length, 0);
});

test('XWEATHER_MONTHLY_FREE_UNITS overrides the free allowance, falling back for anything but a positive integer', async () => {
  for (const [value, expected] of [
    ['5000', 5000],
    ['0', 15_000],
    ['abc', 15_000],
    ['', 15_000],
  ]) {
    const { request } = install({
      env: {
        XWEATHER_CLIENT_ID: ID,
        XWEATHER_CLIENT_SECRET: SECRET,
        XWEATHER_MONTHLY_FREE_UNITS: value,
      },
    });
    const status = body(await request('/status'));
    assert.equal(status.allowance, expected, JSON.stringify(value));
  }
});

test('the manifest lists up to 13 exact frames from free redirects and validates in the browser', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const res = await request('/manifest?product=xweather-radar');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(!res.body.includes(ID) && !res.body.includes(SECRET));
  const value = body(res);
  // Task 4.6 adds these products to validateWeatherSnapshot; until then the
  // shape it checks is asserted directly.
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.product, 'xweather-radar');
  assert.equal(value.source, 'Vaisala Xweather');
  assert.equal(value.unavailable, false);
  assert.equal(value.stale, false);
  assert.deepEqual(value.bounds, {
    west: -180,
    south: -85.0511,
    east: 180,
    north: 85.0511,
  });
  assert.equal(value.times.length, 13);
  for (const [i, time] of value.times.entries()) {
    assert.match(time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:34\.000Z$/);
    assert.equal(new Date(time).toISOString(), time);
    if (i > 0)
      assert.equal(Date.parse(time) - Date.parse(value.times[i - 1]), 120_000);
  }
  assert.equal(value.latest, '2026-09-24T16:30:34.000Z');
  assert.equal(value.latest, value.times.at(-1));
  assert.equal(value.observedAt, value.latest);
  assert.equal(value.fetchedAt, NOW);
  assert.equal(value.tileSize, 256);
  assert.equal(value.maxLevel, 6);
  assert.equal(value.tilingScheme, 'geographic');
  assert.equal(
    value.tileTemplate,
    `/api/xweather/tile?product=xweather-radar&time=${encodeURIComponent(value.latest)}&z={z}&x={x}&y={y}`,
  );
  assert.equal(
    value.imageUrl,
    `/api/xweather/image?product=xweather-radar&time=${encodeURIComponent(value.latest)}`,
  );
  assert.deepEqual(value.imageSize, { width: 4096, height: 2048 });
  assert.deepEqual(value.budget, { used: 0, allowance: 15_000, over: false });
  assert.equal(calls.length, 13);
  for (const { url, options } of calls) {
    assert.ok(isLookup(url.href));
    assert.equal(url.origin, ORIGIN);
    assert.ok(url.pathname.startsWith(`/${ID}_${SECRET}/radar-global/0/0/0/`));
    assert.equal(options.redirect, 'manual');
  }
  const lightning = body(await request('/manifest?product=xweather-lightning'));
  assert.equal(lightning.times.length, 13);
  assert.equal(
    Date.parse(lightning.times.at(-1)) - Date.parse(lightning.times[0]),
    12 * 300_000,
  );
  assert.ok(
    calls
      .slice(13)
      .every(({ url }) => url.pathname.includes('/lightning-flash/0/0/0/')),
  );
  assert.equal(tileUrls(calls).length, 0);
});

test('an image stitches at most 192 source tiles and records their cost', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const time = await latest(request);
  const stamp = xweatherStamp(Date.parse(time));
  const res = await request(
    `/image?product=xweather-radar&time=${encodeURIComponent(time)}&bbox=-120,10,-84,28`,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(
    res.headers['Cache-Control'],
    'public, max-age=86400, immutable',
  );
  const png = Buffer.from(res.body);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 4096);
  assert.equal(png.readUInt32BE(20), 2048);
  const tiles = tileUrls(calls);
  assert.ok(tiles.length > 1 && tiles.length <= 192, String(tiles.length));
  for (const url of tiles) {
    assert.equal(url.origin, ORIGIN);
    assert.match(
      url.pathname,
      new RegExp(
        `^/${ID}_${SECRET}/radar-global/\\d+/\\d+/\\d+/${stamp}_${stamp}\\.png$`,
      ),
    );
  }
  assert.equal(new Set(tiles.map(String)).size, tiles.length);
  const status = body(await request('/status'));
  assert.equal(status.hasKey, true);
  assert.equal(status.used, tiles.length);
  assert.equal(status.upstreamError, null);
  assert.equal(
    body(await request('/manifest?product=xweather-radar')).budget.used,
    tiles.length,
  );

  // The whole extent at its default 4096×2048 costs 64 z3 tiles.
  const before = tileUrls(calls).length;
  const whole = await request(
    `/image?product=xweather-radar&time=${encodeURIComponent(time)}`,
  );
  assert.equal(whole.statusCode, 200);
  const wholeTiles = tileUrls(calls).slice(before);
  assert.equal(wholeTiles.length, 64);
  assert.ok(
    wholeTiles.every((url) => url.pathname.includes('/radar-global/3/')),
  );
});

test('the alerts product lists frames and stitches like radar', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const res = await request('/manifest?product=xweather-alerts');
  assert.equal(res.statusCode, 200);
  const manifest = validateWeatherSnapshot(body(res), 'xweather-alerts');
  assert.equal(manifest.source, 'Vaisala Xweather');
  assert.equal(manifest.times.length, 13);
  assert.equal(
    Date.parse(manifest.times.at(-1)) - Date.parse(manifest.times[0]),
    12 * 180_000,
  );
  assert.deepEqual(manifest.imageSize, { width: 4096, height: 2048 });
  assert.ok(
    calls.every(({ url }) =>
      url.pathname.startsWith(`/${ID}_${SECRET}/alerts/0/0/0/`),
    ),
  );
  const stamp = xweatherStamp(Date.parse(manifest.latest));
  const image = await request(
    `/image?product=xweather-alerts&time=${encodeURIComponent(manifest.latest)}`,
  );
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers['Content-Type'], 'image/png');
  const tiles = tileUrls(calls);
  assert.equal(tiles.length, 64);
  for (const url of tiles)
    assert.match(
      url.pathname,
      new RegExp(
        `^/${ID}_${SECRET}/alerts/3/\\d+/\\d+/${stamp}_${stamp}\\.png$`,
      ),
    );
  // A detail window keeps the 192-tile cap.
  const before = tiles.length;
  const detail = await request(
    `/image?product=xweather-alerts&time=${encodeURIComponent(manifest.latest)}&bbox=-120,10,-84,28`,
  );
  assert.equal(detail.statusCode, 200);
  const window = tileUrls(calls).slice(before);
  assert.ok(window.length > 1 && window.length <= 192, String(window.length));
  assert.ok(window.every((url) => url.pathname.includes('/alerts/')));
});

test('a repeated image is served from cache without upstream fetches', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const time = await latest(request);
  const url = `/image?product=xweather-radar&time=${encodeURIComponent(time)}&size=1024x512`;
  const first = await request(url);
  assert.equal(first.statusCode, 200);
  const count = calls.length;
  const second = await request(url);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(Buffer.from(second.body), Buffer.from(first.body));
  assert.equal(calls.length, count);
});

test('a 200 with a JSON body is an upstream error: not cached, sanitized, credentials never logged', async (t) => {
  let clock = NOW;
  const calls = [];
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const { request } = install({
    now: () => clock,
    fetchImpl: fakeXweather({
      calls,
      clock: () => clock,
      // The content type echoes the client id, as a proxy in front of
      // Xweather might, so the logged refusal needs redaction.
      tile: () =>
        new Response('{"success":false,"error":{"code":"maps_limit"}}', {
          headers: { 'Content-Type': `application/json; client=${ID}` },
        }),
    }),
  });
  const time = await latest(request);
  const refused = await request(tile(time));
  assert.equal(refused.statusCode, 503);
  assert.deepEqual(body(refused), { error: 'xweather_unavailable' });
  assert.ok(!refused.body.includes('maps_limit'));
  const status = body(await request('/status'));
  assert.equal(status.upstreamError, 'xweather_upstream_error');
  assert.equal(status.used, 0);
  const attempts = tileUrls(calls).length;
  assert.ok(attempts > 0);
  assert.equal((await request(tile(time))).statusCode, 503);
  assert.equal(tileUrls(calls).length, attempts);
  clock += 30_000;
  assert.equal((await request(tile(time))).statusCode, 503);
  assert.ok(tileUrls(calls).length > attempts);
  assert.ok(warnings.length > 0);
  for (const line of warnings) {
    assert.ok(!line.includes(ID), line);
    assert.ok(!line.includes(SECRET), line);
  }
});

test('each client may spend 600 source tiles a minute; over it, 429 before any upstream fetch', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const { times } = body(
    await request('/manifest?product=xweather-radar', '10.0.0.2'),
  );
  // A 2:1 window over the southern Pacific that needs 187 z8 tiles.
  const window = (time) =>
    `/image?product=xweather-radar&time=${encodeURIComponent(time)}&bbox=-120,-40,-98,-29`;
  for (const time of times.slice(-3)) {
    const before = tileUrls(calls).length;
    assert.equal((await request(window(time), '10.0.0.2')).statusCode, 200);
    assert.equal(tileUrls(calls).length - before, 187);
  }
  // 3 x 187 = 561 spent; a fourth window would reach 748.
  const count = calls.length;
  const limited = await request(window(times.at(-4)), '10.0.0.2');
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(body(limited), { error: 'xweather_rate_limited' });
  assert.equal(limited.headers['Retry-After'], '2');
  assert.equal(calls.length, count);
  // Cache hits never charge, even over the budget.
  assert.equal(
    (await request(window(times.at(-1)), '10.0.0.2')).statusCode,
    200,
  );
  assert.equal((await request('/status', '10.0.0.2')).statusCode, 200);
  assert.equal(calls.length, count);
  // Another client has its own budget.
  assert.equal(
    (await request(window(times.at(-4)), '10.0.0.3')).statusCode,
    200,
  );
  assert.equal(tileUrls(calls).length, 4 * 187);
});

test('source tiles already decoded are not charged again', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const { times } = body(
    await request('/manifest?product=xweather-radar', '10.0.0.2'),
  );
  const window = (time, bbox = '-120,-40,-98,-29') =>
    `/image?product=xweather-radar&time=${encodeURIComponent(time)}&bbox=${bbox}`;
  for (const time of times.slice(-3))
    assert.equal((await request(window(time), '10.0.0.2')).statusCode, 200);
  const count = calls.length;
  // A new output whose 176 source tiles are all among the 187 decoded ones
  // costs nothing, so 561 spent still leaves room for it.
  const shifted = await request(
    window(times.at(-1), '-119.5,-40,-97.5,-29'),
    '10.0.0.2',
  );
  assert.equal(shifted.statusCode, 200);
  assert.equal(calls.length, count);
});

test('cache hits and fresh manifests never spend the rate limit', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const time = await latest(request, '10.0.0.2');
  assert.equal((await request(tile(time), '10.0.0.2')).statusCode, 200);
  const count = calls.length;
  for (let i = 0; i < 300; i++) {
    const res = await request(
      i % 3 ? tile(time) : '/manifest?product=xweather-radar',
      '10.0.0.2',
    );
    assert.equal(res.statusCode, 200);
  }
  assert.equal(calls.length, count);
});

test('an offline frame walk is not an upstream refusal', async () => {
  const { request } = install({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const manifest = body(await request('/manifest?product=xweather-radar'));
  assert.equal(manifest.unavailable, true);
  assert.equal(body(await request('/status')).upstreamError, null);
});

test('a polar tile needs no frame lookup, even with cold metadata', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const res = await request(
    tile('2026-09-24T16:30:34.000Z', { z: 6, x: 10, y: 0 }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(Buffer.from(res.body).readUInt32BE(16), 256);
  assert.equal(calls.length, 0);
});

test('polar tiles beyond Mercator coverage are transparent without an upstream call', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const time = await latest(request);
  const count = calls.length;
  for (const y of [0, 63]) {
    const res = await request(tile(time, { z: 6, x: 10, y }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    const png = Buffer.from(res.body);
    assert.equal(png.readUInt32BE(16), 256);
  }
  assert.equal(calls.length, count);
});

test('eight upstream slots and a bounded queue cap concurrent work', async () => {
  const waiting = [];
  let active = 0;
  let peak = 0;
  const { request } = install({
    fetchImpl: fakeXweather({
      tile: async () => {
        active++;
        peak = Math.max(active, peak);
        await new Promise((resolve) => waiting.push(resolve));
        active--;
        return tileResponse(CLEAR);
      },
    }),
  });
  const time = await latest(request);
  // Four compositions run at once, each fetching several source tiles. Each
  // request comes from its own client, so no per-client tile budget binds.
  const requests = Array.from({ length: 100 }, (_, x) =>
    request(tile(time, { z: 6, x, y: 20, size: '1024' }), `10.1.0.${x}`),
  );
  await nextTurn();
  assert.equal(active, 8);
  const overflow = await request(tile(time, { z: 6, x: 100, y: 20 }));
  assert.equal(overflow.statusCode, 429);
  assert.deepEqual(body(overflow), { error: 'xweather_busy' });
  assert.equal(overflow.headers['Retry-After'], '2');
  let settled = 0;
  requests.forEach((result) => result.then(() => settled++));
  for (let turn = 0; settled < requests.length && turn < 2000; turn++) {
    waiting.splice(0).forEach((resolve) => resolve());
    await nextTurn();
  }
  const results = await Promise.all(requests);
  assert.ok(results.every((result) => result.statusCode === 200));
  assert.equal(peak, 8);
});

test('a tile body over 1 MiB is refused through readResponseBytesCapped', async () => {
  let clock = NOW;
  const calls = [];
  let oversized = true;
  const { request } = install({
    now: () => clock,
    fetchImpl: fakeXweather({
      calls,
      clock: () => clock,
      tile: () =>
        oversized
          ? tileResponse(TILE, { 'Content-Length': String(2 * MIB) })
          : tileResponse(),
    }),
  });
  const time = await latest(request);
  const refused = await request(tile(time, { z: 0, x: 0, y: 0 }));
  assert.equal(refused.statusCode, 503);
  assert.deepEqual(body(refused), { error: 'xweather_unavailable' });
  const attempts = tileUrls(calls).length;
  // Xweather billed the refused body, so it still counts; a cap is not an
  // upstream refusal, so the card's error stays clear.
  const status = body(await request('/status'));
  assert.equal(status.used, attempts);
  assert.equal(status.upstreamError, null);
  oversized = false;
  clock += 30_000;
  const retried = await request(tile(time, { z: 0, x: 0, y: 0 }));
  assert.equal(retried.statusCode, 200);
  assert.ok(tileUrls(calls).length > attempts);
});

test('times outside the frame list or older than 24 h are 400 unknown_weather_time', async () => {
  let clock = NOW;
  const calls = [];
  const { request } = install({
    now: () => clock,
    fetchImpl: fakeXweather({ calls, clock: () => clock }),
  });
  const time = await latest(request);
  const count = calls.length;
  for (const bad of [
    '2026-09-24T16:30:35.000Z',
    '2026-09-24T16:29:34.000Z',
    '2026-09-24T16:32:34.000Z',
  ]) {
    const res = await request(tile(bad));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(body(res), { error: 'unknown_weather_time' });
  }
  for (const bad of [
    '2026-09-24T16:30:34+00:00',
    '2026-02-30T00:00:00Z',
    'x',
  ]) {
    const res = await request(tile(bad));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(body(res), { error: 'invalid_weather_time' });
  }
  assert.equal(calls.length, count);
  clock += 24 * 3600_000 + 60_000;
  const expired = await request(tile(time));
  assert.equal(expired.statusCode, 400);
  assert.deepEqual(body(expired), { error: 'unknown_weather_time' });
  assert.equal(tileUrls(calls).length, 0);
});

test('malformed queries fail before any upstream request', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const time = encodeURIComponent('2026-09-24T16:30:34.000Z');
  for (const [url, status, error] of [
    ['/manifest?product=radar', 400, 'unknown_weather_product'],
    ['/manifest?product=xweather-radar&x=1', 400, 'invalid_weather_query'],
    [
      '/manifest?product=xweather-radar&product=xweather-radar',
      400,
      'invalid_weather_query',
    ],
    ['/status?product=xweather-radar', 400, 'invalid_weather_query'],
    [
      `/tile?product=xweather-radar&time=${time}&z=7&x=0&y=0`,
      400,
      'invalid_weather_tile',
    ],
    [
      `/tile?product=xweather-radar&time=${time}&z=0&x=0&y=0&size=2048`,
      400,
      'invalid_weather_tile_size',
    ],
    [
      `/image?product=xweather-radar&time=${time}&size=8192x4096`,
      400,
      'invalid_weather_image_size',
    ],
    [
      `/image?product=xweather-radar&time=${time}&bbox=-120,10,-84`,
      400,
      'invalid_weather_bbox',
    ],
    [
      `/image?product=xweather-radar&time=${time}&bbox=-180,86,-172,90`,
      400,
      'invalid_weather_bbox',
    ],
    ['/other', 404, 'not_found'],
  ]) {
    const res = await request(url);
    assert.equal(res.statusCode, status, url);
    assert.deepEqual(body(res), { error }, url);
  }
  assert.equal(calls.length, 0);
});

test('removing the key at runtime stops upstream work on the next request', async () => {
  const calls = [];
  const env = { XWEATHER_CLIENT_ID: ID, XWEATHER_CLIENT_SECRET: SECRET };
  const { request } = install({ env, fetchImpl: fakeXweather({ calls }) });
  const time = await latest(request);
  const count = calls.length;
  env.XWEATHER_CLIENT_SECRET = '';
  const res = await request(tile(time));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(body(res), { error: 'no_key' });
  assert.equal(body(await request('/status')).hasKey, false);
  assert.equal(calls.length, count);
});

test('a client that leaves never gets a response and never marks the source failed', async () => {
  const calls = [];
  const held = [];
  const { begin, request } = install({
    fetchImpl: fakeXweather({
      calls,
      tile: (url, { signal }) =>
        new Promise((resolve, reject) => {
          held.push(() => resolve(tileResponse()));
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    }),
  });
  const time = await latest(request);
  const { res, done } = begin(tile(time, { z: 0, x: 0, y: 0 }));
  await nextTurn();
  assert.ok(held.length > 0);
  res.emit('close');
  await done;
  assert.equal(res.statusCode, undefined);
  assert.equal(body(await request('/status')).upstreamError, null);
  // No cooldown: the same tile is fetched again at once.
  held.length = 0;
  const count = tileUrls(calls).length;
  const retry = begin(tile(time, { z: 0, x: 0, y: 0 }));
  await nextTurn();
  assert.ok(tileUrls(calls).length > count);
  for (let turn = 0; turn < 20 && retry.res.statusCode === undefined; turn++) {
    held.splice(0).forEach((resolve) => resolve());
    await nextTurn();
  }
  assert.equal((await retry.done).statusCode, 200);
});

const lookups = (calls) => calls.filter(({ url }) => isLookup(url.href));
const settle = async (turns = 20) => {
  for (let turn = 0; turn < turns; turn++) await nextTurn();
};

test('a refresh after one new frame makes two lookups and merges with the previous list', async () => {
  let clock = NOW;
  const calls = [];
  const { request } = install({
    now: () => clock,
    fetchImpl: fakeXweather({ calls, clock: () => clock }),
  });
  const first = body(await request('/manifest?product=xweather-radar'));
  assert.equal(first.times.length, 13);
  assert.equal(lookups(calls).length, 13);
  clock += 120_000;
  // Stale: answered from the current list while a refresh starts behind it.
  const during = body(await request('/manifest?product=xweather-radar'));
  assert.deepEqual(during.times, first.times);
  assert.equal(during.stale, false);
  await settle();
  assert.equal(lookups(calls).length, 13 + 2);
  const after = body(await request('/manifest?product=xweather-radar'));
  assert.equal(after.times.length, 13);
  assert.deepEqual(after.times.slice(0, -1), first.times.slice(1));
  assert.equal(Date.parse(after.latest) - Date.parse(first.latest), 120_000);
  assert.equal(after.fetchedAt, clock);
  // The frame the refresh dropped from `times` stays requestable.
  assert.equal((await request(tile(first.times[0]))).statusCode, 200);
  assert.equal(lookups(calls).length, 13 + 2);
});

test('a tile at a known time is served while a refresh is still in flight', async () => {
  let clock = NOW;
  const calls = [];
  const held = [];
  let hold = false;
  const upstream = fakeXweather({ calls, clock: () => clock });
  const { request } = install({
    now: () => clock,
    fetchImpl: (raw, options) =>
      hold && isLookup(raw)
        ? new Promise((resolve) =>
            held.push(() => resolve(upstream(raw, options))),
          )
        : upstream(raw, options),
  });
  const time = await latest(request);
  clock += 120_000;
  hold = true;
  const served = await request(tile(time));
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['Content-Type'], 'image/png');
  // The refresh it started is still waiting on Xweather.
  assert.equal(held.length, 1);
  const manifest = await request('/manifest?product=xweather-radar');
  assert.equal(body(manifest).latest, time);
  assert.equal(held.length, 1);
  hold = false;
  held.splice(0).forEach((release) => release());
  await settle();
  assert.equal(Date.parse(await latest(request)) - Date.parse(time), 120_000);
});

test('a cold tile request still waits for the whole frame walk', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeXweather({ calls }) });
  const res = await request(tile('2026-09-24T16:30:34.000Z'));
  assert.equal(res.statusCode, 200);
  assert.equal(lookups(calls).length, 13);
});

test('a 403 tile is a refusal on the card; a 503 is only unavailable', async () => {
  for (const [status, refusal] of [
    [403, 'xweather_upstream_error'],
    [503, null],
  ]) {
    const { request } = install({
      fetchImpl: fakeXweather({
        tile: () =>
          new Response('{"error":{"code":"x"}}', {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    });
    const time = await latest(request);
    const res = await request(tile(time));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(body(res), { error: 'xweather_unavailable' });
    assert.equal(
      body(await request('/status')).upstreamError,
      refusal,
      String(status),
    );
  }
});

test('a refused frame lookup shows on the card, a 503 does not, and the next redirect clears it', async () => {
  for (const [status, refusal] of [
    [403, 'xweather_upstream_error'],
    [503, null],
  ]) {
    let clock = NOW;
    let failing = true;
    const upstream = fakeXweather({ clock: () => clock });
    const { request } = install({
      now: () => clock,
      fetchImpl: async (raw, options) =>
        failing && isLookup(raw)
          ? new Response('{"error":{"code":"authorization_error"}}', {
              status,
              headers: { 'Content-Type': 'application/json' },
            })
          : upstream(raw, options),
    });
    const manifest = body(await request('/manifest?product=xweather-radar'));
    assert.equal(manifest.unavailable, true);
    assert.equal(
      body(await request('/status')).upstreamError,
      refusal,
      String(status),
    );
    failing = false;
    clock += 30_000;
    const again = body(await request('/manifest?product=xweather-radar'));
    assert.equal(again.times.length, 13);
    assert.equal(body(await request('/status')).upstreamError, null);
  }
});
