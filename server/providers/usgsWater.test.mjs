import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  USGS_WATER_API,
  USGS_WATER_CLASSES,
  USGS_WATER_REFRESH_MS,
  buildUsgsWaterFiles,
  createUsgsWaterStore,
  mergeUsgsReadings,
  usgsTileBounds,
  usgsTileKey,
  usgsWaterProxy,
} from './usgsWater.js';

const item = (id, code, value, time, [lon, lat] = [-97.7, 30.3]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    monitoring_location_id: id,
    parameter_code: code,
    value: String(value),
    unit_of_measure: code === '00060' ? 'ft^3/s' : 'ft',
    time,
  },
});

test('readings merge into one feature per gauge, card order first', () => {
  const [f] = mergeUsgsReadings(
    [
      item('USGS-08158000', '00060', 63.2, '2026-10-21T20:00:00+00:00'),
      item('USGS-08158000', '00065', 3.97, '2026-10-21T21:00:00+00:00'),
      item('USGS-08158000', '00065', 3.5, '2026-10-21T19:00:00+00:00'),
    ],
    'ST',
    new Map([['USGS-08158000', { name: 'Colorado Rv at Austin, TX' }]]),
  );
  assert.equal(f.properties.name, 'Colorado Rv at Austin, TX');
  assert.equal(f.properties.site_type, 'Stream');
  assert.deepEqual(
    f.properties.readings.map((r) => [r.parameter_code, r.value]),
    [
      ['00065', 3.97],
      ['00060', 63.2],
    ],
    'gage height first, newest value per parameter',
  );
  assert.equal(f.properties.value, 3.97);
  assert.equal(f.properties.observed_time, '2026-10-21T21:00:00+00:00');
});

test('bad ids, coordinates, values and unknown parameters are dropped', () => {
  const out = mergeUsgsReadings(
    [
      item('not an id', '00065', 1, 't'),
      item('USGS-1', '00065', 'n/a', 't'),
      item('USGS-2', '99999', 1, 't'),
      item('USGS-3', '00065', 1, 't', [500, 10]),
      item('USGS-4', '00065', 0, '2026-10-21T00:00:00Z'),
    ],
    'LK',
  );
  assert.deepEqual(
    out.map((f) => [
      f.properties.usgs_site_id,
      f.properties.name,
      f.properties.value,
    ]),
    [['USGS-4', 'USGS-4', 0]],
    'zero is a reading; a gauge without a name is labelled with its id',
  );
});

test('tiles are 4-degree cells keyed from the south-west corner', () => {
  assert.equal(usgsTileKey(-97.7, 30.3), '20_30');
  assert.deepEqual(usgsTileBounds('20_30'), [-100, 30, -96, 34]);
  assert.equal(usgsTileBounds('../x'), null);
});

test('files: manifest, one file per class, stream tiles', () => {
  const stream = mergeUsgsReadings(
    [
      item('USGS-1', '00065', 1, 't', [-97.7, 30.3]),
      item('USGS-2', '00065', 2, 't', [-80, 40]),
    ],
    'ST',
  );
  const { manifest, files } = buildUsgsWaterFiles(
    { stream, lake: [], spring: [] },
    { generatedAt: '2026-10-21T21:00:00.000Z' },
  );
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.refresh_minutes, 60);
  assert.equal(manifest.classes.stream.count, 2);
  assert.deepEqual(Object.keys(manifest.classes.stream.tiles).sort(), [
    '20_30',
    '25_32',
  ]);
  assert.equal(
    manifest.classes.stream.tiles['20_30'].file,
    'stream/20_30.geojsonl',
  );
  assert.equal(files.get('stream/20_30.geojsonl').trim().split('\n').length, 1);
  assert.equal(files.get('lake.geojsonl'), '');
  assert.deepEqual(JSON.parse(files.get('manifest.json')), manifest);
});

/** A fake USGS API: answers latest-continuous per site type and names by id. */
function fakeUsgs({ fail = false, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const u = new URL(url);
    if (fail) return new Response('{"description":"down"}', { status: 503 });
    if (u.pathname.endsWith('/monitoring-locations/items')) {
      const ids = u.searchParams.get('id').split(',');
      return Response.json({
        features: ids.map((id) => ({
          id,
          properties: { monitoring_location_name: `Name ${id}` },
        })),
      });
    }
    const site = u.searchParams.get('site_type_code');
    const code = u.searchParams.get('parameter_code');
    assert.match(
      u.searchParams.get('datetime'),
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\/\.\.$/,
    );
    return Response.json({
      features:
        code ===
        USGS_WATER_CLASSES[
          site === 'ST' ? 'stream' : site === 'LK' ? 'lake' : 'spring'
        ].params[0]
          ? [item(`USGS-${site}1`, code, 1.5, '2026-10-21T21:00:00Z')]
          : [],
      links: [],
    });
  };
}

function tmpCache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-usgs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'names.json');
}

const quiet = { warn() {} };

test('a refresh asks one site type per request, names gauges and caches names', async (t) => {
  const calls = [];
  const cacheFile = tmpCache(t);
  const store = createUsgsWaterStore({
    fetchImpl: fakeUsgs({ calls }),
    cacheFile,
    env: {},
    log: quiet,
  });
  const built = await store.refresh();
  const data = calls.filter((c) => c.url.includes('latest-continuous'));
  const params = Object.values(USGS_WATER_CLASSES).reduce(
    (n, c) => n + c.params.length,
    0,
  );
  assert.equal(data.length, params);
  for (const c of data) {
    assert.ok(
      c.url.startsWith(
        `${USGS_WATER_API}/collections/latest-continuous/items?`,
      ),
    );
    assert.equal(
      new URL(c.url).searchParams.getAll('site_type_code').length,
      1,
    );
  }
  assert.equal(built.manifest.classes.stream.count, 1);
  assert.match(built.files.get('stream.geojsonl'), /"name":"Name USGS-ST1"/);
  assert.ok(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).names['USGS-LK1']);

  // A second store reads names from the cache instead of asking again.
  const calls2 = [];
  const again = createUsgsWaterStore({
    fetchImpl: fakeUsgs({ calls: calls2 }),
    cacheFile,
    env: {},
    log: quiet,
  });
  await again.refresh();
  assert.equal(
    calls2.filter((c) => c.url.includes('monitoring-locations')).length,
    0,
  );
});

test('the API key goes only in the X-Api-Key header, never in a URL', async (t) => {
  const calls = [];
  const store = createUsgsWaterStore({
    fetchImpl: fakeUsgs({ calls }),
    cacheFile: tmpCache(t),
    env: { USGS_WATER_API_KEY: 'test-key-123456' },
    log: quiet,
  });
  const built = await store.refresh();
  assert.ok(calls.every((c) => c.headers['X-Api-Key'] === 'test-key-123456'));
  assert.ok(calls.every((c) => !c.url.includes('test-key-123456')));
  for (const body of built.files.values())
    assert.ok(!body.includes('test-key-123456'));
});

test('the keyless hourly budget stays under the USGS 50/hour limit', async (t) => {
  let now = 0;
  const calls = [];
  const store = createUsgsWaterStore({
    fetchImpl: fakeUsgs({ calls }),
    cacheFile: tmpCache(t),
    env: {},
    now: () => now,
    log: quiet,
  });
  for (let i = 0; i < 10; i++) await store.refresh().catch(() => {});
  assert.ok(calls.length <= 40, `${calls.length} requests in one hour`);
  now += 61 * 60_000;
  assert.ok(store.budgetLeft() > 30, 'the window rolls');
});

test('the route serves the files, refreshes hourly and keeps serving through a failure', async (t) => {
  let now = 1_000_000;
  let fail = false;
  const calls = [];
  const fetchImpl = (url, init) => fakeUsgs({ fail, calls })(url, init);
  const plugin = usgsWaterProxy({
    store: createUsgsWaterStore({
      fetchImpl,
      cacheFile: tmpCache(t),
      env: {},
      now: () => now,
      log: quiet,
    }),
  });
  let handler;
  plugin.configureServer({ middlewares: { use: (p, h) => (handler = h) } });
  const get = (url) =>
    new Promise((resolve) => {
      const res = {
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body });
        },
      };
      handler({ method: 'GET', url }, res);
    });

  const manifest = await get('/manifest.json');
  assert.equal(manifest.status, 200);
  assert.equal(JSON.parse(manifest.body).classes.lake.count, 1);
  assert.equal((await get('/stream/20_30.geojsonl')).status, 200);
  assert.equal(
    (await get('/stream/99_99.geojsonl')).body,
    '',
    'an empty tile is empty, not an error',
  );
  assert.equal((await get('/../package.json')).status, 404);
  assert.equal((await get('/well.geojsonl')).status, 404);

  const before = calls.length;
  await get('/manifest.json');
  assert.equal(calls.length, before, 'no refetch within the hour');

  now += USGS_WATER_REFRESH_MS;
  fail = true;
  const stale = await get('/manifest.json');
  assert.equal(stale.status, 200, 'old files are served while USGS is down');
  await new Promise((r) => setImmediate(r));
});

test('with no data yet and USGS down the route answers 503', async (t) => {
  const plugin = usgsWaterProxy({
    store: createUsgsWaterStore({
      fetchImpl: fakeUsgs({ fail: true }),
      cacheFile: tmpCache(t),
      env: {},
      log: quiet,
    }),
  });
  let handler;
  plugin.configureServer({ middlewares: { use: (p, h) => (handler = h) } });
  const res = await new Promise((resolve) =>
    handler(
      { method: 'GET', url: '/manifest.json' },
      {
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end() {
          resolve(this);
        },
      },
    ),
  );
  assert.equal(res.status, 503);
  assert.equal(res.headers['Retry-After'], '300');
});
