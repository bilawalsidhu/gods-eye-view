import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import {
  NWPS_LID,
  NWPS_LIST_BUDGET,
  NWPS_LIST_WINDOW_MS,
  NWPS_REFRESH_MS,
  NWPS_REGIONS,
  NWPS_RETRY_AFTER_FAILURE_MS,
  createNwpsStore,
  normalizeNwpsDetail,
  normalizeNwpsGauge,
  normalizeNwpsStatus,
  nwpsCategory,
  nwpsProxy,
  nwpsRegionUrl,
  splitNwpsBounds,
} from './nwps.js';

const quiet = { warn() {} };
const NO_TIME = '0001-01-01T00:00:00Z';

/** One gauge as the NWPS list returns it. */
function rawGauge(lid, lat, lon, observed = {}, forecast = {}) {
  return {
    lid,
    name: `Gauge ${lid}`,
    rfc: { abbreviation: 'WGRFC', name: 'West Gulf River Forecast Center' },
    wfo: { abbreviation: 'EWX', name: 'New Braunfels' },
    state: { abbreviation: 'TX', name: 'Texas' },
    latitude: lat,
    longitude: lon,
    pedts: { observed: 'HGIRG', forecast: 'HGIFF' },
    status: {
      observed: {
        primary: 3.2,
        primaryUnit: 'ft',
        secondary: 0.42,
        secondaryUnit: 'kcfs',
        floodCategory: 'no_flooding',
        validTime: '2026-10-24T01:15:00Z',
        ...observed,
      },
      forecast: {
        primary: -999,
        primaryUnit: '',
        secondary: -999,
        secondaryUnit: '',
        floodCategory: 'fcst_not_current',
        validTime: NO_TIME,
        ...forecast,
      },
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Region box parsed back out of a list URL. */
function boxOf(url) {
  const q = new URL(url).searchParams;
  return ['bbox.xmin', 'bbox.ymin', 'bbox.xmax', 'bbox.ymax'].map((k) =>
    Number(q.get(k)),
  );
}

const twoRegions = [
  { id: 'west', west: -110, south: 30, east: -100, north: 40 },
  { id: 'east', west: -100, south: 30, east: -90, north: 40 },
];

test('the CONUS columns cover their bounds with no gap and no overlap', () => {
  const bounds = { west: -126, south: 24, east: -66, north: 50 };
  const columns = splitNwpsBounds('c', bounds, [-104, -92, -82]);
  assert.deepEqual(
    columns.map((b) => [b.id, b.west, b.east]),
    [
      ['c-1', -126, -104],
      ['c-2', -104, -92],
      ['c-3', -92, -82],
      ['c-4', -82, -66],
    ],
  );
  // Each interior edge is one value shared by both neighbours.
  for (let i = 1; i < columns.length; i++)
    assert.equal(columns[i].west, columns[i - 1].east);
  assert.equal(columns[0].west, bounds.west);
  assert.equal(columns.at(-1).east, bounds.east);
  for (const b of columns) {
    assert.equal(b.south, bounds.south);
    assert.equal(b.north, bounds.north);
  }
  // A dense grid of sample points each falls in exactly one half-open box.
  for (let lon = -126; lon < -66; lon += 0.37)
    for (let lat = 24; lat < 50; lat += 0.29) {
      const hits = columns.filter(
        (b) => lon >= b.west && lon < b.east && lat >= b.south && lat < b.north,
      );
      assert.equal(hits.length, 1, `${lon},${lat}`);
    }
  assert.throws(() => splitNwpsBounds('c', bounds, [-92, -104]), RangeError);
  assert.throws(() => splitNwpsBounds('c', bounds, [-126]), RangeError);
});

test('the production regions reach every state and territory NWPS lists', () => {
  // Extremes of the gauges NWPS returned on 2026-10-24 per area.
  const extremes = [
    [-124.5447, 24.5451],
    [-67.0119, 49.6113],
    [-176.6317, 51.8633],
    [-129.7039, 71.3667],
    [-159.66, 22.2107],
    [-155.1508, 19.2078],
    [-67.9386, 17.6967],
    [-64.6983, 18.4617],
  ];
  for (const [lon, lat] of extremes)
    assert.ok(
      NWPS_REGIONS.some(
        (b) =>
          lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north,
      ),
      `${lon},${lat}`,
    );
  // One snapshot fits NWPS's 10-per-5-minutes limit.
  assert.equal(NWPS_REGIONS.length, 7);
  assert.ok(NWPS_REGIONS.length <= NWPS_LIST_BUDGET && NWPS_LIST_BUDGET < 10);
  assert.deepEqual(
    boxOf(nwpsRegionUrl(NWPS_REGIONS.at(-1))),
    [-161, 17, -64, 23],
  );
  assert.match(nwpsRegionUrl(NWPS_REGIONS[0]), /srid=EPSG_4326/);
});

test('list requests stay inside the budget, and a 429 stops all asking', async () => {
  let clock = 0;
  let requests = 0;
  let limited = false;
  const regions = splitNwpsBounds(
    'r',
    { west: 0, south: 0, east: 12, north: 1 },
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  const store = createNwpsStore({
    regions,
    concurrency: 1,
    log: quiet,
    now: () => clock,
    fetchImpl: async () => {
      requests++;
      return limited
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '600' } })
        : jsonResponse({ gauges: [] });
    },
  });
  // Twelve regions, a budget of eight: four are refused without a request.
  const first = await store.refresh();
  assert.equal(requests, NWPS_LIST_BUDGET);
  assert.equal(first.snapshot.regions.failed.length, 12 - NWPS_LIST_BUDGET);
  // The window rolls over; NWPS now answers 429 with Retry-After: 600.
  clock += NWPS_LIST_WINDOW_MS;
  limited = true;
  requests = 0;
  await store.refresh();
  assert.equal(requests, 1, 'the first 429 stops the rest of the build');
  // Still inside NWPS's own window, past ours: nothing is asked.
  clock += NWPS_LIST_WINDOW_MS;
  await store.refresh();
  assert.equal(requests, 1);
  clock += 600_000;
  limited = false;
  await store.refresh();
  assert.equal(requests, 1 + NWPS_LIST_BUDGET);
});

test('statuses drop NWPS sentinels and split stage from flow by unit', () => {
  assert.deepEqual(
    normalizeNwpsStatus({
      primary: -999,
      primaryUnit: '',
      secondary: -999,
      secondaryUnit: '',
      floodCategory: 'fcst_not_current',
      validTime: NO_TIME,
    }),
    {
      stage: null,
      stageUnit: null,
      flow: null,
      flowUnit: null,
      category: 'fcst_not_current',
      time: null,
    },
  );
  // About 1% of gauges report flow first.
  assert.deepEqual(
    normalizeNwpsStatus({
      primary: 12.5,
      primaryUnit: 'kcfs',
      secondary: 7.1,
      secondaryUnit: 'ft',
      floodCategory: 'MINOR',
      validTime: '2026-10-24T01:00:00Z',
    }),
    {
      stage: 7.1,
      stageUnit: 'ft',
      flow: 12.5,
      flowUnit: 'kcfs',
      category: 'minor',
      time: '2026-10-24T01:00:00.000Z',
    },
  );
  // A negative tidal stage is a reading, not a sentinel.
  assert.equal(
    normalizeNwpsStatus({ primary: -2.4, primaryUnit: 'ft' }).stage,
    -2.4,
  );
  assert.equal(
    normalizeNwpsStatus({ primary: 4, primaryUnit: 'furlongs' }).stage,
    null,
  );
});

test('flood categories pass through; anything unknown is not a flood', () => {
  for (const c of [
    'major',
    'moderate',
    'minor',
    'action',
    'low_threshold',
    'no_flooding',
    'not_defined',
    'obs_not_current',
    'fcst_not_current',
    'out_of_service',
  ])
    assert.equal(nwpsCategory(c), c);
  assert.equal(nwpsCategory(' Moderate '), 'moderate');
  assert.equal(nwpsCategory('record'), 'not_defined');
  assert.equal(nwpsCategory(undefined), 'not_defined');
});

test('a list gauge trims to the drawn fields; bad ids and positions drop', () => {
  const trimmed = normalizeNwpsGauge(
    rawGauge('aait2', 30.221111111, -97.793333333),
  );
  assert.deepEqual(trimmed, {
    lid: 'AAIT2',
    name: 'Gauge aait2',
    lat: 30.22111,
    lon: -97.79333,
    state: 'TX',
    wfo: 'EWX',
    observed: {
      stage: 3.2,
      stageUnit: 'ft',
      flow: 0.42,
      flowUnit: 'kcfs',
      category: 'no_flooding',
      time: '2026-10-24T01:15:00.000Z',
    },
    forecast: null,
  });
  const forecast = normalizeNwpsGauge(
    rawGauge(
      'BLOT2',
      30,
      -97,
      {},
      {
        primary: 15.2,
        primaryUnit: 'ft',
        floodCategory: 'minor',
        validTime: '2026-10-25T12:00:00Z',
      },
    ),
  ).forecast;
  assert.equal(forecast.stage, 15.2);
  assert.equal(forecast.category, 'minor');
  assert.equal(normalizeNwpsGauge(rawGauge('../x', 30, -97)), null);
  assert.equal(normalizeNwpsGauge(rawGauge('AAIT22', 30, -97)), null);
  assert.equal(normalizeNwpsGauge(rawGauge('AAIT2', 95, -97)), null);
  assert.equal(normalizeNwpsGauge(rawGauge('AAIT2', 'x', -97)), null);
});

test('the sample NWPS detail trims to stages, top crests and the USGS id', () => {
  const raw = JSON.parse(
    readFileSync(
      new URL('../../src/data/fixtures/nwps-gauge-aait2.json', import.meta.url),
    ),
  );
  const detail = normalizeNwpsDetail(raw);
  assert.equal(detail.lid, 'AAIT2');
  assert.equal(detail.usgsId, '08158930');
  assert.equal(detail.inService, true);
  assert.equal(detail.stageUnit, 'ft');
  assert.equal(detail.flowUnit, 'cfs');
  assert.deepEqual(detail.thresholds, {
    action: { stage: null, flow: null },
    minor: { stage: 13, flow: null },
    moderate: { stage: 14, flow: null },
    major: { stage: 18, flow: null },
  });
  assert.deepEqual(
    detail.crests.historic.map((c) => c.stage),
    [16.1, 14.94],
  );
  assert.equal(detail.crests.recent[0].time, '2019-05-04T03:10:00.000Z');
  assert.ok(detail.crests.historic.length <= 3);
  assert.match(detail.forecastReliability, /high water/);
  assert.ok(detail.attribution.includes('US Geological Survey'));
  // Nothing past the card's needs: no images, impacts or datum tables.
  assert.deepEqual(Object.keys(detail).sort(), [
    'attribution',
    'crests',
    'flowUnit',
    'forecastReliability',
    'inService',
    'lid',
    'name',
    'serviceNote',
    'stageUnit',
    'thresholds',
    'usgsId',
  ]);
  const many = normalizeNwpsDetail({
    ...raw,
    usgsId: 'javascript:1',
    flood: {
      ...raw.flood,
      crests: {
        historic: [3, 9, 1, 7, 5].map((stage, i) => ({
          occurredTime: `200${i}-01-01T00:00:00Z`,
          stage,
          flow: -9999,
        })),
        recent: [],
      },
    },
  });
  assert.equal(many.usgsId, null);
  assert.deepEqual(
    many.crests.historic.map((c) => c.stage),
    [9, 7, 5],
  );
  assert.equal(many.crests.historic[0].flow, null);
});

test('one snapshot reads every region once, dedupes shared edges and counts categories', async () => {
  const calls = [];
  const store = createNwpsStore({
    regions: twoRegions,
    log: quiet,
    fetchImpl: async (url) => {
      calls.push(boxOf(url)[0]);
      return boxOf(url)[0] === -110
        ? jsonResponse({
            gauges: [
              rawGauge('AAAA1', 35, -105, { floodCategory: 'moderate' }),
              rawGauge('EDGE1', 35, -100),
            ],
          })
        : jsonResponse({
            gauges: [
              rawGauge('EDGE1', 35, -100),
              rawGauge('BBBB1', 35, -95, { floodCategory: 'action' }),
            ],
          });
    },
  });
  const built = await store.current();
  assert.deepEqual(
    calls.sort((a, b) => a - b),
    [-110, -100],
  );
  assert.deepEqual(
    built.snapshot.gauges.map((g) => g.lid),
    ['AAAA1', 'BBBB1', 'EDGE1'],
  );
  assert.equal(built.snapshot.counts.moderate, 1);
  assert.equal(built.snapshot.counts.action, 1);
  assert.equal(built.snapshot.counts.no_flooding, 1);
  assert.equal(built.snapshot.stale, false);
  assert.deepEqual(JSON.parse(gunzipSync(built.gzip)), built.snapshot);
});

test('concurrent callers share one build (single flight) within the concurrency cap', async () => {
  let inFlight = 0;
  let peak = 0;
  let requests = 0;
  const regions = splitNwpsBounds(
    'r',
    { west: 0, south: 0, east: 6, north: 1 },
    [1, 2, 3, 4, 5],
  );
  const store = createNwpsStore({
    regions,
    concurrency: 2,
    log: quiet,
    fetchImpl: async () => {
      requests++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return jsonResponse({ gauges: [] });
    },
  });
  const all = await Promise.all([
    store.current(),
    store.current(),
    store.current(),
  ]);
  assert.equal(requests, 6, 'one read per region, not per caller');
  assert.equal(peak, 2);
  assert.ok(all.every((built) => built === all[0]));
});

test('a due rebuild serves the previous snapshot meanwhile, then replaces it', async () => {
  let clock = 1_000_000;
  let gate = null;
  let stage = 1;
  const store = createNwpsStore({
    regions: twoRegions.slice(0, 1),
    log: quiet,
    now: () => clock,
    fetchImpl: async () => {
      if (gate) await gate;
      return jsonResponse({
        gauges: [rawGauge('AAAA1', 35, -105, { primary: stage })],
      });
    },
  });
  const first = await store.current();
  assert.equal(first.snapshot.gauges[0].observed.stage, 1);
  // Not yet due: no request.
  clock += NWPS_REFRESH_MS - 1;
  assert.equal(await store.current(), first);
  clock += 1;
  let release;
  gate = new Promise((resolve) => (release = resolve));
  stage = 2;
  const during = await store.current();
  assert.equal(during, first, 'stale-while-refresh');
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await store.current();
  assert.equal(after.snapshot.gauges[0].observed.stage, 2);
});

test('a failed region keeps its previous gauges and marks the snapshot stale', async () => {
  let clock = 0;
  let eastDown = false;
  const store = createNwpsStore({
    regions: twoRegions,
    log: quiet,
    now: () => clock,
    fetchImpl: async (url) => {
      const west = boxOf(url)[0] === -110;
      if (!west && eastDown) return new Response('gateway', { status: 504 });
      return jsonResponse({
        gauges: [
          west
            ? rawGauge('AAAA1', 35, -105)
            : rawGauge('BBBB1', 35, -95, {
                floodCategory: eastDown ? 'major' : 'minor',
              }),
        ],
      });
    },
  });
  await store.current();
  eastDown = true;
  clock += NWPS_REFRESH_MS;
  const rebuilt = await store.refresh();
  assert.equal(rebuilt.snapshot.stale, true);
  assert.deepEqual(rebuilt.snapshot.regions.failed, ['east']);
  const east = rebuilt.snapshot.gauges.find((g) => g.lid === 'BBBB1');
  assert.equal(east.observed.category, 'minor', 'previous east gauges kept');
});

test('with no snapshot and NWPS down the route answers 503 with Retry-After', async () => {
  let requests = 0;
  const plugin = nwpsProxy({
    regions: twoRegions,
    log: quiet,
    fetchImpl: async () => {
      requests++;
      throw new TypeError('fetch failed');
    },
  });
  const first = await call(plugin, '/gauges');
  assert.equal(first.status, 503);
  assert.equal(first.headers['Retry-After'], '120');
  assert.deepEqual(JSON.parse(first.body), { error: 'nwps_unavailable' });
  // The failure cools down: a second request does not hit NWPS again.
  const second = await call(plugin, '/gauges');
  assert.equal(second.status, 503);
  assert.equal(requests, 2, 'two regions, one attempt');
  assert.ok(NWPS_RETRY_AFTER_FAILURE_MS >= 60_000);
});

test('the snapshot route serves gzip when asked and plain JSON otherwise', async () => {
  const plugin = nwpsProxy({
    regions: twoRegions.slice(0, 1),
    log: quiet,
    fetchImpl: async () =>
      jsonResponse({ gauges: [rawGauge('AAAA1', 35, -105)] }),
  });
  const zipped = await call(plugin, '/gauges', {
    'accept-encoding': 'gzip, br',
  });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['Content-Encoding'], 'gzip');
  assert.equal(JSON.parse(gunzipSync(zipped.body)).gauges[0].lid, 'AAAA1');
  const plain = await call(plugin, '/gauges?ignored=1');
  assert.equal(plain.headers['Content-Encoding'], undefined);
  assert.equal(JSON.parse(plain.body).gauges.length, 1);
  assert.equal((await call(plugin, '/gauges', {}, 'POST')).status, 405);
  assert.equal((await call(plugin, '/other')).status, 404);
});

test('the detail route validates the id before any upstream call', async () => {
  const urls = [];
  const plugin = nwpsProxy({
    regions: [],
    log: quiet,
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse({
        ...rawGauge('AAIT2', 30, -97),
        usgsId: '08158930',
      });
    },
  });
  for (const bad of [
    '/gauge/',
    '/gauge/AAIT',
    '/gauge/AAIT22',
    '/gauge/..%2F..%2Fadmin',
    '/gauge/AAIT2%3Fx%3D1',
    '/gauge/https:%2F%2Fevil.example',
    '/gauge/AAIT2/stageflow',
  ]) {
    const response = await call(plugin, bad);
    assert.ok([400, 404].includes(response.status), bad);
  }
  assert.equal(urls.length, 0);
  const ok = await call(plugin, '/gauge/aait2');
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).usgsId, '08158930');
  assert.deepEqual(urls, ['https://api.water.noaa.gov/nwps/v1/gauges/AAIT2']);
  // Cached: a second read makes no request.
  await call(plugin, '/gauge/AAIT2');
  assert.equal(urls.length, 1);
  assert.ok(NWPS_LID.test('AAIT2') && !NWPS_LID.test('aait2'));
});

test('a failed detail read serves the cached answer as stale, else 502', async () => {
  let clock = 0;
  let down = false;
  const store = createNwpsStore({
    regions: [],
    log: quiet,
    now: () => clock,
    fetchImpl: async () =>
      down
        ? new Response('no', { status: 500 })
        : jsonResponse(rawGauge('AAIT2', 30, -97)),
  });
  const plugin = nwpsProxy({ store });
  assert.equal((await call(plugin, '/gauge/AAIT2')).status, 200);
  down = true;
  clock += 60 * 60_000;
  const stale = await call(plugin, '/gauge/AAIT2');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal((await call(plugin, '/gauge/BBBB1')).status, 502);
});

/** Drive the plugin's middleware with a minimal req/res pair. */
async function call(plugin, url, headers = {}, method = 'GET') {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_prefix, fn) => (handler = fn) },
  });
  const res = {
    destroyed: false,
    status: 0,
    headers: {},
    body: '',
    writeHead(status, h) {
      this.status = status;
      this.headers = h;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
  await handler(
    { method, url, headers, socket: { remoteAddress: '127.0.0.1' } },
    res,
  );
  return res;
}
