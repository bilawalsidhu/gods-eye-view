import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { alphaEarthProxy } from '../alphaEarth.js';
import { computeAlphaEarthChange } from './change.js';
import { ALPHA_EARTH_BANDS, ALPHA_EARTH_GRID_NODATA } from './constants.js';

const COG = {
  key: 'v1/annual/2024/10N/test.tiff',
  zone: 10,
  south: false,
  utmWest: 500_000,
  utmSouth: 5_079_040,
  utmEast: 581_920,
  utmNorth: 5_160_960,
  west: -123,
  southLat: 45.86,
  east: -121.95,
  northLat: 46.6,
};
const BOX = { west: -122.9, south: 46.0, east: -122.85, north: 46.04 };
const QUERY = `west=${BOX.west}&south=${BOX.south}&east=${BOX.east}&north=${BOX.north}&from=2018&to=2024`;

function fakeCatalog(years = [2018, 2024]) {
  return {
    ready: async () => {},
    years: async () => years,
    find: async (year, box) =>
      years.includes(year) &&
      box.west < COG.east &&
      box.east > COG.west &&
      box.south < COG.northLat &&
      box.north > COG.southLat
        ? [{ ...COG, year }]
        : [],
    status: () => ({ loaded: true, loadedAt: 0, years }),
  };
}

/** Every pixel is axis 0 in 2018; in 2024 the west half turns to axis 1. */
function fakeReader() {
  const calls = [];
  return {
    calls,
    async read(cog, level, window) {
      calls.push({ year: cog.year, level, window });
      const w = window.x1 - window.x0;
      const h = window.y1 - window.y0;
      const data = new Int8Array(w * h * ALPHA_EARTH_BANDS);
      for (let row = 0; row < h; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const axis = cog.year === 2024 && col < w / 2 ? 1 : 0;
          data[(row * w + col) * ALPHA_EARTH_BANDS + axis] = 127;
        }
      }
      return data;
    },
  };
}

function install(plugin) {
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use(route, fn) {
        assert.equal(route, '/api/alpha-earth');
        handler = fn;
      },
    },
  });
  return async (url) => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, socket: { remoteAddress: '127.0.0.1' } }, res);
    return res;
  };
}

test('change orchestration reads both years at one level and diffs them', async () => {
  const reader = fakeReader();
  const payload = await computeAlphaEarthChange({
    box: BOX,
    from: 2018,
    to: 2024,
    threshold: 0.5,
    budgetBytes: 64 * 1024 * 1024,
    catalog: fakeCatalog(),
    reader,
  });
  assert.equal(reader.calls.length, 2);
  assert.equal(reader.calls[0].level, reader.calls[1].level);
  assert.equal(payload.pixelMeters, 10 * 2 ** payload.level);
  const grid = Buffer.from(payload.grid, 'base64');
  assert.equal(grid.length, payload.width * payload.height);
  assert.ok(!grid.includes(ALPHA_EARTH_GRID_NODATA));
  assert.ok(payload.stats.changedFraction > 0.3);
  assert.ok(payload.stats.changedFraction < 0.7);
  // West columns changed, east columns did not.
  assert.equal(grid[0], 254);
  assert.equal(grid[payload.width - 1], 0);
});

test('missing coverage in either year is reported, not guessed', async () => {
  await assert.rejects(
    computeAlphaEarthChange({
      box: BOX,
      from: 2018,
      to: 2024,
      budgetBytes: 1e9,
      catalog: fakeCatalog([2024]),
      reader: fakeReader(),
    }),
    (err) => err.code === 'no_coverage',
  );
});

test('the endpoint validates, computes once, coalesces and caches', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'aef-provider-'));
  let computes = 0;
  const call = install(
    alphaEarthProxy({
      catalog: fakeCatalog(),
      reader: fakeReader(),
      cacheDir,
      compute: async (args) => {
        computes += 1;
        return computeAlphaEarthChange(args);
      },
    }),
  );
  assert.equal((await call('/change?west=1')).statusCode, 400);
  assert.equal((await call('/nope')).statusCode, 404);

  const [first, second] = await Promise.all([
    call(`/change?${QUERY}`),
    call(`/change?${QUERY}`),
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(computes, 1, 'concurrent identical requests share one job');
  assert.match(first.body.attribution, /Google DeepMind/);
  assert.equal(first.body.detail, 'standard');

  assert.equal((await call(`/change?${QUERY}`)).statusCode, 200);
  assert.equal(computes, 1, 'memory cache answers repeats');

  const restarted = install(
    alphaEarthProxy({
      catalog: fakeCatalog(),
      reader: fakeReader(),
      cacheDir,
      compute: async () => assert.fail('disk cache should answer'),
    }),
  );
  const fromDisk = await restarted(`/change?${QUERY}`);
  assert.equal(fromDisk.statusCode, 200);
  assert.equal(fromDisk.body.grid, first.body.grid);
});

test('no coverage is a 404 and upstream failure a 502', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'aef-provider-'));
  const uncovered = install(
    alphaEarthProxy({ catalog: fakeCatalog([2024]), reader: fakeReader(), cacheDir }),
  );
  const missing = await uncovered(`/change?${QUERY}`);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error, 'no_coverage');

  const failing = install(
    alphaEarthProxy({
      catalog: fakeCatalog(),
      reader: { read: async () => Promise.reject(new Error('reset')) },
      cacheDir,
    }),
  );
  const failed = await failing(`/change?${QUERY}`);
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.error, 'upstream_failed');
});

test('rate limits and the job cap guard new upstream work', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'aef-provider-'));
  const limited = install(
    alphaEarthProxy({
      catalog: fakeCatalog(),
      reader: fakeReader(),
      cacheDir,
      rateLimiter: () => false,
    }),
  );
  assert.equal((await limited(`/change?${QUERY}`)).statusCode, 429);

  const release = [];
  const busy = install(
    alphaEarthProxy({
      catalog: fakeCatalog(),
      reader: fakeReader(),
      cacheDir,
      compute: () => new Promise((resolve) => release.push(resolve)),
    }),
  );
  const pending = [
    busy(`/change?${QUERY}`),
    busy(`/change?${QUERY.replace('2018', '2019')}`),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  const third = await busy(`/change?${QUERY.replace('2018', '2020')}`);
  assert.equal(third.statusCode, 503);
  assert.equal(third.body.error, 'busy');
  for (const resolve of release) resolve({ grid: '' });
  await Promise.all(pending);
});

test('years and status describe the index', async () => {
  const call = install(
    alphaEarthProxy({ catalog: fakeCatalog(), reader: fakeReader() }),
  );
  const years = await call('/years');
  assert.deepEqual(years.body.years, [2018, 2024]);
  assert.equal(years.body.license, 'CC-BY-4.0');
  const status = await call('/status');
  assert.equal(status.body.index.loaded, true);
  assert.equal(status.body.running, 0);
});
