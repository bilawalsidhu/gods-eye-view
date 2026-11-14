import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  alprDetailZoom,
  createAlprPrecisionCache,
  createAlprTileSource,
  createOverpassAlprSource,
  createCombinedAlprSource,
  createDeflockAlprSource,
  DEFLOCK_TILE_ORIGIN,
  buildOverpassQuery,
} from './source.js';
import { normalizeAlprTileFeature } from './tileRecords.js';
import { SOURCE_RECORD_LIMIT } from './policy.js';
import { validateAlprSnapshot, alprCreditMarkup } from './model.js';
const box = { south: 30, west: -98, north: 30.1, east: -97.9 };
test('the source rejects invalid and unbounded queries before fetching', async () => {
  let calls = 0;
  const source = createAlprTileSource({
    tileFetchImpl() {
      calls++;
    },
  });
  for (const bad of [
    null,
    { ...box, west: '0);out;' },
    { ...box, north: 90 },
    { ...box, east: -99 },
    { ...box, south: NaN },
  ]) {
    await assert.rejects(source.fetch(bad), /bounded city viewport/);
  }
  assert.equal(calls, 0);
});
const fixture = readFileSync(
  new URL(
    '../../data/fixtures/osm-alpr-austin-11-467-843.pbf',
    import.meta.url,
  ),
);
const metadata = (country) => ({
  tiles: [
    `https://tiles.dontgetflocked.com/cameras-${country}-hourly/{z}/{x}/{y}.mvt`,
  ],
  bounds: country === 'ca' ? [-124, 42, -63, 54] : [-160, 17, -64, 59],
});
const austin = { south: 30.2, north: 30.35, west: -97.85, east: -97.65 };

const camera = (id, extra = {}) => ({
  id: `alpr:${id}`,
  latitude: 30.27,
  longitude: -97.75,
  ...extra,
});
const snapshot = (records, extra = {}) => ({
  records,
  stale: false,
  saturated: false,
  coverage: austin,
  zoom: 12,
  ...extra,
});

test('DeFlock and existing feeds merge unique OSM identities and prefer the newer edit', async () => {
  const source = createCombinedAlprSource({
    sources: [
      {
        fetch: async () =>
          snapshot([
            camera(1, {
              operator: 'Primary',
              osmTimestamp: '2026-11-01T00:00:00Z',
            }),
            camera(2),
            camera(3, { operator: 'Primary' }),
          ]),
      },
      {
        fetch: async () =>
          snapshot([
            camera(1, {
              operator: 'Updated',
              osmTimestamp: '2026-11-02T00:00:00Z',
            }),
            camera(3, { operator: 'Existing' }),
            camera(4),
            camera(1, { id: 'alpr:way:1', osmType: 'way' }),
          ]),
      },
    ],
  });
  const result = await source.fetch(austin);
  assert.deepEqual(
    result.records.map((r) => r.id),
    ['alpr:1', 'alpr:2', 'alpr:3', 'alpr:4', 'alpr:way:1'],
  );
  assert.equal(result.records[0].operator, 'Updated');
  assert.equal(result.records[2].operator, 'Primary');
  assert.equal(result.partialSources, false);
  assert.equal(result.saturated, false);
  assert.deepEqual(result.coverage, austin);
});

test('a failed feed leaves available cameras visible and reports partial sources', async () => {
  for (const failedIndex of [0, 1]) {
    const sources = [0, 1].map((i) => ({
      fetch: async () => {
        if (i === failedIndex) throw new Error('Feed offline');
        return snapshot([camera(i + 1)]);
      },
    }));
    const result = await createCombinedAlprSource({ sources }).fetch(austin);
    assert.equal(result.records.length, 1);
    assert.equal(result.partialSources, true);
    assert.equal(
      result.stale,
      false,
      'fresh surviving data is not called stale',
    );
    assert.deepEqual(result.coverage, austin);
  }
});

test('malformed snapshots cannot poison a healthy feed and both failures never become empty coverage', async () => {
  const bad = { fetch: async () => snapshot([camera(1, { latitude: NaN })]) };
  const good = { fetch: async () => snapshot([camera(2)]) };
  const result = await createCombinedAlprSource({ sources: [bad, good] }).fetch(
    austin,
  );
  assert.equal(result.records[0].id, 'alpr:2');
  assert.equal(result.partialSources, true);
  await assert.rejects(
    createCombinedAlprSource({ sources: [bad, bad] }).fetch(austin),
    /invalid record/,
  );
  await assert.rejects(
    createCombinedAlprSource({
      sources: [bad, { fetch: async () => snapshot([], { noCoverage: true }) }],
    }).fetch(austin),
    /invalid record/,
  );
});

test('a combined request validates bounds before acquisition and does not swallow cancellation', async () => {
  let calls = 0;
  const abort = new AbortController();
  const source = createCombinedAlprSource({
    sources: [
      {
        fetch: async () => {
          calls++;
          abort.abort();
          return snapshot([camera(1)]);
        },
      },
    ],
  });
  await assert.rejects(
    source.fetch({ ...austin, north: 90 }),
    /bounded city viewport/,
  );
  assert.equal(calls, 0);
  await assert.rejects(source.fetch(austin, abort.signal), {
    name: 'AbortError',
  });
  assert.equal(calls, 1);
});

test('merged coverage is the intersection, with the coarser precision and conservative freshness', async () => {
  const result = await createCombinedAlprSource({
    sources: [
      {
        fetch: async () =>
          snapshot([camera(1)], {
            coverage: { ...austin, south: 30.1 },
            zoom: 11,
          }),
      },
      {
        fetch: async () =>
          snapshot([camera(2)], {
            coverage: { ...austin, east: -97.5 },
            stale: true,
          }),
      },
    ],
  }).fetch(austin);
  assert.deepEqual(result.coverage, austin);
  assert.equal(result.zoom, 11);
  assert.equal(result.stale, true);
});

test('combined records retain one global nearest-camera limit', async () => {
  const records = Array.from({ length: SOURCE_RECORD_LIMIT + 1 }, (_, i) =>
    camera(i, { latitude: 30.2 + i / 100000 }),
  );
  const result = await createCombinedAlprSource({
    sources: [
      { fetch: async () => snapshot(records.slice(0, 3000)) },
      { fetch: async () => snapshot(records.slice(3000)) },
    ],
  }).fetch(austin);
  assert.equal(result.records.length, SOURCE_RECORD_LIMIT);
  assert.equal(result.saturated, true);
  assert.deepEqual(result.coverage, austin);
  assert.equal(
    result.records.some((r) => r.id === 'alpr:0'),
    false,
    'the furthest camera is omitted',
  );
});

test('combined construction is lazy and destroys each provider once', () => {
  let destroyed = 0;
  const provider = {
    fetch: () => assert.fail('No acquisition during construction'),
    destroy: () => destroyed++,
  };
  const source = createCombinedAlprSource({ sources: [provider, provider] });
  assert.match(source.label, /DeFlock/);
  assert.match(source.attribution.text, /OpenStreetMap/);
  source.destroy();
  assert.equal(destroyed, 1);
});

test('node and way centroids from DeFlock keep distinct identities and metadata', () => {
  const point = (osmType) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-97.75, 30.27] },
    properties: {
      osmType,
      osmId: 42,
      brand: 'Flock Safety',
      operator: 'City',
      direction: 270,
      osmTimestamp: '2026-11-01T00:00:00Z',
    },
  });
  const node = normalizeAlprTileFeature(point('node'));
  const way = normalizeAlprTileFeature(point('way'));
  assert.equal(node.id, 'alpr:42');
  assert.equal(way.id, 'alpr:way:42');
  assert.equal(way.osmType, 'way');
  assert.equal(way.manufacturer, 'Flock Safety');
  assert.equal(way.operator, 'City');
  assert.equal(way.directionDeg, 270);
  assert.equal(way.lastVerified, null);
  assert.equal(normalizeAlprTileFeature(point('relation')), null);
  assert.equal(
    normalizeAlprTileFeature({
      ...point('way'),
      geometry: { type: 'Point', coordinates: null },
    }),
    null,
  );
});

test('DeFlock uses its published primary host and refreshes build-pinned URLs hourly', async () => {
  let now = 1,
    aliases = 0;
  const urls = [];
  const source = createDeflockAlprSource({
    now: () => now,
    tileFetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('.json')) {
        aliases++;
        return Response.json({
          ...metadata('us'),
          tiles: [`${DEFLOCK_TILE_ORIGIN}/build-${aliases}/{z}/{x}/{y}.mvt`],
        });
      }
      return new Response(fixture);
    },
  });
  await source.fetch(austin);
  await source.fetch(austin);
  assert.equal(aliases, 1);
  now += 60 * 60 * 1000;
  await source.fetch(austin);
  assert.equal(aliases, 2);
  assert.ok(urls.some((url) => url.includes('/build-2/')));
  assert.ok(urls.every((url) => new URL(url).origin === DEFLOCK_TILE_ORIGIN));
  source.destroy();
});

test('missing US tiles cannot suppress a healthy Canadian dataset', async () => {
  const calls = [];
  const source = createAlprTileSource({
    tileFetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('.json'))
        return Response.json({
          ...metadata(url.includes('-ca-') ? 'ca' : 'us'),
          bounds: [-125, 17, -60, 70],
        });
      return url.includes('-us-')
        ? new Response('', { status: 404 })
        : new Response(fixture);
    },
  });
  const result = await source.fetch({
    south: 43.6,
    north: 43.75,
    west: -79.5,
    east: -79.3,
  });
  assert.ok(result.records.length > 0);
  assert.equal(
    result.saturated,
    true,
    'failed country tiles remain explicit partial coverage',
  );
  assert.ok(calls.some((url) => url.includes('-ca-') && url.endsWith('.mvt')));
  source.destroy();
});

test('cancellation while reading TileJSON is preserved even if fetch ignores it', async () => {
  const abort = new AbortController();
  const source = createAlprTileSource({
    tileFetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      async text() {
        abort.abort();
        return JSON.stringify(metadata('us'));
      },
    }),
  });
  await assert.rejects(source.fetch(austin, abort.signal), {
    name: 'AbortError',
  });
});

test('extract detail tiles map OSM records and repeated pans reuse decoded tiles', async () => {
  const calls = [];
  const source = createAlprTileSource({
    tileFetchImpl: async (url) => {
      calls.push(url);
      return url.endsWith('.json')
        ? Response.json(metadata(url.includes('-ca-') ? 'ca' : 'us'))
        : new Response(fixture);
    },
  });
  const snapshot = await source.fetch(austin);
  assert.ok(snapshot.records.length > 0);
  const record = snapshot.records[0];
  assert.match(record.id, /^alpr:/);
  assert.equal(record.manufacturer, 'Flock Safety');
  assert.equal(record.lastVerified, null);
  assert.ok(record.osmTimestamp);
  assert.equal(snapshot.stale, false);
  assert.equal('elements' in snapshot, false);
  const fetched = calls.length;
  await source.fetch(austin);
  assert.equal(calls.length, fetched);
  assert.ok(calls.every((url) => !url.includes('overpass')));
  assert.doesNotMatch(JSON.stringify(source.attribution), /flock/i);
});

test('outside extract coverage is an explicit no-data state without Overpass', async () => {
  const source = createAlprTileSource({
    tileFetchImpl: () => assert.fail('no network expected in Europe'),
  });
  assert.deepEqual(
    await source.fetch({ south: 51, north: 51.1, west: 0, east: 0.1 }),
    { records: [], stale: false, saturated: false, noCoverage: true },
  );
});

test('an unsuccessful source response releases its body before reporting an error', async () => {
  let cancelled = 0;
  const source = createAlprTileSource({
    tileFetchImpl: async () => ({
      ok: false,
      status: 429,
      body: {
        async cancel() {
          cancelled++;
        },
      },
    }),
  });
  await assert.rejects(source.fetch(box), /unavailable/);
  assert.equal(cancelled, 1);
});

test('source snapshots reject malformed coordinates and duplicate identities', () => {
  const record = { id: 'camera:1', latitude: 30, longitude: -98 };
  for (const records of [
    [{ ...record, latitude: NaN }],
    [record, record],
    [{ ...record, id: '' }],
  ]) {
    assert.throws(
      () => validateAlprSnapshot({ records, stale: false, saturated: false }),
      /invalid record/,
    );
  }
  assert.throws(
    () => validateAlprSnapshot({ elements: [] }),
    /invalid snapshot/,
  );
});

test('provider attribution escapes markup and rejects executable links', () => {
  assert.equal(alprCreditMarkup(null), null);
  assert.throws(
    () => alprCreditMarkup({ text: 'test', href: 'javascript:alert(1)' }),
    /HTTPS/,
  );
  const html = alprCreditMarkup({
    text: '<img onerror=alert(1)>',
    href: 'https://example.org/?a=1&b=2',
  });
  assert.ok(html.includes('&lt;img onerror=alert(1)&gt;'));
  assert.ok(html.includes('?a=1&amp;b=2'));
  assert.ok(!html.includes('<img'));
});

test('wide detail view returns zoom guidance before any fetch and can retry a smaller view', async () => {
  let calls = 0;
  const source = createAlprTileSource({
    tileFetchImpl: async () => {
      calls++;
      return Response.json({
        tiles: ['https://tiles.dontgetflocked.com/{z}/{x}/{y}.pbf'],
        bounds: [-180, 17, -50, 84],
      });
    },
  });
  const wide = await source.fetch({
    south: 29,
    north: 32,
    west: -99,
    east: -96,
  });
  assert.equal(wide.zoomIn, true);
  assert.equal(calls, 0);
  await source
    .fetch({ south: 30.267, north: 30.268, west: -97.744, east: -97.743 })
    .catch(() => {});
  assert.ok(calls > 0);
});

test('each view reads the finest attributed extract zoom that fits 16 tiles', () => {
  // Field report: a z11-only read refused whole-city views. Attributed detail
  // exists from z9, so a city reads a few z9/z10 tiles and a street z12.
  assert.equal(
    alprDetailZoom({ south: 30.29, north: 30.31, west: -97.78, east: -97.75 }),
    12,
  );
  assert.equal(
    alprDetailZoom({ south: 30.17, north: 30.36, west: -97.85, east: -97.63 }),
    12,
  );
  assert.equal(
    alprDetailZoom({ south: 29.7, north: 30.7, west: -98.25, east: -97.25 }),
    10,
  );
  assert.equal(
    alprDetailZoom({ south: 29.2, north: 31.2, west: -98.75, east: -96.75 }),
    9,
  );
  assert.equal(
    alprDetailZoom({ south: 29, north: 32, west: -99, east: -96 }),
    null,
  );
});

test('a whole-city view loads cameras and reports the tiles it covers', async () => {
  const urls = [];
  const source = createAlprTileSource({
    tileFetchImpl: async (url) => {
      urls.push(url);
      return url.endsWith('.json')
        ? Response.json(metadata(url.includes('-ca-') ? 'ca' : 'us'))
        : new Response(fixture);
    },
  });
  const city = { south: 29.95, north: 30.55, west: -98.05, east: -97.45 };
  const snapshot = await source.fetch(city);
  assert.equal(snapshot.zoomIn, undefined);
  assert.equal(snapshot.zoom, 10);
  assert.ok(snapshot.records.length > 0);
  assert.ok(urls.some((url) => url.includes('/10/')));
  for (const key of ['south', 'west'])
    assert.ok(snapshot.coverage[key] <= city[key]);
  for (const key of ['north', 'east'])
    assert.ok(snapshot.coverage[key] >= city[key]);
});

test('coarser tiles never move a camera a finer tile already placed', () => {
  const cache = createAlprPrecisionCache(2);
  const fine = {
    id: 'alpr:1',
    latitude: 30.30001,
    longitude: -97.76001,
    operator: 'A',
  };
  assert.equal(cache.apply(fine, 12), fine);
  const coarse = {
    ...fine,
    latitude: 30.3001,
    longitude: -97.7602,
    operator: 'B',
  };
  const kept = cache.apply(coarse, 9);
  assert.equal(kept.latitude, fine.latitude);
  assert.equal(kept.longitude, fine.longitude);
  assert.equal(kept.operator, 'B', 'attributes still refresh');
  const finer = { ...fine, latitude: 30.300012 };
  assert.equal(cache.apply(finer, 13), finer);
  cache.apply({ id: 'alpr:2', latitude: 1, longitude: 1 }, 12);
  cache.apply({ id: 'alpr:3', latitude: 1, longitude: 1 }, 12);
  assert.equal(cache.size(), 2, 'bounded');
});

test('the explicit Overpass factory posts the unchanged query to its API transport', async () => {
  const calls = [];
  const source = createOverpassAlprSource({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        elements: [
          {
            type: 'node',
            id: 42,
            lat: 30.05,
            lon: -97.95,
            tags: { 'surveillance:type': 'ALPR', operator: 'Test' },
          },
        ],
      });
    },
  });
  const result = await source.fetch(box);
  assert.equal(result.records.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/overpass');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(
    new URLSearchParams(calls[0].options.body).get('data'),
    buildOverpassQuery(box.south, box.west, box.north, box.east),
  );
});

test('the tile adapter never passes public URLs through an injected API transport', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return url.endsWith('.json')
      ? Response.json(metadata('us'))
      : new Response(fixture);
  });
  const source = createAlprTileSource({
    fetchImpl: () => assert.fail('API transport must not receive tile URLs'),
  });
  const result = await source.fetch(austin);
  assert.ok(result.records.length);
  assert.ok(urls.length > 1);
  assert.ok(urls.every((url) => url.startsWith('https://tiles.')));
});
