import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  weatherProxy,
  parseWeatherCapabilities,
  weatherImageBbox,
  weatherTileBounds,
} from '../../server/providers/weather.js';

const NOW = Date.UTC(2026, 8, 16, 2, 12);
const TIME = '2026-09-16T02:08:00.000Z';
const NAMES = [
  'conus_base_reflectivity_mosaic',
  'global_longwave_imagery_mosaic',
  'goes_longwave_imagery',
  'ldn_lightning_strike_density',
];
function leaf(
  name,
  times = [TIME],
  { west = -130, east = -60, south = 20, north = 55 } = {},
) {
  return `<Layer><Name>${name}</Name><Title>Unused feed title</Title><EX_GeographicBoundingBox><westBoundLongitude>${west}</westBoundLongitude><eastBoundLongitude>${east}</eastBoundLongitude><southBoundLatitude>${south}</southBoundLatitude><northBoundLatitude>${north}</northBoundLatitude></EX_GeographicBoundingBox><Dimension name="time" default="${times.at(-1)}" units="ISO8601" nearestValue="1">${times.join(',')}</Dimension></Layer>`;
}
function xml(times = [TIME]) {
  return `<WMS_Capabilities><Capability><Layer><Title>Parent</Title>${NAMES.map((name) => leaf(name, times)).join('')}</Layer></Capability></WMS_Capabilities>`;
}

// Header fixture only: the provider checks PNG signature/IHDR dimensions, not decompression.
function png(width = 256, height = 256, length = 33) {
  const bytes = Buffer.alloc(length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const image = (bytes = png()) =>
  new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
const tile = ({ product = 'radar', time = TIME, z = 0, x = 0, y = 0 } = {}) =>
  `/tile?product=${product}&time=${encodeURIComponent(time)}&z=${z}&x=${x}&y=${y}`;
const wholeImage = (time = TIME, product = 'clouds') =>
  `/image?product=${product}&time=${encodeURIComponent(time)}`;
function install(options = {}, preview = false) {
  let handler;
  const plugin = weatherProxy({ now: () => NOW, ...options });
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/weather');
        handler = callback;
      },
    },
  });
  const begin = (url, method = 'GET') => {
    const res = new EventEmitter();
    res.headers = {};
    res.writeHead = (status, headers) => {
      res.statusCode = status;
      res.headers = headers;
    };
    res.end = (body) => {
      res.body = body;
    };
    const done = handler({ url, method }, res).then(() => res);
    return { res, done };
  };
  return { begin, request: (url, method) => begin(url, method).done };
}
function fakeFetch(calls = []) {
  return async (url, options) => {
    calls.push({ url: new URL(url), options });
    return url.includes('GetCapabilities') ? new Response(xml()) : image();
  };
}
const body = (res) => JSON.parse(res.body);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('lightning density uses a fixed observed WMS product with attribution and ten-minute metadata TTL', async () => {
  let clock = NOW;
  const calls = [];
  const { request } = install({
    now: () => clock,
    fetchImpl: fakeFetch(calls),
  });
  const manifest = body(await request('/manifest?product=lightning'));
  assert.equal(manifest.product, 'lightning');
  assert.match(manifest.title, /density/);
  assert.match(manifest.description, /not individual GLM flashes/);
  assert.match(manifest.coverage, /not global/);
  assert.match(manifest.attribution, /Vaisala/);
  assert.equal(manifest.observedAt, TIME);
  assert.equal(
    manifest.imageUrl,
    `/api/weather${wholeImage(TIME, 'lightning')}`,
  );
  assert.deepEqual(manifest.imageSize, { width: 4096, height: 2048 });
  assert.equal((await request(tile({ product: 'lightning' }))).statusCode, 200);
  const map = calls[1].url;
  assert.equal(map.origin, 'https://nowcoast.noaa.gov');
  assert.equal(map.pathname, '/geoserver/observations/lightning_detection/ows');
  assert.equal(map.searchParams.get('layers'), NAMES[3]);
  assert.equal(map.searchParams.get('styles'), 'lightning_density');
  assert.equal(map.searchParams.get('time'), TIME);
  assert.equal(map.searchParams.get('width'), '256');
  clock += 599_000;
  await request('/manifest?product=lightning');
  assert.equal(calls.length, 2);
  clock += 2000;
  await request('/manifest?product=lightning');
  assert.equal(calls.length, 3);
});

test('capabilities select exact leaves and preserve irregular observation times', () => {
  const older = '2026-09-16T02:04:14.000Z';
  const text = `<WMS_Capabilities><Layer>${leaf(NAMES[1], ['2026-09-16T01:00:00.000Z'])}${leaf(NAMES[0], [TIME, older, older])}</Layer></WMS_Capabilities>`;
  const result = parseWeatherCapabilities(text, 'radar', NOW);
  assert.deepEqual(result.times, [older, TIME]);
  assert.deepEqual(result.bounds, {
    west: -130,
    east: -60,
    south: 20,
    north: 55,
  });
  assert.deepEqual(parseWeatherCapabilities(text, 'clouds', NOW).times, [
    '2026-09-16T01:00:00.000Z',
  ]);
});

test('metadata caps advertised frames without fabricating interval timestamps', () => {
  const times = Array.from({ length: 40 }, (_, index) =>
    new Date(NOW - (40 - index) * 60_000).toISOString(),
  );
  const parsed = parseWeatherCapabilities(xml(times), 'radar', NOW);
  assert.deepEqual(parsed.times, times.slice(-13));
  assert.deepEqual(parsed.allowedTimes, times.slice(-26));
  for (const text of [
    xml(['2026-09-16T01:00:00Z/2026-09-16T02:00:00Z/PT5M']),
    xml(['2026-02-30T00:00:00Z']),
    xml(['2026-09-17T00:00:00Z']),
    xml(['2026-09-14T00:00:00Z']),
    xml().replace('default="' + TIME, 'default="2026-09-16T02:00:00.000Z'),
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + xml(),
    xml().replace('<westBoundLongitude>-130', '<westBoundLongitude>-999'),
    xml().replace(NAMES[0], 'some_other_product'),
    xml() + leaf(NAMES[0]),
    'x'.repeat(512 * 1024 + 1),
  ])
    assert.throws(() => parseWeatherCapabilities(text, 'radar', NOW));
});

test('geographic tile coordinates use a 2x1 root and reject wrapping/out-of-range input', () => {
  assert.deepEqual(weatherTileBounds(0, 0, 0), [-180, -90, 0, 90]);
  assert.deepEqual(weatherTileBounds(0, 1, 0), [0, -90, 180, 90]);
  assert.deepEqual(weatherTileBounds(1, 2, 1), [0, -90, 90, 0]);
  assert.deepEqual(
    weatherTileBounds(6, 127, 63),
    [177.1875, -90, 180, -87.1875],
  );
  for (const coords of [
    [7, 0, 0],
    [0, 2, 0],
    [0, 0, 1],
    [-1, 0, 0],
    [0, -1, 0],
    [1.5, 0, 0],
  ])
    assert.throws(() => weatherTileBounds(...coords));
});

test('manifest provides honest coverage, actual frame times and a same-origin tile template', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeFetch(calls) }, true);
  for (const product of ['radar', 'clouds', 'clouds-regional']) {
    const value = body(await request(`/manifest?product=${product}`));
    assert.equal(value.product, product);
    assert.equal(value.latest, TIME);
    assert.equal(value.time, TIME);
    assert.equal(value.observedAt, TIME);
    assert.equal(value.fetchedAt, NOW);
    assert.equal(value.unavailable, false);
    assert.equal(value.stale, false);
    assert.deepEqual(value.times, [TIME]);
    assert.equal(value.tileSize, 256);
    assert.equal(value.maxLevel, 6);
    assert.equal(value.tilingScheme, 'geographic');
    assert.equal(
      value.tileTemplate,
      `/api/weather/tile?product=${product}&time=${encodeURIComponent(TIME)}&z={z}&x={x}&y={y}`,
    );
    assert.match(
      value.description,
      product === 'radar' ? /not a rainfall forecast/ : /Not a cloud-only mask/,
    );
    if (product === 'clouds') assert.match(value.description, /2–3 hour/);
    assert.equal(value.imageUrl, `/api/weather${wholeImage(TIME, product)}`);
    assert.deepEqual(
      value.imageSize,
      product === 'clouds'
        ? { width: 2048, height: 1024 }
        : { width: 4096, height: 2048 },
    );
  }
  for (const call of calls) {
    assert.equal(call.url.hostname, 'nowcoast.noaa.gov');
    assert.equal(call.options.redirect, 'error');
  }
});

test('invalid enums, arbitrary destinations and malformed tile inputs never fetch upstream', async () => {
  let calls = 0;
  const { request } = install({
    fetchImpl: async () => {
      calls++;
      throw new Error('should not fetch');
    },
  });
  for (const url of [
    '/manifest',
    '/manifest?product=constructor',
    '/manifest?product=radar&product=clouds',
    '/manifest?product=radar&url=https://127.0.0.1',
    tile() + '&host=169.254.169.254',
    tile() + '&bbox=0,0,1,1',
    tile() + '&layers=other',
    tile({ z: 7 }),
    tile({ x: 2 }),
    tile({ y: 1 }),
    tile({ z: '00' }),
    tile({ x: '-1' }),
    tile({ time: 'latest' }),
    tile({ time: '2026-09-16T02:08:00Z' }),
  ])
    assert.equal((await request(url)).statusCode, 400, url);
  assert.equal(
    (await request('/manifest?product=radar', 'POST')).statusCode,
    405,
  );
  assert.equal((await request('/unknown?product=radar')).statusCode, 404);
  assert.equal(calls, 0);
});

test('tile fixes upstream host/layer/style/size/projection/time and caches exact frame bytes', async () => {
  const calls = [];
  const { request } = install({ fetchImpl: fakeFetch(calls) });
  const response = await request(tile({ z: 1, x: 2, y: 1 }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'image/png');
  const map = calls.find(
    (call) => call.url.searchParams.get('request') === 'GetMap',
  );
  assert.equal(map.url.origin, 'https://nowcoast.noaa.gov');
  assert.equal(map.url.pathname, '/geoserver/observations/weather_radar/ows');
  assert.deepEqual(Object.fromEntries(map.url.searchParams), {
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: NAMES[0],
    styles: 'weather_radar_base_reflectivity',
    srs: 'EPSG:4326',
    bbox: '0,-90,90,0',
    width: '256',
    height: '256',
    format: 'image/png',
    transparent: 'true',
    time: TIME,
  });
  assert.equal(map.options.redirect, 'error');
  assert.deepEqual(
    (await request(tile({ z: 1, x: 2, y: 1 }))).body,
    response.body,
  );
  assert.equal(calls.length, 2);
  const unknown = await request(tile({ time: '2026-09-16T02:07:00.000Z' }));
  assert.equal(unknown.statusCode, 400);
  assert.equal(
    calls.length,
    2,
    'unadvertised observation cannot trigger a GetMap',
  );
});

test('capabilities TTL and bounded last-good state keep observed time distinct from fetch time', async () => {
  let clock = NOW;
  let fail = false;
  let calls = 0;
  const { request } = install({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (fail) throw new Error('secret upstream details');
      return new Response(xml());
    },
  });
  const first = body(await request('/manifest?product=radar'));
  clock += 119_000;
  assert.deepEqual(body(await request('/manifest?product=radar')), first);
  assert.equal(calls, 1);
  fail = true;
  clock += 2000;
  const stale = body(await request('/manifest?product=radar'));
  assert.equal(stale.stale, true);
  assert.equal(stale.unavailable, false);
  assert.equal(stale.observedAt, TIME);
  assert.equal(stale.fetchedAt, NOW);
  assert.doesNotMatch(JSON.stringify(stale), /secret/);
  await request('/manifest?product=radar');
  assert.equal(calls, 2, 'failed metadata retries are throttled');
  clock = NOW + 3600_001;
  const unavailable = body(await request('/manifest?product=radar'));
  assert.equal(unavailable.unavailable, true);
  assert.deepEqual(unavailable.times, []);
  assert.equal(unavailable.observedAt, null);
});

test('stale metadata serves only already-cached exact tiles, never nearest-frame substitution', async () => {
  let clock = NOW;
  let fail = false;
  let mapCalls = 0;
  const { request } = install({
    now: () => clock,
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities')) {
        if (fail) throw new Error('down');
        return new Response(xml());
      }
      mapCalls++;
      return image();
    },
  });
  assert.equal((await request(tile())).statusCode, 200);
  clock += 120_001;
  fail = true;
  assert.equal((await request(tile())).statusCode, 200);
  assert.equal((await request(tile({ x: 1 }))).statusCode, 503);
  assert.equal(mapCalls, 1);
});

test('new metadata revokes removed times before any WMS nearestValue request', async () => {
  let clock = NOW;
  let times = [TIME];
  let maps = 0;
  const { request } = install({
    now: () => clock,
    fetchImpl: async (url) =>
      url.includes('GetCapabilities')
        ? new Response(xml(times))
        : (maps++, image()),
  });
  await request(tile());
  clock += 120_001;
  times = ['2026-09-16T02:10:00.000Z'];
  assert.equal((await request(tile({ x: 1 }))).statusCode, 400);
  assert.equal(maps, 1);
  assert.equal(body(await request('/manifest?product=radar')).latest, times[0]);
});

test('simultaneous metadata coalesces service acquisition without mixing product metadata', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { request } = install({
    fetchImpl: async () => {
      calls++;
      await gate;
      return new Response(xml());
    },
  });
  const a = request('/manifest?product=clouds');
  const b = request('/manifest?product=clouds-regional');
  await nextTurn();
  release();
  const [one, two] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(body(one).product, 'clouds');
  assert.equal(body(two).product, 'clouds-regional');
  assert.notEqual(body(one).title, body(two).title);
});

test('shared tile survives one disconnected consumer but aborts when all leave', async () => {
  let release;
  let activeSignal;
  const { begin, request } = install({
    fetchImpl: async (url, { signal }) => {
      if (url.includes('GetCapabilities')) return new Response(xml());
      activeSignal = signal;
      await new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
      return image();
    },
  });
  await request('/manifest?product=radar');
  const a = begin(tile());
  const b = begin(tile());
  await nextTurn();
  a.res.emit('close');
  assert.equal(activeSignal.aborted, false);
  release();
  assert.equal((await b.done).statusCode, 200);
  assert.equal((await a.done).body, undefined);
  const c = begin(tile({ x: 1 }));
  await nextTurn();
  c.res.emit('close');
  await c.done;
  assert.equal(activeSignal.aborted, true);
  assert.equal(c.res.body, undefined);
});

test('metadata deadline cancels stalled bodies and returns a sanitized unavailable manifest', async () => {
  let cancelled = false;
  const { request } = install({
    timeoutMs: 15,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<WMS_Capabilities>'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  const response = await request('/manifest?product=radar');
  assert.equal(body(response).unavailable, true);
  assert.equal(cancelled, true);
});

test('disconnecting the last metadata consumer permits an immediate new acquisition', async () => {
  let calls = 0;
  let firstSignal;
  const { begin, request } = install({
    fetchImpl: async (_url, { signal }) => {
      calls++;
      if (calls > 1) return new Response(xml());
      firstSignal = signal;
      return await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    },
  });
  const first = begin('/manifest?product=radar');
  await nextTurn();
  first.res.emit('close');
  await first.done;
  assert.equal(firstSignal.aborted, true);
  assert.equal(first.res.body, undefined);
  const second = body(await request('/manifest?product=radar'));
  assert.equal(second.unavailable, false);
  assert.equal(
    calls,
    2,
    'consumer cancellation must not start a failure cooldown',
  );
});

test('streamed metadata cap cancels oversized capabilities before parsing', async () => {
  let cancelled = false;
  const { request } = install({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(300_000));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  assert.equal(
    body(await request('/manifest?product=radar')).unavailable,
    true,
  );
  assert.equal(cancelled, true);
});

test('tile rejects invalid MIME/signature/dimensions, redirects/status errors and oversized bodies', async () => {
  const cases = [
    () =>
      new Response('<ServiceException/>', {
        headers: { 'Content-Type': 'text/xml' },
      }),
    () => image(Buffer.alloc(33)),
    () => image(png(512, 256)),
    () =>
      new Response(png(), {
        status: 302,
        headers: { Location: 'http://127.0.0.1/', 'Content-Type': 'image/png' },
      }),
    () =>
      new Response(png(), {
        status: 503,
        headers: { 'Content-Type': 'image/png' },
      }),
    () => image(png(256, 256, 1024 * 1024 + 1)),
    () =>
      new Response(png(), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(1024 * 1024 + 1),
        },
      }),
  ];
  for (const invalid of cases) {
    const { request } = install({
      fetchImpl: async (url) =>
        url.includes('GetCapabilities') ? new Response(xml()) : invalid(),
    });
    const response = await request(tile());
    assert.equal(response.statusCode, 503);
    assert.deepEqual(body(response), { error: 'weather_upstream_unavailable' });
  }
});

test('tile body deadline cancels a stream after valid headers and PNG prefix', async () => {
  let cancelled = false;
  const { request } = install({
    timeoutMs: 15,
    fetchImpl: async (url) =>
      url.includes('GetCapabilities')
        ? new Response(xml())
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(png());
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'Content-Type': 'image/png' } },
          ),
  });
  assert.equal((await request(tile())).statusCode, 503);
  assert.equal(cancelled, true);
});

test('failed tile retries use a bounded cooldown without caching an error as an image', async () => {
  let clock = NOW;
  let maps = 0;
  const { request } = install({
    now: () => clock,
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities')) return new Response(xml());
      maps++;
      return maps === 1
        ? new Response('private upstream detail', { status: 503 })
        : image();
    },
  });
  assert.equal((await request(tile())).statusCode, 503);
  assert.equal((await request(tile())).statusCode, 503);
  assert.equal(maps, 1);
  clock += 30_001;
  assert.equal((await request(tile())).statusCode, 200);
  assert.equal(maps, 2);
});

test('tile LRU enforces both 128 entries and a 16 MiB byte budget', async () => {
  for (const [length, entries] of [
    [33, 129],
    [600_000, 29],
  ]) {
    let mapCalls = 0;
    const { request } = install({
      fetchImpl: async (url) =>
        url.includes('GetCapabilities')
          ? new Response(xml())
          : (mapCalls++, image(png(256, 256, length))),
    });
    for (let i = 0; i < entries; i++)
      assert.equal(
        (await request(tile({ z: 6, x: i % 128, y: Math.floor(i / 128) })))
          .statusCode,
        200,
      );
    assert.equal(mapCalls, entries);
    await request(tile({ z: 6, x: 0, y: 0 }));
    assert.equal(mapCalls, entries + 1, 'oldest exact frame tile was evicted');
  }
});

test('eight upstream slots and a 96-entry queue bound concurrent unique tile work', async () => {
  const waiting = [];
  let active = 0;
  let peak = 0;
  const { request } = install({
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities')) return new Response(xml());
      active++;
      peak = Math.max(active, peak);
      await new Promise((resolve) => waiting.push(resolve));
      active--;
      return image();
    },
  });
  await request('/manifest?product=radar');
  const requests = Array.from({ length: 104 }, (_, x) =>
    request(tile({ z: 6, x })),
  );
  await nextTurn();
  assert.equal(active, 8);
  const overflow = await request(tile({ z: 6, x: 104 }));
  assert.equal(overflow.statusCode, 429);
  assert.equal(overflow.headers['Retry-After'], '2');
  for (let batch = 0; batch < 13; batch++) {
    waiting.splice(0).forEach((resolve) => resolve());
    await nextTurn();
  }
  assert.ok(
    (await Promise.all(requests)).every((result) => result.statusCode === 200),
  );
  assert.equal(peak, 8);
});

test('global infrared image uses one fixed advertised extent and exact 2048x1024 shape', async () => {
  const calls = [];
  const bounds = { west: -179.99, south: -72.74, east: 179.95, north: 72.73 };
  const { request } = install({
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return url.includes('GetCapabilities')
        ? new Response(
            `<WMS_Capabilities>${leaf(NAMES[1], [TIME], bounds)}</WMS_Capabilities>`,
          )
        : image(png(2048, 1024));
    },
  });
  const manifest = body(await request('/manifest?product=clouds'));
  assert.deepEqual(manifest.bounds, bounds);
  const response = await request(manifest.imageUrl.replace('/api/weather', ''));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'image/png');
  const map = calls[1];
  assert.equal(map.url.origin, 'https://nowcoast.noaa.gov');
  assert.equal(map.url.pathname, '/geoserver/observations/satellite/ows');
  assert.deepEqual(Object.fromEntries(map.url.searchParams), {
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: NAMES[1],
    styles: 'reflectance',
    srs: 'EPSG:4326',
    bbox: '-179.99,-72.74,179.95,72.73',
    width: '2048',
    height: '1024',
    format: 'image/png',
    transparent: 'true',
    time: TIME,
  });
  assert.equal(map.options.redirect, 'error');
  assert.deepEqual((await request(wholeImage())).body, response.body);
  assert.equal(
    calls.length,
    2,
    'whole-image cache avoids another NOAA request',
  );
});

test('whole-image route rejects unknown products, sizes above each product limit, coordinates and arbitrary destinations', async () => {
  let calls = 0;
  const { request } = install({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected fetch');
    },
  });
  for (const url of [
    wholeImage(TIME, 'other'),
    wholeImage() + '&size=4096x2048',
    wholeImage(TIME, 'lightning') + '&size=8192x4096',
    wholeImage(TIME, 'radar') + '&size=8192x4096',
    wholeImage(TIME, 'radar') + '&size=2048x2048',
    wholeImage(TIME, 'radar') + '&size=512x256',
    wholeImage(TIME, 'radar') + '&size=2048X1024',
    wholeImage(TIME, 'radar') + '&size=02048x1024',
    wholeImage(TIME, 'radar') + '&size=2048',
    wholeImage(TIME, 'radar') + '&size=1024x512&size=2048x1024',
    wholeImage() + '&width=4096',
    wholeImage() + '&height=2048',
    wholeImage() + '&z=0',
    wholeImage() + '&bbox=-180,-90,180',
    wholeImage() + '&host=http://127.0.0.1',
    wholeImage() + '&layers=other',
    wholeImage() + '&time=' + encodeURIComponent(TIME),
    wholeImage('latest'),
    '/image?product=clouds',
  ])
    assert.equal((await request(url)).statusCode, 400, url);
  assert.equal(calls, 0);
});

test('whole-image observations must be advertised and unavailable manifests expose no image URL', async () => {
  let maps = 0;
  const { request } = install({
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities')) return new Response(xml());
      maps++;
      return image(png(2048, 1024));
    },
  });
  assert.equal(
    (await request(wholeImage('2026-09-16T02:07:00.000Z'))).statusCode,
    400,
  );
  assert.equal(maps, 0);
  const failed = install({
    fetchImpl: async () => {
      throw new Error('unavailable');
    },
  });
  const manifest = body(await failed.request('/manifest?product=clouds'));
  assert.equal(manifest.unavailable, true);
  assert.equal(manifest.imageUrl, null);
});

test('whole-image PNG bounds reject wrong dimensions and cap declared or streamed bytes at 16 MiB', async () => {
  for (const bytes of [
    png(256, 256),
    png(2048, 2048),
    png(2048, 1024, 16 * 1024 * 1024 + 1),
  ]) {
    const { request } = install({
      fetchImpl: async (url) =>
        url.includes('GetCapabilities') ? new Response(xml()) : image(bytes),
    });
    assert.equal((await request(wholeImage())).statusCode, 503);
  }
  let cancelled = false;
  const declared = install({
    fetchImpl: async (url) =>
      url.includes('GetCapabilities')
        ? new Response(xml())
        : new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                'Content-Type': 'image/png',
                'Content-Length': String(16 * 1024 * 1024 + 1),
              },
            },
          ),
  });
  assert.equal((await declared.request(wholeImage())).statusCode, 503);
  assert.equal(cancelled, true);
  const valid = install({
    fetchImpl: async (url) =>
      url.includes('GetCapabilities')
        ? new Response(xml())
        : image(png(4096, 2048, 6 * 1024 * 1024)),
  });
  assert.equal(
    (await valid.request(wholeImage(TIME, 'clouds-regional'))).statusCode,
    200,
    'a whole regional frame may exceed the 4 MiB tile cap',
  );
});

test('every product serves one whole-extent image at its advertised bounds, sized up to its limit', async () => {
  const maps = [];
  const { request } = install({
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities')) return new Response(xml());
      const params = new URL(url).searchParams;
      maps.push(params);
      return image(
        png(Number(params.get('width')), Number(params.get('height'))),
      );
    },
  });
  for (const [product, name, width] of [
    ['radar', NAMES[0], 4096],
    ['clouds-regional', NAMES[2], 4096],
    ['lightning', NAMES[3], 4096],
    ['clouds', NAMES[1], 2048],
  ]) {
    maps.length = 0;
    const response = await request(wholeImage(TIME, product));
    assert.equal(response.statusCode, 200, product);
    assert.equal(
      response.headers['Cache-Control'],
      'public, max-age=86400, immutable',
    );
    assert.equal(response.body.readUInt32BE(16), width);
    assert.equal(response.body.readUInt32BE(20), width / 2);
    assert.equal(maps.length, 1, 'one upstream request, no composition');
    assert.equal(maps[0].get('layers'), name);
    assert.equal(maps[0].get('bbox'), '-130,20,-60,55');
    assert.equal(maps[0].get('width'), String(width));
    assert.equal(maps[0].get('height'), String(width / 2));
    const smaller = `${wholeImage(TIME, product)}&size=1024x512`;
    assert.equal((await request(smaller)).statusCode, 200);
    assert.equal(maps.length, 2, 'size is part of the cache identity');
    assert.equal(maps[1].get('width'), '1024');
    assert.deepEqual((await request(smaller)).body.readUInt32BE(16), 1024);
    assert.equal(
      (await request(`${wholeImage(TIME, product)}&size=${width}x${width / 2}`))
        .statusCode,
      200,
    );
    assert.equal(maps.length, 2, 'the explicit default shares the cache entry');
  }
});

test('detail windows take a rounded 2:1 bbox inside the product bounds, cached by product, time, size and bbox', async () => {
  const maps = [];
  const { request } = install({
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities')) return new Response(xml());
      const params = new URL(url).searchParams;
      maps.push(params);
      return image(
        png(Number(params.get('width')), Number(params.get('height'))),
      );
    },
  });
  const detail = (product, bbox, extra = '') =>
    `${wholeImage(TIME, product)}&bbox=${bbox}${extra}`;
  for (const [product, name] of [
    ['radar', NAMES[0]],
    ['clouds-regional', NAMES[2]],
    ['lightning', NAMES[3]],
    ['clouds', NAMES[1]],
  ]) {
    maps.length = 0;
    const response = await request(detail(product, '-102,34,-96,37'));
    assert.equal(response.statusCode, 200, product);
    assert.equal(
      response.headers['Cache-Control'],
      'public, max-age=86400, immutable',
    );
    assert.equal(response.body.readUInt32BE(16), 4096, 'every product');
    assert.equal(response.body.readUInt32BE(20), 2048);
    assert.equal(maps[0].get('layers'), name);
    assert.equal(maps[0].get('time'), TIME);
    assert.deepEqual(
      ['bbox', 'width', 'height'].map((key) => maps[0].get(key)),
      ['-102,34,-96,37', '4096', '2048'],
    );
    assert.deepEqual(
      (await request(detail(product, '-102.1,34.05,-95.9,37.1'))).body,
      response.body,
      'values round to 0.25° so nearby requests repeat',
    );
    assert.equal(
      (await request(detail(product, '-102,34,-96,37', '&size=4096x2048')))
        .statusCode,
      200,
    );
    assert.equal(maps.length, 1, 'rounded and explicit-default requests hit');
    const smaller = detail(product, '-102,34,-96,37', '&size=2048x1024');
    assert.equal((await request(smaller)).statusCode, 200);
    assert.equal(maps.length, 2, 'size is part of the cache identity');
    assert.equal(maps[1].get('width'), '2048');
    assert.equal(
      (await request(detail(product, '-97,34,-91,37'))).statusCode,
      200,
    );
    assert.equal(maps.length, 3, 'bbox is part of the cache identity');
    assert.equal((await request(wholeImage(TIME, product))).statusCode, 200);
    assert.equal(maps.length, 4, 'the full extent keeps its own entry');
    assert.equal(maps[3].get('bbox'), '-130,20,-60,55');
  }
  maps.length = 0;
  assert.equal(
    (await request(detail('radar', '-120,25,-70,50.25'))).statusCode,
    200,
    'within 1 % of 2:1',
  );
  assert.equal(maps[0].get('bbox'), '-120,25,-70,50.25');
  for (const bbox of [
    '-120,25,-70,50.5',
    '-134,30,-122,36',
    '-70,40,-58,46',
    '-100,17,-94,20',
    '-100,53,-94,56',
  ]) {
    const response = await request(detail('radar', bbox));
    assert.equal(response.statusCode, 400, bbox);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.deepEqual(body(response), { error: 'invalid_weather_bbox' });
  }
  assert.equal(maps.length, 1, 'rejected windows never reach NOAA');
});

test('malformed detail windows fail before any upstream request', async () => {
  let calls = 0;
  const { request } = install({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected fetch');
    },
  });
  for (const bbox of [
    '',
    '-102,34,-96',
    '-102,34,-96,37,1',
    'a,b,c,d',
    '-102,34,-96,3e1',
    '-102,34,-96,+37',
    '-102,%2034,-96,37',
    '-1020,34,-96,37',
    '-102.1234567,34,-96,37',
    '-96,34,-102,37',
    '-102,37,-96,34',
    '-102,34,-96,40',
    '-102,34,-90,37',
    '-190,34,-178,40',
    '-102,85,-94,91',
    '-100,34,-100,34',
  ]) {
    const response = await request(`${wholeImage(TIME, 'radar')}&bbox=${bbox}`);
    assert.equal(response.statusCode, 400, bbox);
    assert.deepEqual(body(response), { error: 'invalid_weather_bbox' });
  }
  for (const url of [
    `${wholeImage(TIME, 'radar')}&bbox=-102,34,-96,37&size=8192x4096`,
    `${wholeImage(TIME, 'radar')}&bbox=-102,34,-96,37&bbox=-102,34,-96,37`,
    `${tile()}&bbox=-102,34,-96,37`,
    '/manifest?product=radar&bbox=-102,34,-96,37',
  ])
    assert.equal((await request(url)).statusCode, 400, url);
  assert.equal(calls, 0);
  assert.equal(weatherImageBbox(null), null);
  const rounded = weatherImageBbox('-0.1,-0.05,5.9,2.95');
  assert.deepEqual(rounded, [0, 0, 6, 3]);
  assert.ok(Object.is(rounded[0], 0), 'no negative zero in cache keys');
});

test('global whole images and tiles share a byte budget without sharing cache identities', async () => {
  const times = Array.from({ length: 5 }, (_, index) =>
    new Date(NOW - (5 - index) * 60_000).toISOString(),
  );
  let maps = 0;
  const { request } = install({
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities')) return new Response(xml(times));
      maps++;
      const width = Number(new URL(url).searchParams.get('width'));
      return image(width === 2048 ? png(2048, 1024, 4 * 1024 * 1024) : png());
    },
  });
  for (const time of times.slice(0, 4))
    assert.equal((await request(wholeImage(time))).statusCode, 200);
  assert.equal(maps, 4);
  assert.equal(
    (await request(tile({ product: 'clouds', time: times[3] }))).statusCode,
    200,
  );
  assert.equal(
    maps,
    5,
    'same product/time tile does not receive a whole image',
  );
  assert.equal((await request(wholeImage(times[0]))).statusCode, 200);
  assert.equal(
    maps,
    6,
    'adding a tile evicts the oldest image from the shared 16 MiB budget',
  );
  assert.equal((await request(wholeImage(times[0]))).statusCode, 200);
  assert.equal(maps, 6);
});

test('whole-image cache identity includes metadata bounds and shares cancellation/deadlines', async () => {
  let clock = NOW;
  let bounds = { west: -180, south: -60, east: 180, north: 60 };
  let maps = 0;
  const { request } = install({
    now: () => clock,
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities'))
        return new Response(
          `<WMS_Capabilities>${leaf(NAMES[1], [TIME], bounds)}</WMS_Capabilities>`,
        );
      maps++;
      return image(png(2048, 1024));
    },
  });
  await request(wholeImage());
  clock += 120_001;
  bounds = { ...bounds, south: -72 };
  await request(wholeImage());
  assert.equal(
    maps,
    2,
    'new extent must not reuse previously normalized imagery',
  );
  let cancelled = false;
  const stalled = install({
    timeoutMs: 15,
    fetchImpl: async (url) =>
      url.includes('GetCapabilities')
        ? new Response(xml())
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(png(2048, 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'Content-Type': 'image/png' } },
          ),
  });
  assert.equal((await stalled.request(wholeImage())).statusCode, 503);
  assert.equal(cancelled, true);
});

test('exact frame tiles and images are immutable for a day; manifests and errors are uncached', async () => {
  const { request } = install({
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities')) return new Response(xml());
      const width = Number(new URL(url).searchParams.get('width'));
      return image(width === 2048 ? png(2048, 1024) : png());
    },
  });
  for (const url of [tile(), wholeImage()]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await request(url);
      assert.equal(response.statusCode, 200);
      assert.equal(
        response.headers['Cache-Control'],
        'public, max-age=86400, immutable',
      );
    }
  }
  for (const product of ['radar', 'clouds', 'clouds-regional', 'lightning']) {
    const response = await request(`/manifest?product=${product}`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  for (const url of [
    tile({ time: 'latest' }),
    wholeImage('latest'),
    '/tile?product=radar&z=0&x=0&y=0',
    '/image?product=clouds',
  ]) {
    const response = await request(url);
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  const failed = install({
    fetchImpl: async (url) => {
      if (url.includes('GetCapabilities')) return new Response(xml());
      throw new Error('offline');
    },
  });
  for (const url of [tile(), wholeImage()]) {
    const response = await failed.request(url);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
});

for (const product of ['radar', 'clouds-regional', 'lightning']) {
  test(`${product} sizes select WMS dimensions and distinct immutable cache entries`, async () => {
    const maps = [];
    const { request } = install({
      fetchImpl: async (url) => {
        if (url.includes('GetCapabilities')) return new Response(xml());
        const params = new URL(url).searchParams;
        maps.push(params);
        return image(
          png(Number(params.get('width')), Number(params.get('height'))),
        );
      },
    });
    const base = tile({ product, z: 3, x: 4, y: 2 });
    for (const size of [256, 512, 1024]) {
      const url = `${base}&size=${size}`;
      const first = await request(url);
      assert.equal(first.statusCode, 200);
      assert.equal(
        first.headers['Cache-Control'],
        'public, max-age=86400, immutable',
      );
      assert.equal(first.body.readUInt32BE(16), size);
      assert.equal(first.body.readUInt32BE(20), size);
      assert.deepEqual((await request(url)).body, first.body);
    }
    assert.equal((await request(base)).statusCode, 200);
    assert.deepEqual(
      maps.map((p) => [p.get('width'), p.get('height')]),
      [
        ['256', '256'],
        ['512', '512'],
        ['1024', '1024'],
      ],
    );
    assert.equal(new Set(maps.map((p) => p.get('bbox'))).size, 1);
    const manifest = body(await request(`/manifest?product=${product}`));
    assert.equal(manifest.tileSize, 256);
    assert.equal(manifest.maxLevel, 6);
  });
}

test('unsupported or duplicate sizes fail before upstream acquisition', async () => {
  let calls = 0;
  const { request } = install({
    fetchImpl: async () => {
      calls++;
      throw new Error();
    },
  });
  for (const size of [
    '',
    '0',
    '257',
    '2048',
    '-256',
    '0256',
    '256.0',
    '1e3',
    '512&size=1024',
  ]) {
    const response = await request(`${tile()}&size=${size}`);
    assert.equal(response.statusCode, 400, size);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  assert.equal(calls, 0);
});

test('large tile validation checks requested dimensions and bounded compressed bytes', async () => {
  for (const bytes of [
    png(256, 256),
    png(1024, 512),
    png(1024, 1024, 4 * 1024 * 1024 + 65_537),
  ]) {
    const { request } = install({
      fetchImpl: async (url) =>
        url.includes('GetCapabilities') ? new Response(xml()) : image(bytes),
    });
    assert.equal((await request(`${tile()}&size=1024`)).statusCode, 503);
  }
  const { request } = install({
    fetchImpl: async (url) =>
      url.includes('GetCapabilities')
        ? new Response(xml())
        : image(png(1024, 1024, 2 * 1024 * 1024)),
  });
  assert.equal((await request(`${tile()}&size=1024`)).statusCode, 200);
});
