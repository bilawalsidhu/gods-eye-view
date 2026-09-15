import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fireHistoryProxy } from '../../server/providers/fire-history.js';
import { localProviderPlugins } from '../../server/providers/local.js';

const EVENTS = {
  events: [
    {
      id: 'test-fire-2018',
      name: 'Test Fire',
      region: 'Nowhere',
      startDate: '2018-11-08',
      endDate: '2018-11-12',
      bbox: [-121.75, 39.65, -121.3, 39.95],
      sources: ['VIIRS_SNPP_SP', 'MODIS_SP'],
      perimeter: {
        service: 'wfigs',
        incident: "O'Test",
        state: 'US-CA',
        discoveredAfter: '2018-11-01',
      },
      references: [{ label: 'Doc', url: 'https://example.org/doc' }],
    },
    {
      id: 'bare-2020',
      name: 'Bare',
      startDate: '2020-01-01',
      endDate: '2020-01-02',
      bbox: [0, 0, 1, 1],
      sources: ['MODIS_SP'],
    },
    { id: 'BROKEN', name: 'x' },
  ],
};
const CSV =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n' +
  '39.80,-121.50,330,0.4,0.4,2018-11-08,2012,N,VIIRS,n,2,290,12.5,N\n' +
  '39.81,-121.51,331,0.4,0.4,2018-11-13,2012,N,VIIRS,n,2,290,3.0,N\n' + // past endDate → filtered
  '41.00,-121.51,331,0.4,0.4,2018-11-09,2012,N,VIIRS,n,2,290,3.0,N\n'; // outside bbox → filtered
const PERIMETER = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      properties: { poly_GISAcres: 10, poly_DateCurrent: 1541900000000 },
    },
    {
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [2, 2],
            [3, 2],
            [3, 3],
            [2, 2],
          ],
        ],
      },
      properties: { poly_GISAcres: 247.105, poly_DateCurrent: 1541990000000 },
    },
  ],
};

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1);
  assert.ok(routes.has('/api/fire-history'));
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await [...routes.values()][0]({ url, method }, res);
    return res;
  };
}
const json = (res) => JSON.parse(res.body);

async function fixture(t, { key = '', fetchImpl } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-fire-history-'));
  const eventsPath = path.join(dir, 'events.json');
  await fsp.writeFile(eventsPath, JSON.stringify(EVENTS));
  const previous = process.env.FIRMS_MAP_KEY;
  process.env.FIRMS_MAP_KEY = key;
  t.mock.method(console, 'warn', () => {});
  t.after(async () => {
    if (previous === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const calls = [];
  const proxy = fireHistoryProxy({
    eventsPath,
    cacheDir: path.join(dir, 'cache'),
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      return fetchImpl(new URL(String(url)), init);
    },
  });
  return { request: install(proxy), calls, dir };
}

test('the standalone provider list mounts the fire-history proxy exactly once', () => {
  const plugins = localProviderPlugins();
  assert.equal(
    plugins.filter((p) => p.name === 'fire-history-proxy').length,
    1,
  );
});

test('keyless: the registry is public, detections answer no_key, upstream is never contacted', async (t) => {
  const { request, calls } = await fixture(t, {
    fetchImpl: () => {
      throw new Error('must not fetch');
    },
  });
  const list = json(await request('/'));
  assert.equal(list.hasKey, false);
  assert.deepEqual(
    list.events.map((e) => e.id),
    ['test-fire-2018', 'bare-2020'],
    'the malformed entry is dropped, not fatal',
  );
  assert.equal(list.events[0].startMs, undefined, 'public shape only');
  assert.equal(list.events[0].perimeter.service, 'wfigs');
  assert.equal((await request('/test-fire-2018')).status, 503);
  assert.equal(json(await request('/test-fire-2018')).error, 'no_key');
  assert.equal((await request('/nope')).status, 404);
  assert.equal((await request('/test-fire-2018/extra')).status, 404);
  assert.equal((await request('/', 'POST')).status, 405);
  assert.equal(calls.length, 0);
});

test('keyed: registered windows only, sequential per source, filtered, cached, failed windows retried alone', async (t) => {
  let modisDown = true;
  const { request, calls } = await fixture(t, {
    key: 'fixture-key',
    fetchImpl: (url) => {
      assert.equal(url.host, 'firms.modaps.eosdis.nasa.gov');
      assert.match(
        url.pathname,
        /\/api\/area\/csv\/fixture-key\/(VIIRS_SNPP_SP|MODIS_SP)\/-121\.7500,39\.6500,-121\.3000,39\.9500\/5\/2018-11-08$/,
      );
      if (url.pathname.includes('MODIS') && modisDown)
        return new Response('offline', { status: 503 });
      return new Response(CSV);
    },
  });
  const partial = json(await request('/test-fire-2018'));
  assert.equal(partial.complete, false);
  assert.equal(partial.count, 1, 'out-of-box and past-window rows are dropped');
  assert.deepEqual(
    partial.windows.map((w) => [w.source, w.ok]),
    [
      ['VIIRS_SNPP_SP', true],
      ['MODIS_SP', false],
    ],
  );
  assert.equal(calls.length, 2);
  modisDown = false;
  const complete = json(await request('/test-fire-2018'));
  assert.equal(complete.complete, true);
  assert.equal(complete.count, 2);
  assert.equal(calls.length, 3, 'only the failed MODIS window was refetched');
  assert.equal(json(await request('/test-fire-2018')).count, 2);
  assert.equal(
    calls.length,
    3,
    'a complete event never touches upstream again',
  );
  assert.equal(json(await request('/')).hasKey, true);
});

test('an oversized upstream body fails that window instead of the route', async (t) => {
  const { request } = await fixture(t, {
    key: 'fixture-key',
    fetchImpl: () =>
      new Response(CSV, {
        headers: { 'content-length': String(64 * 1024 * 1024) },
      }),
  });
  const res = await request('/test-fire-2018');
  assert.equal(res.status, 502, 'every window failed → no cache to serve');
});

test('perimeter: whitelisted host, escaped filters, largest polygon, permanent cache, 404 when unregistered', async (t) => {
  const { request, calls } = await fixture(t, {
    fetchImpl: (url) => {
      assert.equal(url.host, 'services3.arcgis.com');
      assert.match(
        url.pathname,
        /WFIGS_Interagency_Perimeters\/FeatureServer\/0\/query$/,
      );
      assert.equal(
        url.searchParams.get('where'),
        "attr_IncidentName='O''Test' AND attr_POOState='US-CA' AND attr_FireDiscoveryDateTime > timestamp '2018-11-01'",
      );
      assert.equal(url.searchParams.get('f'), 'geojson');
      return new Response(JSON.stringify(PERIMETER));
    },
  });
  const perimeter = json(await request('/test-fire-2018/perimeter'));
  assert.equal(perimeter.acres, 247.105);
  assert.equal(perimeter.hectares, 100);
  assert.equal(perimeter.dateCurrentMs, 1541990000000);
  assert.equal(
    perimeter.geometry.coordinates[0][0][0],
    2,
    'largest polygon wins',
  );
  assert.equal(perimeter.label, 'WFIGS Interagency Perimeters');
  assert.equal(calls.length, 1, 'perimeters need no FIRMS key');
  json(await request('/test-fire-2018/perimeter'));
  assert.equal(calls.length, 1, 'served from cache');
  const bare = await request('/bare-2020/perimeter');
  assert.equal(bare.status, 404);
  assert.equal(json(bare).error, 'no_perimeter');
});
