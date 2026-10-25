import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORALTEMP_PRODUCTS,
  coralTempUrls,
  fetchCoralTempSst,
  parseEsriAsciiGrid,
  parseLatestTime,
  seaSurfaceTemperatureAnomalyProxy,
  seaSurfaceTemperatureProxy,
} from './seaSurfaceTemperature.js';

const NOW = Date.UTC(2026, 9, 24, 20, 0);
const DAY = '2026-10-22T12:00:00Z';

/** An ESRI ASCII grid (720 × 360 unless the header says otherwise) with the
 * given cells set, the rest land; the values always match the header. */
function asciiGrid(cells = {}, header = {}) {
  const head = {
    ncols: 720,
    nrows: 360,
    xllcenter: -179.97500610351562,
    yllcenter: -89.9749984741211,
    cellsize: 0.5,
    nodata_value: -327.68,
    ...header,
  };
  const rows = [];
  for (let y = 0; y < head.nrows; y += 1) {
    const row = new Array(head.ncols).fill('-327.68');
    for (const [key, value] of Object.entries(cells)) {
      const [ry, rx] = key.split(',').map(Number);
      if (ry === y) row[rx] = String(value);
    }
    rows.push(row.join(' '));
  }
  return (
    Object.entries(head)
      .map(([key, value]) => `${key} ${value}`)
      .join('\n') +
    '\n' +
    rows.join('\n') +
    '\n'
  );
}

/** ERDDAP serving one day: the time query, then that day's grid. */
function erddap({
  grid = asciiGrid({ '0,0': 4.5 }),
  status = 200,
  product = CORALTEMP_PRODUCTS.temperature,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, redirect: options?.redirect });
    if (status !== 200) return new Response('', { status });
    if (url === coralTempUrls(undefined, product).latest)
      return new Response(`time\nUTC\n${DAY}\n`);
    if (url === coralTempUrls(DAY, product).grid) return new Response(grid);
    return new Response('', { status: 404 });
  };
  return { calls, fetchImpl };
}

test('the newest day is asked for first, then that exact day at every 10th cell', async () => {
  const upstream = erddap();
  const { cycle, grid } = await fetchCoralTempSst(upstream);
  assert.deepEqual(
    upstream.calls.map(({ url }) => decodeURIComponent(url)),
    [
      'https://coastwatch.noaa.gov/erddap/griddap/noaacrwsstDaily.csv?time[(last)]',
      'https://coastwatch.noaa.gov/erddap/griddap/noaacrwsstDaily.esriAscii?analysed_sst[(2026-10-22T12:00:00Z)][(-89.975):10:(89.975)][(-179.975):10:(179.975)]',
    ],
  );
  assert.ok(upstream.calls.every(({ redirect }) => redirect === 'error'));
  assert.deepEqual(cycle, {
    date: '20261022',
    validIso: '2026-10-22T12:00:00.000Z',
  });
  assert.equal(grid.la1, 89.525, 'the north row is the last stride');
  assert.equal(grid.lo1, -179.975);
  assert.equal(grid.values[0], 4.5, 'the first text row is the north row');
  assert.equal(grid.valid, 1);
});

test('the anomaly is read from its own dataset and variable, with its own valid range', async () => {
  const product = CORALTEMP_PRODUCTS.anomaly;
  const upstream = erddap({
    product,
    grid: asciiGrid({ '0,0': -3.25, '0,1': 14.5, '0,2': 15.5, '0,3': -16 }),
  });
  const { grid } = await fetchCoralTempSst({ ...upstream, product });
  assert.deepEqual(
    upstream.calls.map(({ url }) => decodeURIComponent(url)),
    [
      'https://coastwatch.noaa.gov/erddap/griddap/noaacrwsstanomalyDaily.csv?time[(last)]',
      // Its latitude axis runs north to south: asked from the north row down.
      'https://coastwatch.noaa.gov/erddap/griddap/noaacrwsstanomalyDaily.esriAscii?sea_surface_temperature_anomaly[(2026-10-22T12:00:00Z)][(89.525):10:(-89.975)][(-179.975):10:(179.975)]',
    ],
  );
  // -2 °C is below the temperature range but a normal cold anomaly.
  assert.equal(grid.values[0], -3.25);
  assert.equal(grid.values[1], 14.5);
  assert.ok(Number.isNaN(grid.values[2]), 'above +15 °C');
  assert.ok(Number.isNaN(grid.values[3]), 'below -15 °C');
  assert.equal(grid.valid, 2);
});

test('an ESRI ASCII grid reads north to south, with nodata and out-of-range values missing', () => {
  const grid = parseEsriAsciiGrid(
    'NCOLS 3\nNROWS 2\nXLLCORNER 0\nYLLCORNER 0\nCELLSIZE 1\nNODATA_VALUE -9\n' +
      '1 -9 2.5\n60 -1.8 3\n',
  );
  assert.equal(grid.lo1, 0.5, 'a corner origin moves to the first centre');
  assert.equal(grid.la1, 1.5);
  assert.equal(grid.values[0], 1);
  assert.ok(Number.isNaN(grid.values[1]), 'nodata');
  assert.ok(Number.isNaN(grid.values[3]), 'outside the valid range');
  assert.equal(grid.valid, 4);
  assert.equal(grid.min, -1.8);
  assert.equal(grid.max, 3);
  for (const bad of [
    'ncols 2\nnrows 2\nxllcenter 0\nyllcenter 0\ncellsize 1\n1 2 3\n',
    'ncols 2\nnrows 1\nxllcenter 0\nyllcenter 0\ncellsize 1\n1 x\n',
    'ncols 2\nnrows 1\nxllcenter 0\nyllcenter 0\ncellsize 0\n1 2\n',
  ])
    assert.throws(() => parseEsriAsciiGrid(bad), /Malformed/);
});

test('a time that is not one ISO instant is refused', () => {
  assert.equal(
    parseLatestTime(`time\nUTC\n${DAY}`),
    '2026-10-22T12:00:00.000Z',
  );
  assert.throws(() => parseLatestTime('time\nUTC\nyesterday'), /time/);
  assert.throws(() => parseLatestTime('<html>'), /time/);
});

test('a grid of any other geometry, an empty field or an upstream error is refused', async () => {
  for (const header of [
    { ncols: 719 },
    { nrows: 359 },
    { cellsize: 0.25 },
    { xllcenter: 0 },
    { yllcenter: 0 },
  ])
    await assert.rejects(
      fetchCoralTempSst(erddap({ grid: asciiGrid({ '0,0': 4.5 }, header) })),
      /Unexpected sea surface temperature grid/,
      JSON.stringify(header),
    );
  await assert.rejects(
    fetchCoralTempSst(erddap({ grid: asciiGrid() })),
    /Empty/,
  );
  await assert.rejects(
    fetchCoralTempSst(erddap({ status: 502 })),
    /CoralTemp HTTP 502/,
  );
});

function harness(load) {
  let now = NOW;
  const plugin = seaSurfaceTemperatureProxy({ now: () => now, load });
  let handler;
  plugin.configureServer({ middlewares: { use: (_, h) => (handler = h) } });
  const get = async (url = '/') => {
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
    if (res.headers['Content-Type'] === 'application/json')
      res.body = JSON.parse(res.raw);
    return res;
  };
  return { get, advance: (ms) => (now += ms) };
}

const snapshot = () => ({
  cycle: { date: '20261022', validIso: '2026-10-22T12:00:00.000Z' },
  grid: {
    nx: 2,
    ny: 2,
    lo1: -179.975,
    la1: 89.525,
    dx: 0.5,
    dy: 0.5,
    values: Float32Array.from([-1.8, 12.345, NaN, 30]),
    valid: 3,
    min: -1.8,
    max: 30,
  },
});

test('the route names the CoralTemp day and serves its grid', async () => {
  const route = harness(async () => snapshot());
  const { body } = await route.get();
  assert.equal(body.source, 'noaa-crw-coraltemp');
  assert.deepEqual(body.field, {
    kind: 'sea-surface-temperature',
    units: 'degC',
  });
  assert.equal(body.minValue, -1.8);
  assert.equal(body.maxValue, 30);
  assert.equal(body.oceanCells, 3);
  assert.equal(body.cycle.validIso, '2026-10-22T12:00:00.000Z');
  assert.equal(
    body.gridUrl,
    '/api/sea-surface-temperature/grid/crw-20261022-0.5.bin',
  );
  const grid = await route.get('/grid/crw-20261022-0.5.bin');
  assert.equal(grid.raw.byteLength, 16);
});

test('daily data refreshes every three hours and is served stale for three days', async () => {
  let loads = 0;
  let fail = false;
  const route = harness(async () => {
    loads += 1;
    if (fail) throw new Error('ERDDAP 502');
    return snapshot();
  });
  await route.get();
  route.advance(3 * 3600_000 - 1);
  await route.get();
  assert.equal(loads, 1, 'inside three hours: no upstream call');
  fail = true;
  route.advance(1);
  const stale = await route.get();
  assert.equal(loads, 2);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  route.advance(72 * 3600_000 - 3 * 3600_000);
  assert.equal((await route.get()).status, 200, 'still within three days');
  route.advance(1);
  const gone = await route.get();
  assert.equal(gone.status, 502);
  assert.deepEqual(gone.body, {
    error: 'sea_surface_temperature_unavailable',
  });
});

test('the anomaly route has its own path, grid ids, field and error', async () => {
  let now = NOW;
  let fail = false;
  const plugin = seaSurfaceTemperatureAnomalyProxy({
    now: () => now,
    load: async () => {
      if (fail) throw new Error('ERDDAP 502');
      return snapshot();
    },
  });
  assert.equal(plugin.name, 'sea-surface-temperature-anomaly');
  let mounted;
  let handler;
  plugin.configureServer({
    middlewares: { use: (path, h) => ((mounted = path), (handler = h)) },
  });
  assert.equal(mounted, '/api/sea-surface-temperature-anomaly');
  const get = async (url = '/') => {
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
    return { ...res, body: JSON.parse(res.raw) };
  };
  const { body } = await get();
  assert.equal(body.source, 'noaa-crw-ssta');
  assert.deepEqual(body.field, {
    kind: 'sea-surface-temperature-anomaly',
    units: 'degC',
  });
  assert.equal(
    body.gridUrl,
    '/api/sea-surface-temperature-anomaly/grid/crwa-20261022-0.5.bin',
  );
  fail = true;
  now += 72 * 3600_000 + 1;
  const gone = await get();
  assert.equal(gone.status, 502);
  assert.deepEqual(gone.body, {
    error: 'sea_surface_temperature_anomaly_unavailable',
  });
});
