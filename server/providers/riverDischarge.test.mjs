import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RIVER_BATCH_SIZE,
  RIVER_FRESH_MS,
  RIVER_HOURLY_WEIGHT,
  RIVER_STALE_MAX_MS,
  parseRiverBox,
  riverDischargeProxy,
  riverForecastUrl,
  riverRetryCooldownMs,
} from './riverDischarge.js';

const DAY = Date.UTC(2026, 9, 24, 6);

function makePoints(count, { lat0 = 40, lon0 = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const lat = Number((lat0 + Math.floor(i / 20) * 0.5 + 0.025).toFixed(3));
    const lon = Number((lon0 + (i % 20) * 0.5 + 0.025).toFixed(3));
    return {
      id: `${lat.toFixed(3)}_${lon.toFixed(3)}`,
      name: `River ${i}`,
      lat,
      lon,
      p50: 100,
      p90: 300,
      p99: 900,
      mean: 150,
      max: 2000,
    };
  });
}

function floodRow(value = 250) {
  const time = Array.from({ length: 9 }, (_, i) =>
    new Date(DAY + (i - 1) * 86_400_000).toISOString().slice(0, 10),
  );
  const fill = (v) => time.map(() => v);
  return {
    latitude: 0,
    longitude: 0,
    daily: {
      time,
      river_discharge: fill(value),
      river_discharge_median: fill(value),
      river_discharge_min: fill(value / 2),
      river_discharge_max: fill(value * 2),
      river_discharge_p25: fill(value * 0.8),
      river_discharge_p75: fill(value * 1.2),
    },
  };
}

/** A proxy over injected clocks and an upstream that answers per location. */
function harness({ points = makePoints(5), upstream } = {}) {
  const clock = { wall: DAY, mono: 1_000 };
  const calls = [];
  const plugin = riverDischargeProxy({
    pack: {
      points,
      climatology: { start: '2012-08-01', end: '2022-07-31' },
    },
    now: () => clock.wall,
    monotonicNow: () => clock.mono,
    warn() {},
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      calls.push(parsed);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (upstream) return upstream(parsed, calls.length);
      const n = parsed.searchParams.get('latitude').split(',').length;
      return Response.json(Array.from({ length: n }, () => floodRow()));
    },
  });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/river-discharge');
        handler = callback;
      },
    },
  });
  async function get(
    url = '/?south=-90&west=-180&north=90&east=180',
    peer = 'local',
    method = 'GET',
  ) {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  }
  const advance = (ms) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  return { plugin, calls, get, advance };
}

test('the view box grammar is exact: four plain decimals in range, nothing else', () => {
  assert.deepEqual(parseRiverBox('/?south=-10&west=170&north=10.5&east=-170'), {
    south: -10,
    west: 170,
    north: 10.5,
    east: -170,
  });
  for (const bad of [
    '/?south=1&west=2&north=3',
    '/?south=1&west=2&north=3&east=4&url=http://evil',
    '/?south=1&west=2&north=3&east=4&east=5',
    '/?south=1e1&west=2&north=30&east=4',
    '/?south=0x1&west=2&north=30&east=4',
    '/?south=5&west=2&north=3&east=4',
    '/?south=-91&west=2&north=3&east=4',
    '/?south=1&west=2&north=3&east=181',
    '/?south=1&west=2&north=3&east=2',
    '/?south=1.12345&west=2&north=3&east=4',
    '/?south=&west=2&north=3&east=4',
  ])
    assert.equal(parseRiverBox(bad), null, bad);
});

test('upstream URLs carry only bundled cell centres and the fixed variable set', () => {
  const url = new URL(riverForecastUrl(makePoints(2)));
  assert.equal(
    url.origin + url.pathname,
    'https://flood-api.open-meteo.com/v1/flood',
  );
  assert.equal(url.searchParams.get('latitude'), '40.025,40.025');
  assert.equal(url.searchParams.get('longitude'), '0.025,0.525');
  assert.equal(
    url.searchParams.get('daily'),
    'river_discharge,river_discharge_median,river_discharge_min,river_discharge_max,river_discharge_p25,river_discharge_p75',
  );
  assert.equal(url.searchParams.get('past_days'), '1');
  assert.equal(url.searchParams.get('forecast_days'), '8');
  assert.equal(url.searchParams.get('models'), 'seamless_v4');
  assert.equal(url.searchParams.get('timezone'), 'GMT');
});

test('a view reads its points in batches of 50 and returns series with percentiles', async () => {
  const points = makePoints(120);
  const h = harness({ points });
  const res = await h.get();
  assert.equal(res.status, 200);
  assert.equal(h.calls.length, Math.ceil(120 / RIVER_BATCH_SIZE));
  assert.deepEqual(
    h.calls.map((u) => u.searchParams.get('latitude').split(',').length),
    [50, 50, 20],
  );
  assert.equal(res.body.today, '2026-10-24');
  assert.deepEqual(res.body.climatology, {
    start: '2012-08-01',
    end: '2022-07-31',
  });
  assert.equal(res.body.total, 120);
  assert.equal(res.body.partial, false);
  assert.equal(res.body.stale, undefined);
  assert.equal(res.body.points.length, 120);
  const first = res.body.points[0];
  assert.equal(first.p99, 900);
  assert.equal(first.series.time.length, 9);
  assert.equal(first.series.discharge[1], 250);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('only points inside the box are read, and fresh points are not read again', async () => {
  const h = harness({ points: makePoints(40) });
  const west = await h.get('/?south=39&west=-1&north=41&east=3');
  // Two rows (lat 40.025, 40.525) span lon 0.025..9.525; lon ≤ 3 keeps 6 each.
  assert.equal(west.body.points.length, 12);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].searchParams.get('latitude').split(',').length, 12);
  h.advance(RIVER_FRESH_MS - 1);
  const again = await h.get();
  // The twelve cached points are fresh; only the other 28 are read.
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].searchParams.get('latitude').split(',').length, 28);
  assert.equal(again.body.points.length, 40);
  const empty = await h.get('/?south=-60&west=-60&north=-50&east=-50');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.points, []);
  assert.equal(h.calls.length, 2);
});

test('concurrent views share one upstream read per point', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = harness({
    points: makePoints(10),
    upstream: async (url) => {
      await gate;
      const n = url.searchParams.get('latitude').split(',').length;
      return Response.json(Array.from({ length: n }, () => floodRow()));
    },
  });
  const a = h.get();
  const b = h.get('/?south=39&west=-1&north=41&east=3', 'peer-2');
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(h.calls.length, 1);
  assert.equal(ra.body.points.length, 10);
  assert.equal(rb.body.points.length, 6);
});

test('an expired forecast is served stale while the upstream fails, then dropped', async () => {
  let fail = false;
  const h = harness({
    points: makePoints(3),
    upstream: async (url) => {
      if (fail) return new Response('busy', { status: 502 });
      const n = url.searchParams.get('latitude').split(',').length;
      return Response.json(Array.from({ length: n }, () => floodRow()));
    },
  });
  assert.equal((await h.get()).status, 200);
  fail = true;
  h.advance(RIVER_FRESH_MS + 1);
  const stale = await h.get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.points.length, 3);
  assert.equal(stale.body.fetchedAt, DAY);
  h.advance(RIVER_STALE_MAX_MS);
  const gone = await h.get();
  assert.equal(gone.status, 503);
  assert.equal(gone.body.error, 'river_discharge_unavailable');
  assert.ok(Number(gone.headers['Retry-After']) >= 1);
});

test('no data at all is a 503 with Retry-After, and a 429 cools the upstream down', async () => {
  const h = harness({
    points: makePoints(2),
    upstream: async () =>
      new Response('slow down', {
        status: 429,
        headers: { 'Retry-After': '120' },
      }),
  });
  const first = await h.get();
  assert.equal(first.status, 503);
  assert.equal(first.headers['Retry-After'], '120');
  assert.equal(h.calls.length, 1);
  // Inside the cooldown the proxy does not call upstream again.
  h.advance(60_000);
  const second = await h.get();
  assert.equal(second.status, 503);
  assert.equal(second.headers['Retry-After'], '60');
  assert.equal(h.calls.length, 1);
  h.advance(61_000);
  await h.get();
  assert.equal(h.calls.length, 2);
});

test('rows that are not discharge series leave the view partial, not broken', async () => {
  const h = harness({
    points: makePoints(3),
    upstream: async () =>
      Response.json([floodRow(), { daily: { time: ['bad'] } }, floodRow()]),
  });
  const res = await h.get();
  assert.equal(res.status, 200);
  assert.equal(res.body.points.length, 2);
  assert.equal(res.body.partial, true);
  // A wrong location count is a failed read.
  const short = harness({
    points: makePoints(3),
    upstream: async () => Response.json([floodRow()]),
  });
  assert.equal((await short.get()).status, 503);
});

test('the proxy keeps its own hourly ceiling on weighted calls', async () => {
  const points = makePoints(RIVER_HOURLY_WEIGHT + 100);
  const h = harness({ points });
  const res = await h.get();
  assert.equal(res.status, 200);
  const read = h.calls.reduce(
    (sum, u) => sum + u.searchParams.get('latitude').split(',').length,
    0,
  );
  assert.equal(read, RIVER_HOURLY_WEIGHT);
  assert.equal(res.body.points.length, RIVER_HOURLY_WEIGHT);
  assert.equal(res.body.partial, true);
});

test('methods, routes, bad boxes and floods of requests are refused', async () => {
  const h = harness();
  assert.equal((await h.get('/', 'local', 'POST')).status, 405);
  assert.equal((await h.get('/other?south=1')).status, 404);
  assert.equal((await h.get('/?south=1')).status, 400);
  assert.equal(h.calls.length, 0);
  let last;
  for (let i = 0; i < 31; i++)
    last = await h.get('/?south=-1&west=-1&north=1&east=1', 'busy-peer');
  assert.equal(last.status, 429);
  assert.equal(last.headers['Retry-After'], '60');
});

test('a sane Retry-After is honoured within bounds', () => {
  assert.equal(riverRetryCooldownMs('120'), 120_000);
  assert.equal(riverRetryCooldownMs('1'), 5_000);
  assert.equal(riverRetryCooldownMs('999999'), 3_600_000);
  assert.equal(riverRetryCooldownMs('soon'), 60_000);
  assert.equal(riverRetryCooldownMs(null), 60_000);
});
