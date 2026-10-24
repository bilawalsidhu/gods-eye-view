import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchIfsSurfaceCurrents,
  oceanCurrentsProxy,
} from './oceanCurrents.js';

const NOW = Date.UTC(2026, 9, 24, 6, 54);
const MISSING = 9999;
const UNITS = 'm s**-1';

/** A 4 × 3 source component, north to south from 90°N, starting at 0°E. */
function component(shortName, values, units = UNITS) {
  return {
    shortName,
    units,
    values,
    missingValue: MISSING,
    ni: 4,
    nj: 3,
    lo1: 0,
    la1: 90,
    di: 90,
    dj: 90,
  };
}

// The equator row: 0°E flows 3 east and 4 north (5 m/s); 90°E is land in both;
// 180° is sea in `sve` only, so it must be dropped from both.
const EAST = [0, 0, 0, 0, 3, MISSING, 1, -1, 0, 0, 0, 0];
const NORTH = [0, 0, 0, 0, 4, MISSING, MISSING, 1, 0, 0, 0, 0];

/** An upstream that serves one `oper` cycle and 404s every other URL. */
function operUpstream({ fields } = {}) {
  const calls = [];
  const index = [
    { param: '10u', _offset: 0, _length: 10 },
    { param: 'sve', _offset: 100, _length: 50 },
    { param: 'svn', _offset: 200, _length: 60 },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  const fetchImpl = async (url, options) => {
    calls.push({ url, range: options?.headers?.Range });
    if (!url.includes('/20261024/00z/ifs/0p25/oper/'))
      return new Response('', { status: 404 });
    if (url.endsWith('.index')) return new Response(index);
    const [start, end] = options.headers.Range.slice(6).split('-').map(Number);
    return new Response(new Uint8Array(end - start + 1), { status: 206 });
  };
  const decodeImpl = async (bytes) =>
    (fields ?? {
      50: component('sve', EAST),
      60: component('svn', NORTH),
    })[bytes.byteLength];
  return { calls, fetchImpl, decodeImpl };
}

test('both components come from the oper run, by byte range, and only sea in both survives', async () => {
  const upstream = operUpstream();
  const { cycle, grid } = await fetchIfsSurfaceCurrents({
    ...upstream,
    now: () => Date.UTC(2026, 9, 24, 6, 30),
    targetDx: 90,
  });
  assert.equal(cycle.hour, 0);
  assert.deepEqual(
    upstream.calls.map(({ url, range }) => [
      url.split('/oper/')[1],
      range ?? null,
    ]),
    [
      ['20261024000000-6h-oper-fc.index', null],
      ['20261024000000-6h-oper-fc.grib2', 'bytes=100-149'],
      ['20261024000000-6h-oper-fc.grib2', 'bytes=200-259'],
    ],
  );
  const cells = grid.nx * grid.ny;
  assert.equal(grid.values.length, cells * 2, 'u then v');
  const u = (lon) => grid.values[1 * grid.nx + lon / 90];
  const v = (lon) => grid.values[cells + 1 * grid.nx + lon / 90];
  assert.deepEqual([u(0), v(0)], [3, 4]);
  assert.equal(u(270), -1, 'westward flow keeps its sign');
  for (const lon of [90, 180]) {
    assert.ok(Number.isNaN(u(lon)), `${lon}°: u masked`);
    assert.ok(Number.isNaN(v(lon)), `${lon}°: v masked`);
  }
  assert.equal(grid.valid, cells - 2);
  assert.equal(grid.max, 5);
});

test('messages that are not surface sea water velocity in m/s are refused', async () => {
  for (const fields of [
    { 50: component('10u', EAST), 60: component('svn', NORTH) },
    { 50: component('sve', EAST), 60: component('svn', NORTH, 'cm s**-1') },
    {
      50: component('sve', new Array(12).fill(MISSING)),
      60: component('svn', new Array(12).fill(MISSING)),
    },
  ]) {
    const upstream = operUpstream({ fields });
    await assert.rejects(
      fetchIfsSurfaceCurrents({ ...upstream, now: () => NOW, targetDx: 90 }),
      /ocean-current field/,
    );
  }
});

test('the route advertises both components and serves them as one grid', async () => {
  const plugin = oceanCurrentsProxy({
    now: () => NOW,
    load: async () => ({
      cycle: { date: '20261024', hour: 0, forecastHour: 6, validIso: 'x' },
      grid: {
        nx: 2,
        ny: 2,
        lo1: 0,
        la1: 90,
        dx: 180,
        dy: 180,
        values: Float32Array.from([1, 2, 3, NaN, -1, -2, -3, NaN]),
        valid: 3,
        max: 4.24,
      },
    }),
  });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/ocean-currents');
        handler = callback;
      },
    },
  });
  const get = async (url) => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.raw = body;
      },
    };
    await handler({ url, method: 'GET' }, res);
    return res;
  };
  const manifest = JSON.parse((await get('/')).raw);
  assert.deepEqual(manifest.field, {
    kind: 'surface-sea-water-velocity',
    units: 'm/s',
    components: ['u', 'v'],
  });
  assert.equal(manifest.maxSpeed, 4.24);
  assert.equal(manifest.oceanCells, 3);
  assert.equal(
    manifest.gridUrl,
    '/api/ocean-currents/grid/ifs-20261024-0-f6-180.bin',
  );
  const grid = await get(manifest.gridUrl.slice('/api/ocean-currents'.length));
  assert.equal(grid.status, 200);
  assert.equal(grid.raw.byteLength, 8 * 4);
  assert.equal(
    new Float32Array(grid.raw.buffer, grid.raw.byteOffset, 8)[4],
    -1,
  );
});
