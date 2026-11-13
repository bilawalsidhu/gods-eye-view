import test from 'node:test';
import assert from 'node:assert/strict';
import {
  libraryAvailability,
  libraryProxy,
  parseLibraryTilePath,
} from './library.js';
import { validateLibraryCatalog } from '../../src/library/manifest.js';
import { libraryEntry } from '../../src/library/catalog.js';

const base = {
  family: 'events',
  provider: 'Fixture',
  description: 'Fixture entry.',
  maintainer: 'test',
  coverage: { global: true },
  licence: { name: 'Public domain', url: 'https://example.org/licence' },
  attribution: { text: 'Fixture' },
  status: 'community',
};
const { entries, errors } = validateLibraryCatalog([
  {
    ...base,
    id: 'proxied-points',
    kind: 'dataset',
    title: 'Proxied points',
    source: {
      format: 'geojson',
      url: 'https://data.example.org/points.json',
      fetch: 'proxied',
      maxBytes: 4096,
    },
    display: { label: 'title' },
  },
  {
    ...base,
    id: 'direct-points',
    kind: 'dataset',
    title: 'Direct points',
    source: {
      format: 'geojson',
      url: 'https://data.example.org/direct.json',
      fetch: 'browser-direct',
    },
  },
  {
    ...base,
    id: 'keyed-points',
    kind: 'dataset',
    title: 'Keyed points',
    source: {
      format: 'geojson',
      url: 'https://keyed.example.org/points.json',
      fetch: 'proxied',
      key: { id: 'firms', in: 'query', name: 'MAP_KEY' },
    },
  },
  {
    ...base,
    id: 'opt-in-points',
    kind: 'dataset',
    title: 'Opt-in points',
    source: {
      format: 'geojson',
      url: 'https://data.example.org/opt.json',
      fetch: 'proxied',
    },
    licence: { ...base.licence, operatorOptIn: true },
  },
  {
    ...base,
    id: 'proxied-tiles',
    kind: 'tiles',
    title: 'Proxied tiles',
    source: {
      format: 'xyz',
      url: 'https://tiles.example.org/{z}/{x}/{y}.png',
      fetch: 'proxied',
      minZoom: 2,
      maxZoom: 5,
    },
  },
  {
    ...base,
    id: 'fixture-pack',
    kind: 'pack',
    family: 'cameras',
    title: 'Fixture cameras',
    source: { format: 'host', url: 'https://cams.example.org/' },
    pack: { host: 'cctv', env: 'CCTV_FIXTURE_ENABLED' },
    licence: { ...base.licence, operatorOptIn: true },
  },
]);
assert.deepEqual(errors, []);

const collection = (features) =>
  JSON.stringify({ type: 'FeatureCollection', features });
const point = (title) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [1, 2] },
  properties: { title },
});

function install({ env = {}, fetchImpl, now, catalog = entries } = {}) {
  const plugin = libraryProxy({ entries: catalog, env, fetchImpl, now });
  let handler;
  plugin.configurePreviewServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/library');
        handler = callback;
      },
    },
  });
  return async (url, headers = {}) => {
    const res = {
      headers: {},
      writeHead(status, values) {
        this.status = status;
        this.headers = values;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.raw = body;
        try {
          this.body = JSON.parse(body);
        } catch {
          this.body = null;
        }
      },
      set statusCode(value) {
        this.status = value;
      },
    };
    await handler(
      { url, method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
    return res;
  };
}

test('availability is decided by the operator environment and names no secret', () => {
  const none = libraryAvailability(entries, {});
  assert.deepEqual(none.get('proxied-points'), {
    available: true,
    reason: null,
  });
  assert.equal(none.get('keyed-points').reason, 'key-missing');
  assert.equal(none.get('opt-in-points').reason, 'operator-opt-in');
  assert.equal(none.get('fixture-pack').reason, 'operator-opt-in');
  const configured = libraryAvailability(entries, {
    FIRMS_MAP_KEY: 'secret',
    GEV_LIBRARY_ENABLE: 'opt-in-points',
    GEV_LIBRARY_DISABLE: 'proxied-points',
    CCTV_FIXTURE_ENABLED: '1',
  });
  assert.equal(configured.get('keyed-points').available, true);
  assert.equal(configured.get('opt-in-points').available, true);
  assert.equal(configured.get('proxied-points').reason, 'operator-disabled');
  assert.equal(configured.get('fixture-pack').available, true);
  assert.doesNotMatch(JSON.stringify([...configured]), /secret/);
});

test('the catalog route lists every entry with its availability', async () => {
  const request = install();
  const res = await request('/catalog');
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, entries.length);
  assert.deepEqual(
    res.body.entries.find(({ id }) => id === 'opt-in-points'),
    { id: 'opt-in-points', available: false, reason: 'operator-opt-in' },
  );
});

test('a proxied dataset reaches only its manifest URL, refuses redirects and is normalized', async () => {
  const calls = [];
  const request = install({
    now: () => 42,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(collection([point('Storm'), { geometry: null }]));
    },
  });
  const res = await request('/data/proxied-points?url=https://evil.example');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://data.example.org/points.json');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(res.body.features.length, 1);
  assert.equal(res.body.features[0].properties.name, 'Storm');
  assert.equal(res.body.dropped, 1);
  assert.equal(res.body.fetchedAt, 42);
  // A fresh cache answers without another upstream request.
  await request('/data/proxied-points');
  assert.equal(calls.length, 1);
});

test('browser-direct, unknown, opt-in and wrong-kind entries are not proxied', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      return new Response(collection([]));
    },
  });
  assert.equal((await request('/data/direct-points')).status, 404);
  assert.equal((await request('/data/nope-nope')).status, 404);
  assert.equal((await request('/data/proxied-tiles')).status, 404);
  assert.equal((await request('/tile/proxied-points/2/0/0')).status, 404);
  const optIn = await request('/data/opt-in-points');
  assert.equal(optIn.status, 403);
  assert.equal(optIn.body.error, 'operator-opt-in');
  assert.equal(calls, 0);
});

test('a keyed entry gets the operator key server-side and refuses forwarded requests', async () => {
  const calls = [];
  const request = install({
    env: { FIRMS_MAP_KEY: 'k3y' },
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return new Response(collection([point('Fire')]));
    },
  });
  const forwarded = await request('/data/keyed-points', {
    'x-forwarded-for': '203.0.113.9',
  });
  assert.equal(forwarded.status, 403);
  assert.equal(calls.length, 0);
  const res = await request('/data/keyed-points');
  assert.equal(res.status, 200);
  assert.equal(calls[0].searchParams.get('MAP_KEY'), 'k3y');
  assert.doesNotMatch(res.raw, /k3y/);
});

test('an oversized or failing upstream answers 502 without its text, then serves stale', async () => {
  let clock = 0;
  let mode = 'ok';
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      if (mode === 'big') return new Response('x'.repeat(8192));
      if (mode === 'fail')
        return new Response('secret upstream text', { status: 500 });
      return new Response(collection([point('A')]));
    },
  });
  mode = 'big';
  const big = await request('/data/proxied-points');
  assert.equal(big.status, 502);
  assert.doesNotMatch(big.raw, /x{20}/);
  mode = 'ok';
  assert.equal((await request('/data/proxied-points')).status, 200);
  clock = 10 * 3600 * 1000;
  mode = 'fail';
  const stale = await request('/data/proxied-points');
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.doesNotMatch(stale.raw, /secret upstream text/);
});

test('cross-site browser requests are refused before any upstream request', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      return new Response(collection([]));
    },
  });
  const res = await request('/data/proxied-points', {
    host: 'localhost:5173',
    origin: 'https://evil.example',
    'sec-fetch-site': 'cross-site',
  });
  assert.equal(res.status, 403);
  assert.equal(calls, 0);
});

test('tiles: bounded z/x/y, image types only, cached', async () => {
  const calls = [];
  const request = install({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/3/'))
        return new Response('<html>', {
          headers: { 'content-type': 'text/html' },
        });
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      });
    },
  });
  assert.equal((await request('/tile/proxied-tiles/1/0/0')).status, 400);
  assert.equal((await request('/tile/proxied-tiles/2/4/0')).status, 400);
  assert.equal((await request('/tile/proxied-tiles/2/a/0')).status, 400);
  const ok = await request('/tile/proxied-tiles/2/1/3');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['Content-Type'], 'image/png');
  assert.equal(calls[0], 'https://tiles.example.org/2/1/3.png');
  await request('/tile/proxied-tiles/2/1/3');
  assert.equal(calls.length, 1);
  assert.equal((await request('/tile/proxied-tiles/3/1/1')).status, 502);
});

test('tile paths are parsed against the zoom range', () => {
  const source = { minZoom: 0, maxZoom: 3 };
  assert.deepEqual(parseLibraryTilePath(['3', '7', '7'], source), {
    z: 3,
    x: 7,
    y: 7,
  });
  assert.equal(parseLibraryTilePath(['3', '8', '0'], source), null);
  assert.equal(parseLibraryTilePath(['4', '0', '0'], source), null);
  assert.equal(parseLibraryTilePath(['1', '0'], source), null);
});

test('only GET is served', async () => {
  const plugin = libraryProxy({ entries, env: {} });
  const res = {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {},
  };
  await plugin.handler({ url: '/catalog', method: 'POST', headers: {} }, res);
  assert.equal(res.status, 405);
});

test('a partition index is cached only when complete; a complete one outlives failed rebuilds', async () => {
  const epc = libraryEntry('epc-england-wales');
  let clock = 0;
  let footers = 'ok';
  let listings = 0;
  const listing = `<ListBucketResult><Contents><Key>a.parquet</Key><Size>100</Size></Contents></ListBucketResult>`;
  const fetchImpl = async (url) => {
    if (url.includes('list-type')) {
      listings += 1;
      return new Response(listing);
    }
    return footers === 'ok'
      ? new Response(new Uint8Array(100))
      : new Response('', { status: 503 });
  };
  const request = install({ catalog: [epc], now: () => clock, fetchImpl });
  const first = await request('/index/epc-england-wales');
  assert.equal(first.status, 200);
  assert.equal(first.body.complete, true);
  const builtAt = first.body.builtAt;

  // Past cacheSeconds the rebuild fails: the complete index is still served,
  // and no rebuild runs again until the partial pause has passed.
  clock += (epc.source.cacheSeconds + 1) * 1000;
  footers = 'fail';
  const kept = await request('/index/epc-england-wales');
  assert.equal(kept.body.complete, true);
  assert.equal(kept.body.builtAt, builtAt);
  const listed = listings;
  await request('/index/epc-england-wales');
  assert.equal(listings, listed);

  // A server that never had a complete index serves the partial one as such,
  // and rebuilds after the pause.
  const fresh = install({ catalog: [epc], now: () => clock, fetchImpl });
  const partial = await fresh('/index/epc-england-wales');
  assert.equal(partial.status, 200);
  assert.equal(partial.body.complete, false);
  const before = listings;
  await fresh('/index/epc-england-wales');
  assert.equal(listings, before);
  clock += 6 * 60_000;
  footers = 'ok';
  const rebuilt = await fresh('/index/epc-england-wales');
  assert.equal(rebuilt.body.complete, true);
  assert.equal(listings, before + 1);
});
