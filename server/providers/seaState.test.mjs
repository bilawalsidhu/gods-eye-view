import assert from 'node:assert/strict';
import test from 'node:test';
import { resampleMaskedGrid } from './ifsOcean.js';
import {
  fetchIfsWaveHeight,
  ifsWaveObjectUrls,
  seaStateProxy,
} from './seaState.js';

const NOW = Date.UTC(2026, 9, 24, 6, 54);
const MISSING = 9999;

/** A 4 × 3 source grid, north to south from 90°N, starting at `lo1`. */
function sourceField(values, { lo1 = 0, di = 90, dj = 90 } = {}) {
  return { values, missingValue: MISSING, ni: 4, nj: 3, lo1, la1: 90, di, dj };
}

/** An upstream that serves one wave-stream cycle and 404s every other URL. */
function waveUpstream({ cycle = '20261024/00z', field } = {}) {
  const calls = [];
  const index = `${JSON.stringify({ param: 'mwd', _offset: 0, _length: 10 })}\n${JSON.stringify({ param: 'swh', _offset: 100, _length: 50 })}\n`;
  const fetchImpl = async (url, options) => {
    calls.push({ url, range: options?.headers?.Range });
    assert.equal(options.redirect, 'error');
    if (!url.includes(`/${cycle}/ifs/0p25/wave/`))
      return new Response('', { status: 404 });
    if (url.endsWith('.index')) return new Response(index);
    return new Response(new Uint8Array(50), { status: 206 });
  };
  const decodeImpl = async (bytes) => {
    assert.equal(bytes.byteLength, 50);
    return (
      field ?? {
        ...sourceField([1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1], { lo1: 180 }),
        shortName: 'swh',
        units: 'm',
      }
    );
  };
  return { calls, fetchImpl, decodeImpl };
}

test('the wave stream URLs follow the oper naming, under /wave/', () => {
  assert.deepEqual(
    ifsWaveObjectUrls({ date: '20261023', hour: 18, step: 12 }),
    {
      grib: 'https://data.ecmwf.int/forecasts/20261023/18z/ifs/0p25/wave/20261023180000-12h-wave-fc.grib2',
      index:
        'https://data.ecmwf.int/forecasts/20261023/18z/ifs/0p25/wave/20261023180000-12h-wave-fc.index',
    },
  );
});

test('a run not yet published falls back one cycle, and only the swh bytes are fetched', async () => {
  const upstream = waveUpstream({ cycle: '20261023/18z' });
  const { cycle, grid } = await fetchIfsWaveHeight({
    ...upstream,
    now: () => NOW,
    targetDx: 90,
  });
  assert.equal(cycle.date, '20261023');
  assert.equal(cycle.hour, 18);
  assert.equal(cycle.forecastHour, 12);
  assert.equal(cycle.validIso, '2026-10-24T06:00:00.000Z');
  assert.deepEqual(
    upstream.calls.map((call) => call.url.split('/forecasts/')[1]),
    [
      '20261024/00z/ifs/0p25/wave/20261024000000-6h-wave-fc.index',
      '20261023/18z/ifs/0p25/wave/20261023180000-12h-wave-fc.index',
      '20261023/18z/ifs/0p25/wave/20261023180000-12h-wave-fc.grib2',
    ],
  );
  assert.equal(upstream.calls[2].range, 'bytes=100-149');
  assert.equal(grid.max, 2);
});

test('an index posted before its GRIB file is served also falls back one cycle', async () => {
  const upstream = waveUpstream({ cycle: '20261023/18z' });
  const served = upstream.fetchImpl;
  upstream.fetchImpl = async (url, options) =>
    url.includes('/20261024/00z/') && url.endsWith('.index')
      ? served(url.replace('/20261024/00z/', '/20261023/18z/'), options)
      : served(url, options);
  const { cycle } = await fetchIfsWaveHeight({
    ...upstream,
    now: () => NOW,
    targetDx: 90,
  });
  assert.equal(cycle.hour, 18);
  assert.deepEqual(
    upstream.calls.map((call) => call.url.split('/forecasts/')[1].slice(0, 12)),
    ['20261023/18z', '20261024/00z', '20261023/18z', '20261023/18z'],
  );
});

test('two missing cycles fail rather than reach further back', async () => {
  const upstream = waveUpstream({ cycle: '20261023/12z' });
  await assert.rejects(
    fetchIfsWaveHeight({ ...upstream, now: () => NOW, targetDx: 90 }),
  );
  assert.equal(upstream.calls.length, 2);
});

test('a message that is not significant wave height in metres is refused', async () => {
  for (const field of [
    { ...sourceField(new Array(12).fill(1)), shortName: 'mwd', units: 'm' },
    { ...sourceField(new Array(12).fill(1)), shortName: 'swh', units: 'ft' },
    {
      ...sourceField(new Array(12).fill(MISSING)),
      shortName: 'swh',
      units: 'm',
    },
  ]) {
    const upstream = waveUpstream({ field });
    await assert.rejects(
      fetchIfsWaveHeight({ ...upstream, now: () => NOW, targetDx: 90 }),
      /sea-state field/,
    );
  }
});

/** The route over an injected clock and loader. */
function harness(load) {
  const clock = { now: NOW };
  const plugin = seaStateProxy({ now: () => clock.now, load });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/sea-state');
        handler = callback;
      },
    },
  });
  async function get(url = '/', method = 'GET') {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.raw = body;
        if (this.headers['Content-Type'] === 'application/json')
          this.body = JSON.parse(body);
      },
    };
    await handler({ url, method }, res);
    return res;
  }
  return { get, advance: (ms) => (clock.now += ms) };
}

function snapshot(hour = 18) {
  return {
    cycle: { date: '20261023', hour, forecastHour: 12, validIso: 'x' },
    grid: resampleMaskedGrid(
      sourceField([1, 1, 1, 1, 2, MISSING, 4, 2, 1, 1, 1, 1]),
      90,
    ),
  };
}

test('concurrent first requests share one upstream load, and the grid is the advertised bytes', async () => {
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const route = harness(async () => {
    loads += 1;
    await gate;
    return snapshot();
  });
  const first = route.get();
  // Let the load start, so later callers arrive while it is in flight and
  // after its attempt time is recorded.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  const pending = [first, route.get('/?ignored=1'), route.get()];
  release();
  const answers = await Promise.all(pending);
  assert.equal(loads, 1);
  for (const answer of answers) assert.equal(answer.status, 200);
  const manifest = answers[0].body;
  assert.equal(manifest.field.units, 'm');
  assert.equal(manifest.maxValue, 4);
  assert.equal(manifest.stale, false);
  assert.equal(
    manifest.gridUrl,
    '/api/sea-state/grid/ifs-20261023-18-f12-90.bin',
  );
  const grid = await route.get(manifest.gridUrl.slice('/api/sea-state'.length));
  assert.equal(grid.status, 200);
  assert.equal(grid.headers['Content-Type'], 'application/octet-stream');
  assert.equal(grid.raw.byteLength, manifest.grid.nx * manifest.grid.ny * 4);
  const values = new Float32Array(
    grid.raw.buffer.slice(
      grid.raw.byteOffset,
      grid.raw.byteOffset + grid.raw.byteLength,
    ),
  );
  assert.ok(Number.isNaN(values[manifest.grid.nx + 1]), 'land travels as NaN');
});

test('a fresh field is served from memory; a failed refresh keeps it, marked stale, then waits before retrying', async () => {
  let loads = 0;
  let fail = false;
  const route = harness(async () => {
    loads += 1;
    if (fail) throw new Error('upstream down');
    return snapshot();
  });
  await route.get();
  route.advance(59 * 60_000);
  await route.get();
  assert.equal(loads, 1, 'inside the hour: no upstream call');

  fail = true;
  route.advance(2 * 60_000);
  const stale = await route.get();
  assert.equal(loads, 2);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');

  route.advance(30_000);
  await route.get();
  assert.equal(loads, 2, 'a failure is not retried within a minute');
  route.advance(31_000);
  await route.get();
  assert.equal(loads, 3);
});

test('with nothing good to serve the route answers a fixed 502, and a day-old field is not served', async () => {
  let fail = true;
  const route = harness(async () => {
    if (fail) throw new Error('upstream said something');
    return snapshot();
  });
  const none = await route.get();
  assert.equal(none.status, 502);
  assert.deepEqual(none.body, { error: 'sea_state_unavailable' });
  assert.equal(none.headers['Retry-After'], '60');

  fail = false;
  route.advance(60_000);
  assert.equal((await route.get()).status, 200);
  fail = true;
  route.advance(24 * 3600_000 + 1);
  assert.equal((await route.get()).status, 502);
});

test('only the two newest grids are kept, and unknown paths and methods are refused', async () => {
  let hour = 0;
  const route = harness(async () => snapshot((hour += 6)));
  const first = (await route.get()).body.gridUrl;
  route.advance(3600_000);
  await route.get();
  route.advance(3600_000);
  await route.get();
  const path = (url) => url.slice('/api/sea-state'.length);
  assert.equal((await route.get(path(first))).status, 404);
  assert.equal((await route.get('/grid/../../etc.bin')).status, 404);
  assert.equal((await route.get('/other')).status, 404);
  const post = await route.get('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
});
