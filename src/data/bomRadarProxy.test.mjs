import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bomRadarEnabled,
  bomRadarProxy,
  isPng,
} from '../../server/providers/bomRadar.js';
import { createFrameCache } from '../../server/providers/bomRadar/frameCache.js';
import { createBomFtp } from '../../server/providers/bomRadar/ftp.js';

// Tiny synthetic PNG bytes: the signature plus filler. No BoM imagery is bundled.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('synthetic'),
]);
const MAP = (name, lat, lon) => `IDR000.map
64 ${name} (128 km)
projection = Gnomonic
center_longitude = ${lon}
center_latitude = ${lat}
lon0 = ${lon - 1.4}
lat0 = ${lat - 1.1}
lon1 = ${lon - 1.4}
lat1 = ${lat + 1.1}
lon2 = ${lon + 1.4}
lat2 = ${lat + 1.1}
lon3 = ${lon + 1.4}
lat3 = ${lat - 1.1}
`;
const MAPS = {
  IDR643: MAP('Adelaide', -34.617, 138.469),
  IDR644: MAP('Adelaide', -34.617, 138.469),
  IDR463: MAP('Sellicks Hill', -35.33, 138.5),
};
const frameName = (product, index) =>
  `${product}.T.20261012${String(16 + Math.floor((index * 5) / 60)).padStart(2, '0')}${String((index * 5) % 60).padStart(2, '0')}.png`;
const names = (product, count) =>
  Array.from({ length: count }, (_, i) => frameName(product, i));
const LISTING = [
  ...names('IDR643', 14),
  ...names('IDR644', 3),
  ...names('IDR463', 2),
  'IDR64I.T.202610121609.png',
  'README.txt',
];

function fakeFtp(overrides = {}) {
  const calls = { list: [], download: [], close: 0 };
  return {
    calls,
    async list(directory) {
      calls.list.push(directory);
      return overrides.list ? overrides.list(directory) : LISTING;
    },
    async download(remotePath, maxBytes) {
      calls.download.push({ remotePath, maxBytes });
      if (overrides.download) return overrides.download(remotePath, maxBytes);
      const product = /(IDR\d+)\.map$/.exec(remotePath)?.[1];
      if (product) return Buffer.from(MAPS[product] ?? MAP('Other', -30, 130));
      return PNG;
    },
    close() {
      calls.close++;
    },
  };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const closers = [];
  const plugin = bomRadarProxy({
    env: () => ({ BOM_RADAR_ENABLED: '1' }),
    ...options,
  });
  assert.equal(plugin.name, 'bom-radar');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/bom-radar');
        handler = callback;
      },
    },
    httpServer: { once: (_event, callback) => closers.push(callback) },
  });
  const request = async (url = '/status', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.raw = body;
        if (/json/.test(this.headers['Content-Type']))
          this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
  request.shutdown = () => closers.forEach((callback) => callback());
  request.plugin = plugin;
  return request;
}

test('the opt-in reads the environment at request time, accepting only 1 or true', () => {
  for (const [value, expected] of [
    ['1', true],
    ['true', true],
    [' TRUE ', true],
    ['0', false],
    ['', false],
    ['yes', false],
    ['on', false],
    [undefined, false],
  ])
    assert.equal(
      bomRadarEnabled({ BOM_RADAR_ENABLED: value }),
      expected,
      value,
    );
  const env = {};
  const request = install({ env: () => env, ftp: fakeFtp() });
  return request('/status').then(async (off) => {
    assert.deepEqual(off.body, { enabled: false });
    env.BOM_RADAR_ENABLED = '1';
    assert.deepEqual((await request('/status')).body, { enabled: true });
  });
});

test('while disabled every other route answers 503 and nothing touches the network', async (t) => {
  const fetches = [];
  t.mock.method(globalThis, 'fetch', (...args) => {
    fetches.push(args);
    throw new Error('network');
  });
  const ftp = fakeFtp({
    list: () => assert.fail('listing must not be requested'),
    download: () => assert.fail('download must not be requested'),
  });
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const request = install({ env: () => ({}), ftp }, hook);
    assert.deepEqual((await request('/status')).body, { enabled: false });
    for (const url of [
      '/products',
      '/frames?product=IDR643',
      '/frame/IDR643.T.202610121609.png',
      '/nothing',
      '/frames',
    ]) {
      const res = await request(url);
      assert.equal(res.status, 503, url);
      assert.deepEqual(res.body, { error: 'bom_radar_disabled' });
      assert.equal(res.headers['Cache-Control'], 'no-store');
    }
    assert.equal((await request('/products', 'POST')).status, 405);
  }
  assert.equal(fetches.length, 0);
  assert.deepEqual(ftp.calls, { list: [], download: [], close: 0 });
});

test('the default FTP client is never constructed while the feature is off', async () => {
  // No ftp is injected: touching it would try basic-ftp against the real host.
  const request = install({ env: () => ({ BOM_RADAR_ENABLED: '0' }) });
  assert.equal((await request('/products')).status, 503);
  assert.equal((await request('/frame/IDR643.T.202610121609.png')).status, 503);
});

test('products group the listing by radar and fetch one map per radar, once', async () => {
  const ftp = fakeFtp();
  const request = install({ ftp });
  const res = await request('/products');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.radars, [
    {
      id: '46',
      products: ['IDR463'],
      center: { lat: -35.33, lon: 138.5 },
      name: 'Sellicks Hill',
    },
    {
      id: '64',
      products: ['IDR643', 'IDR644'],
      center: { lat: -34.617, lon: 138.469 },
      name: 'Adelaide',
    },
  ]);
  assert.equal(res.body.complete, true);
  assert.equal(ftp.calls.list.length, 1);
  assert.deepEqual(ftp.calls.list, ['/anon/gen/radar/']);
  const maps = ftp.calls.download.map(({ remotePath }) => remotePath).sort();
  assert.deepEqual(maps, [
    '/anon/gen/radar_transparencies/coordinates/IDR463.map',
    '/anon/gen/radar_transparencies/coordinates/IDR643.map',
  ]);
  assert.ok(ftp.calls.download.every(({ maxBytes }) => maxBytes <= 16 * 1024));
  await request('/products');
  assert.equal(ftp.calls.download.length, 2, 'maps are cached for a day');
  assert.equal(
    ftp.calls.list.length,
    1,
    'the listing is cached for five minutes',
  );
});

test('a slow or failing map leaves the radar without a centre and the response incomplete', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ftp = fakeFtp({
    download: async (remotePath) => {
      if (remotePath.endsWith('IDR643.map')) {
        await gate;
        return Buffer.from(MAPS.IDR643);
      }
      throw new Error('private upstream detail');
    },
  });
  let clock = 0;
  const request = install({ ftp, warmWaitMs: 5, now: () => clock });
  const first = await request('/products');
  assert.equal(first.status, 200);
  assert.equal(first.body.complete, false);
  assert.ok(first.body.radars.every((radar) => !('center' in radar)));
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await request('/products');
  const adelaide = second.body.radars.find(({ id }) => id === '64');
  assert.deepEqual(adelaide.center, { lat: -34.617, lon: 138.469 });
  // The failed radar is retried only after the negative-cache interval.
  const sellicks = second.body.radars.find(({ id }) => id === '46');
  assert.equal(sellicks.center, undefined);
  assert.equal(
    second.body.complete,
    true,
    'a recent failure counts as settled',
  );
  const attempts = ftp.calls.download.length;
  await request('/products');
  assert.equal(ftp.calls.download.length, attempts);
  clock = 700_000;
  await request('/products');
  assert.equal(ftp.calls.download.length, attempts + 1);
});

test('frames return the newest twelve, newest last, with georeferencing', async () => {
  const request = install({ ftp: fakeFtp() });
  const res = await request('/frames?product=IDR643');
  assert.equal(res.status, 200);
  assert.equal(res.body.product, 'IDR643');
  assert.equal(res.body.name, 'Adelaide');
  assert.equal(res.body.rangeKm, 128);
  assert.deepEqual(res.body.bounds, {
    west: 138.469 - 1.4,
    south: -34.617 - 1.1,
    east: 138.469 + 1.4,
    north: -34.617 + 1.1,
  });
  assert.deepEqual(Object.keys(res.body.corners), ['sw', 'nw', 'ne', 'se']);
  assert.equal(res.body.frames.length, 12);
  assert.equal(
    res.body.frames.at(-1).url,
    `/api/bom-radar/frame/${frameName('IDR643', 13)}`,
  );
  assert.equal(
    res.body.frames[0].url,
    `/api/bom-radar/frame/${frameName('IDR643', 2)}`,
  );
  assert.equal(res.body.frames.at(-1).time, '2026-10-12T17:05:00.000Z');
  const times = res.body.frames.map(({ time }) => Date.parse(time));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  assert.equal(res.headers['X-Data-Stale'], undefined);
  assert.equal(res.body.stale, undefined);
});

test('frame requests validate the product before anything else happens', async () => {
  const ftp = fakeFtp();
  const request = install({ ftp });
  for (const url of [
    '/frames',
    '/frames?product=',
    '/frames?product=IDR64I',
    '/frames?product=IDR645',
    '/frames?product=../../etc/passwd',
    '/frames?product=IDR643&product=IDR644',
    '/frames?product=IDR643.map',
  ]) {
    const res = await request(url);
    assert.equal(res.status, 400, url);
    assert.deepEqual(res.body, { error: 'invalid_product' });
  }
  assert.equal(ftp.calls.list.length, 0);
  const unknown = await request('/frames?product=IDR993');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: 'unknown_product' });
  assert.equal(ftp.calls.download.length, 0, 'unlisted products fetch no map');
});

test('frame file names are strict and must be in the current listing', async () => {
  const ftp = fakeFtp();
  const request = install({ ftp });
  for (const url of [
    '/frame/',
    '/frame/IDR64I.T.202610121609.png',
    '/frame/IDR645.T.202610121609.png',
    '/frame/..%2F..%2Fetc%2Fpasswd',
    '/frame/../products',
    '/frame/IDR643.T.202610121609.png/extra',
    '/frame/IDR643.T.202610121609.png%00.png',
    '/frame/IDR643.T.202613121609.png',
    '/frame/idr643.T.202610121609.png',
  ]) {
    const res = await request(url);
    assert.equal(res.status, 400, url);
    assert.deepEqual(res.body, { error: 'invalid_frame' });
  }
  assert.equal(ftp.calls.list.length, 0, 'validation precedes any listing');
  // Well formed but not advertised: no arbitrary upstream fetch.
  const missing = await request('/frame/IDR643.T.202001010000.png');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'unknown_frame' });
  const other = await request('/frame/IDR993.T.202610121600.png');
  assert.equal(other.status, 404);
  assert.deepEqual(ftp.calls.download, []);
});

test('a listed frame is fetched once, served as PNG and then cached', async () => {
  const ftp = fakeFtp();
  const request = install({ ftp });
  const file = frameName('IDR643', 13);
  const res = await request(`/frame/${file}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.headers['Cache-Control'], 'private, max-age=3600');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['Content-Length'], PNG.length);
  assert.ok(isPng(res.raw));
  assert.deepEqual(ftp.calls.download, [
    { remotePath: `/anon/gen/radar/${file}`, maxBytes: 2 * 1024 * 1024 },
  ]);
  await request(`/frame/${file}`);
  assert.equal(ftp.calls.download.length, 1);
});

test('concurrent requests for one frame share a single upstream fetch', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ftp = fakeFtp({ download: async () => (await gate, PNG) });
  const request = install({ ftp });
  const file = frameName('IDR643', 13);
  const pending = [request(`/frame/${file}`), request(`/frame/${file}`)];
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map(({ status }) => status),
    [200, 200],
  );
  assert.equal(ftp.calls.download.length, 1);
});

test('bytes that are not a PNG are rejected and never cached', async () => {
  let body = Buffer.from('<html>550 File unavailable</html>');
  const ftp = fakeFtp({ download: async () => body });
  const request = install({ ftp });
  const file = frameName('IDR643', 13);
  const bad = await request(`/frame/${file}`);
  assert.equal(bad.status, 502);
  assert.deepEqual(bad.body, { error: 'bom_radar_unavailable' });
  body = PNG;
  assert.equal((await request(`/frame/${file}`)).status, 200);
  assert.equal(ftp.calls.download.length, 2);
  for (const sample of [
    Buffer.alloc(0),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from('GIF89a......'),
    PNG.subarray(0, 8),
    'not a buffer',
  ])
    assert.equal(isPng(sample), false);
  assert.equal(isPng(PNG), true);
});

test('the frame cache is bounded by count and by bytes, least recently used first', () => {
  const frame = (size) => Buffer.alloc(size, 1);
  const byCount = createFrameCache({ maxFrames: 3, maxBytes: 1e6 });
  for (const name of ['a', 'b', 'c']) byCount.set(name, frame(10));
  byCount.get('a');
  byCount.set('d', frame(10));
  assert.equal(byCount.get('b'), undefined, 'least recently used is evicted');
  assert.ok(byCount.get('a') && byCount.get('c') && byCount.get('d'));
  assert.deepEqual(byCount.stats(), { frames: 3, bytes: 30 });

  const byBytes = createFrameCache({ maxFrames: 100, maxBytes: 100 });
  byBytes.set('a', frame(40));
  byBytes.set('b', frame(40));
  byBytes.set('c', frame(40));
  assert.equal(byBytes.get('a'), undefined);
  assert.deepEqual(byBytes.stats(), { frames: 2, bytes: 80 });
  assert.equal(byBytes.set('huge', frame(101)), false, 'oversize is refused');
  assert.deepEqual(byBytes.stats(), { frames: 2, bytes: 80 });
  byBytes.set('b', frame(10));
  assert.deepEqual(byBytes.stats(), { frames: 2, bytes: 50 });
  byBytes.clear();
  assert.deepEqual(byBytes.stats(), { frames: 0, bytes: 0 });

  const defaults = createFrameCache();
  for (let i = 0; i < 120; i++) defaults.set(`f${i}`, frame(1000));
  assert.equal(defaults.stats().frames, 96);
});

test('the proxy refetches a frame only after the bounded cache evicted it', async () => {
  const ftp = fakeFtp();
  const request = install({ ftp, cache: { maxFrames: 2 } });
  const files = [4, 5, 6].map((i) => frameName('IDR643', i));
  for (const file of files) await request(`/frame/${file}`);
  assert.equal(ftp.calls.download.length, 3);
  await request(`/frame/${files[2]}`);
  assert.equal(ftp.calls.download.length, 3);
  await request(`/frame/${files[0]}`);
  assert.equal(ftp.calls.download.length, 4, 'the oldest was evicted');
});

test('a failed listing serves the last good one as stale, then gives up', async () => {
  let clock = 1_000;
  let failing = false;
  const ftp = fakeFtp({
    list: async () => {
      if (failing) throw new Error('private upstream detail');
      return LISTING;
    },
  });
  const request = install({ ftp, now: () => clock });
  const fresh = await request('/frames?product=IDR643');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.stale, undefined);

  failing = true;
  clock += 300_001;
  const stale = await request('/frames?product=IDR643');
  assert.equal(stale.status, 200, 'last good data, never an empty list');
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.deepEqual(
    stale.body.frames.map(({ url }) => url),
    fresh.body.frames.map(({ url }) => url),
  );
  assert.equal(stale.body.listedAt, fresh.body.listedAt);
  const products = await request('/products');
  assert.equal(products.status, 200);
  assert.equal(products.body.stale, true);

  // A failed upstream is not hammered: retries wait out a short back-off.
  const attempts = ftp.calls.list.length;
  clock += 5_000;
  await request('/frames?product=IDR643');
  assert.equal(ftp.calls.list.length, attempts);
  clock += 30_000;
  await request('/frames?product=IDR643');
  assert.equal(ftp.calls.list.length, attempts + 1);

  // Hours-old radar is no longer a nowcast.
  clock += 3 * 3_600_000;
  const expired = await request('/frames?product=IDR643');
  assert.equal(expired.status, 502);
  assert.deepEqual(expired.body, { error: 'bom_radar_unavailable' });
  assert.ok(!JSON.stringify(expired.body).includes('private'));
});

test('a failure with no good listing yet is a sanitized 502, and an empty listing is a failure', async () => {
  const down = install({
    ftp: fakeFtp({
      list: async () => {
        throw new Error('ECONNREFUSED 1.2.3.4');
      },
    }),
  });
  for (const url of ['/products', '/frames?product=IDR643']) {
    const res = await down(url);
    assert.equal(res.status, 502, url);
    assert.deepEqual(res.body, { error: 'bom_radar_unavailable' });
  }
  const empty = install({
    ftp: fakeFtp({
      list: async () => ['README.txt', 'IDR64I.T.202610121609.png'],
    }),
  });
  assert.equal((await empty('/products')).status, 502);
});

test('a map that cannot be read blocks that product only', async () => {
  const request = install({
    ftp: fakeFtp({
      download: async (remotePath) =>
        remotePath.endsWith('.map') ? Buffer.from('File Unavailable') : PNG,
    }),
  });
  const res = await request('/frames?product=IDR643');
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'bom_radar_unavailable' });
});

test('a busy FTP queue answers 429 rather than 502', async () => {
  const request = install({
    ftp: fakeFtp({
      list: async () => {
        throw Object.assign(new Error('busy'), { status: 429 });
      },
    }),
  });
  const res = await request('/products');
  assert.equal(res.status, 429);
  assert.equal(res.headers['Retry-After'], '60');
});

test('only GET is accepted, unknown routes are JSON 404s and callers are rate limited', async () => {
  const request = install({ ftp: fakeFtp() });
  const post = await request('/frames?product=IDR643', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  const unknown = await request('/nothing');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: 'unknown_route' });
  let limited = null;
  for (let i = 0; i < 260 && !limited; i++) {
    const res = await request('/frames?product=IDR643', 'GET', 'flooder');
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'a single client is eventually limited');
  assert.deepEqual(limited.body, { error: 'rate_limited' });
  assert.equal(
    (await request('/frames?product=IDR643', 'GET', 'someone-else')).status,
    200,
  );
});

test('the FTP session closes when the HTTP server does', async () => {
  const ftp = fakeFtp();
  const request = install({ ftp }, 'configurePreviewServer');
  request.shutdown();
  assert.equal(ftp.calls.close, 1);
});

/** A real FTP session over a fake client, counting every connect and map fetch. */
function countingSession(listing, gate) {
  const seen = { clients: 0, access: 0, maps: [], closed: 0 };
  const ftp = createBomFtp({
    clientFactory: async () => {
      seen.clients++;
      return {
        async access() {
          seen.access++;
        },
        async list() {
          return listing.map((name) => ({ name, isFile: true }));
        },
        async downloadTo(sink, remotePath) {
          seen.maps.push(remotePath);
          if (seen.maps.length === 1 && gate) await gate;
          const product = /(IDR\d+)\.map$/.exec(remotePath)[1];
          await new Promise((resolve, reject) =>
            sink.write(Buffer.from(MAP(product, -30, 130)), (error) =>
              error ? reject(error) : resolve(),
            ),
          );
        },
        close() {
          seen.closed++;
        },
      };
    },
  });
  return { ftp, seen };
}

test('after the server closes, the warm-up stops: no more maps and no reconnect', async () => {
  const radarListing = ['IDR413', 'IDR423', 'IDR433', 'IDR443', 'IDR453'].map(
    (product) => `${product}.T.202610121609.png`,
  );
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { ftp, seen } = countingSession(radarListing, gate);
  const request = install({ ftp, warmWaitMs: 5 });
  const first = await request('/products');
  assert.equal(first.status, 200);
  assert.equal(first.body.complete, false);
  assert.equal(seen.maps.length, 1, 'the warm-up is blocked on its first map');

  request.shutdown();
  assert.equal(seen.closed, 1, 'the open connection is closed at once');
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(seen.maps.length, 1, 'no further .map download starts');
  assert.equal(seen.clients, 1, 'the warm-up did not reconnect');
  assert.equal(ftp.stats().connected, false);
  assert.equal(ftp.stats().closed, true);
  assert.equal(ftp.stats().queued, 0);
});

test('requests after the server closed fail fast without calling the FTP client', async () => {
  for (const hook of ['http-close', 'closeBundle']) {
    const ftp = fakeFtp();
    const request = install({ ftp }, 'configureServer');
    await request('/products');
    const before = {
      list: ftp.calls.list.length,
      download: ftp.calls.download.length,
    };
    if (hook === 'closeBundle') request.plugin.closeBundle();
    else request.shutdown();
    for (const url of [
      '/products',
      '/frames?product=IDR643',
      `/frame/${frameName('IDR643', 3)}`,
    ]) {
      const res = await request(url);
      assert.equal(res.status, 502, `${hook} ${url}`);
      assert.deepEqual(res.body, { error: 'bom_radar_unavailable' });
    }
    assert.equal(ftp.calls.list.length, before.list, hook);
    assert.equal(ftp.calls.download.length, before.download, hook);
    assert.deepEqual((await request('/status')).body, { enabled: true });
  }
});

test('a proxy that closed before it ever used FTP never builds a session', async () => {
  const request = install({ env: () => ({ BOM_RADAR_ENABLED: '1' }) });
  request.shutdown();
  const res = await request('/products');
  assert.equal(res.status, 502);
});
