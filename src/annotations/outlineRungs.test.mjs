// OVERPASS-FREE OUTLINE RUNGS.
//
// Streets and pointed-at buildings come from OpenFreeMap tiles before the
// existing ladder; cities, landmarks, grounds and named buildings fall to the
// server's guarded Nominatim outline after it. With default settings no
// request reaches any Overpass endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  createOutlineRungs,
  isNamedAsk,
  nominatimKindFor,
  outlineQueryText,
} from './outlineRungs.js';
import { createAnnotationResolver } from './resolver.js';
import { decodeOpenFreeMapOutlineTile } from '../sources/openFreeMapOutlines.js';
import { createNominatimOutlineClient } from '../sources/nominatimOutlines.js';
import { createApplicationRequestServices } from '../services/requests.js';
import { overpassProxy } from '../../server/providers/overpass.js';
import { geocodeProxy } from '../../server/providers/regional/place.js';
import {
  createGateStateStore,
  createNominatimGate,
} from '../../server/providers/regional/nominatimGate.js';
import { createVoiceAreas } from '../voice/areaActions.js';

const TILES = [6745, 6746].map((y) =>
  decodeOpenFreeMapOutlineTile(
    readFileSync(
      new URL(`../data/fixtures/ofm-outlines-austin-14-3743-${y}.pbf`, import.meta.url),
    ),
    14,
    3743,
    y,
  ),
);
const fixtureTiles = () => {
  const asked = [];
  return {
    asked,
    fetchBounds: async (box, options) => {
      asked.push({ box, zoom: options.zoom });
      return { tiles: TILES };
    },
  };
};
const CAPITOL = { lat: 30.27472, lon: -97.74035 };

const square = (lat, lon, halfDeg) => [
  [lon - halfDeg, lat - halfDeg],
  [lon + halfDeg, lat - halfDeg],
  [lon + halfDeg, lat + halfDeg],
  [lon - halfDeg, lat + halfDeg],
  [lon - halfDeg, lat - halfDeg],
];

function fakeNominatim(answer) {
  const asks = [];
  return {
    asks,
    lookup: async (ask) => {
      asks.push(ask);
      return typeof answer === 'function' ? answer(ask) : answer;
    },
  };
}

/** A ladder whose base answers `baseAnswer` and whose finish passes rings through. */
function ladder(baseAnswer) {
  const calls = { base: 0, finished: [] };
  return {
    calls,
    base: async () => {
      calls.base += 1;
      return baseAnswer;
    },
    finish: (fp, scope) => {
      calls.finished.push(scope);
      return { ring: fp.ring, polygons: fp.polygons, footprintKind: fp.kind, synthesized: false };
    },
  };
}

const UNAVAILABLE = { unavailable: true, retryable: false, code: 'OVERPASS_NOT_CONFIGURED' };
const ctx = (overrides) => ({
  scope: 'auto',
  target: 'X',
  matchName: 'X',
  fromName: true,
  pointLike: false,
  groundsLike: false,
  around: false,
  ...CAPITOL,
  view: { lat: CAPITOL.lat, lon: CAPITOL.lon },
  credit() {},
  ...overrides,
});

test('ask wording helpers', () => {
  assert.equal(isNamedAsk('this building'), false);
  assert.equal(isNamedAsk('here'), false);
  assert.equal(isNamedAsk('Texas Capitol'), true);
  assert.equal(outlineQueryText('the Texas Capitol grounds'), 'Texas Capitol');
  assert.equal(nominatimKindFor({ scope: 'city' }), 'city');
  assert.equal(nominatimKindFor({ scope: 'state' }), 'admin');
  assert.equal(nominatimKindFor({ scope: 'compound' }), 'landmark');
  assert.equal(nominatimKindFor({ scope: 'building', groundsLike: true }), 'landmark');
  assert.equal(nominatimKindFor({ scope: 'neighborhood' }), null);
  assert.equal(nominatimKindFor({ scope: 'street' }), null);
  assert.equal(nominatimKindFor({ scope: 'compound', pointLike: true }), null);
});

test('a street comes from tiles before the configured ladder, as merged ribbons', async () => {
  const tiles = fixtureTiles();
  const nominatim = fakeNominatim(null);
  const credits = [];
  const run = ladder(UNAVAILABLE);
  const result = await createOutlineRungs({ tiles, nominatim }).resolve(
    ctx({ scope: 'street', target: 'Congress Avenue', matchName: 'Congress Avenue', credit: (k) => credits.push(k) }),
    run,
  );
  assert.ok(result.ring.length > 6);
  assert.equal(result.polygons.length, 1);
  assert.equal(result.outlineSource, 'openfreemap');
  assert.equal(run.calls.base, 0, 'the ladder is not consulted');
  assert.deepEqual(run.calls.finished, ['street']);
  assert.deepEqual(credits, ['tiles']);
  assert.equal(tiles.asked[0].zoom, 14);
  assert.equal(nominatim.asks.length, 0, 'streets never reach Nominatim');
});

test('a street the tiles do not name falls through to the ladder', async () => {
  const run = ladder(UNAVAILABLE);
  const result = await createOutlineRungs({ tiles: fixtureTiles(), nominatim: fakeNominatim(null) }).resolve(
    ctx({ scope: 'street', target: 'Lombard Street', matchName: 'Lombard Street' }),
    run,
  );
  assert.equal(result, UNAVAILABLE);
  assert.equal(run.calls.base, 1);
});

test('"circle this building" picks the tile building at the point first', async () => {
  const nominatim = fakeNominatim(null);
  const run = ladder(UNAVAILABLE);
  const result = await createOutlineRungs({ tiles: fixtureTiles(), nominatim }).resolve(
    ctx({ scope: 'building', target: 'this building', fromName: false }),
    run,
  );
  assert.equal(result.footprintKind, 'building');
  assert.equal(run.calls.base, 0);
  assert.equal(nominatim.asks.length, 0);
});

test('a named building asks Nominatim, then falls back to the tile building', async () => {
  const nominatim = fakeNominatim(null);
  const result = await createOutlineRungs({ tiles: fixtureTiles(), nominatim }).resolve(
    ctx({ scope: 'building', target: 'Texas State Capitol' }),
    ladder(UNAVAILABLE),
  );
  assert.deepEqual(nominatim.asks.map((a) => a.kind), ['building']);
  assert.equal(result.footprintKind, 'building');
  assert.equal(result.outlineSource, 'openfreemap');
});

test('a city with no configured Overpass is outlined by Nominatim', async () => {
  const ring = square(43.6, 1.44, 0.05);
  const nominatim = fakeNominatim({ polygons: [[ring]], class: 'boundary' });
  const credits = [];
  const run = ladder(UNAVAILABLE);
  const result = await createOutlineRungs({ tiles: fixtureTiles(), nominatim }).resolve(
    ctx({ scope: 'city', target: 'Toulouse, France', matchName: 'Toulouse', credit: (k) => credits.push(k) }),
    run,
  );
  assert.deepEqual(result.ring, ring);
  assert.equal(result.outlineSource, 'nominatim');
  assert.deepEqual(nominatim.asks[0], { query: 'Toulouse', kind: 'city', lat: CAPITOL.lat, lon: CAPITOL.lon });
  assert.deepEqual(run.calls.finished, ['city'], 'scope caps and drift bound still apply');
  assert.deepEqual(credits, ['osm']);
});

test('a multi-part city leads with the part holding the anchor, not the largest', async () => {
  const sea = square(33.5, 139.5, 0.8); // larger, far from the anchor
  const land = square(CAPITOL.lat, CAPITOL.lon, 0.2);
  const nominatim = fakeNominatim({ polygons: [[sea], [land]], class: 'boundary' });
  const result = await createOutlineRungs({ tiles: fixtureTiles(), nominatim }).resolve(
    ctx({ scope: 'city', target: 'Tokyo', matchName: 'Tokyo' }),
    ladder(UNAVAILABLE),
  );
  assert.deepEqual(result.ring, land, 'the main ring (centroid, scope cap) is the anchored part');
  assert.equal(result.polygons.length, 2, 'every part is still drawn');
});

test('a real outline from the ladder (bundled or operator Overpass) is kept', async () => {
  const nominatim = fakeNominatim(null);
  const outline = { ring: square(0, 0, 1), synthesized: false };
  const result = await createOutlineRungs({ tiles: fixtureTiles(), nominatim }).resolve(
    ctx({ scope: 'city', target: 'Austin' }),
    ladder(outline),
  );
  assert.equal(result, outline);
  assert.equal(nominatim.asks.length, 0);
});

test('a transient ladder failure stays retryable without spending a lookup', async () => {
  const nominatim = fakeNominatim(null);
  const result = await createOutlineRungs({ tiles: fixtureTiles(), nominatim }).resolve(
    ctx({ scope: 'compound', target: 'Zilker Park' }),
    ladder(undefined),
  );
  assert.equal(result, undefined);
  assert.equal(nominatim.asks.length, 0);
});

test('no Nominatim outline leaves the honest point; busy stays retryable', async () => {
  const rungs = (answer) => createOutlineRungs({ tiles: fixtureTiles(), nominatim: fakeNominatim(answer) });
  assert.equal(await rungs(null).resolve(ctx({ scope: 'compound', target: 'Nowhere Park' }), ladder(UNAVAILABLE)), UNAVAILABLE);
  const busy = { rateLimited: true, retryAfterMs: 5000 };
  assert.equal(await rungs(busy).resolve(ctx({ scope: 'compound', target: 'Zilker Park' }), ladder(UNAVAILABLE)), busy);
  // After an operator's definitive miss, a busy Nominatim does not invite retries.
  assert.equal(await rungs(busy).resolve(ctx({ scope: 'compound', target: 'Zilker Park' }), ladder(null)), null);
});

test('grounds: a building-sized answer is not the grounds; a real enclosure is', async () => {
  const dome = { polygons: [[square(30.2747, -97.7403, 0.0003)]], class: 'office' };
  const grounds = { polygons: [[square(30.2747, -97.7403, 0.002)]], class: 'leisure' };
  // The dome is refused; the open area enclosing the point stands in.
  const small = await createOutlineRungs({ tiles: fixtureTiles(), nominatim: fakeNominatim(dome) }).resolve(
    ctx({ scope: 'building', target: 'Texas Capitol grounds', groundsLike: true }),
    ladder(UNAVAILABLE),
  );
  assert.equal(small.outlineSource, 'openfreemap');
  assert.equal(small.footprintKind, 'area');
  // Without enclosing tile cover, the honest point remains.
  const bare = await createOutlineRungs({
    tiles: { fetchBounds: async () => ({ tiles: [] }) },
    nominatim: fakeNominatim(dome),
  }).resolve(ctx({ scope: 'building', target: 'Texas Capitol grounds', groundsLike: true }), ladder(UNAVAILABLE));
  assert.equal(bare, UNAVAILABLE);
  const nominatim = fakeNominatim(grounds);
  const run = ladder(UNAVAILABLE);
  const big = await createOutlineRungs({ tiles: fixtureTiles(), nominatim }).resolve(
    ctx({ scope: 'building', target: 'the Texas Capitol grounds', groundsLike: true }),
    run,
  );
  assert.equal(big.footprintKind, 'area');
  assert.deepEqual(run.calls.finished, ['compound']);
  assert.deepEqual(nominatim.asks.map((a) => [a.query, a.kind]), [['Texas Capitol', 'landmark']]);
});

test('point-like, around and neighbourhood asks never reach Nominatim', async () => {
  for (const extra of [
    { scope: 'compound', pointLike: true, target: 'Tejano Monument' },
    { scope: 'compound', around: true, target: 'Zilker Park' },
    { scope: 'neighborhood', target: 'Mission District' },
  ]) {
    const nominatim = fakeNominatim(null);
    await createOutlineRungs({ tiles: fixtureTiles(), nominatim }).resolve(ctx(extra), ladder(UNAVAILABLE));
    assert.equal(nominatim.asks.length, 0, JSON.stringify(extra));
  }
});

// ------------------------------------------------------------ end to end

function routes(...plugins) {
  const found = new Map();
  for (const plugin of plugins)
    plugin.configureServer({ middlewares: { use: (path, handler) => found.set(path, handler) } });
  return found;
}

async function call(handlers, url, init = {}) {
  const parsed = new URL(url, 'http://localhost');
  const mount = [...handlers.keys()]
    .filter((path) => parsed.pathname === path || parsed.pathname.startsWith(`${path}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!mount) return new Response('{}', { status: 404 });
  const req = Readable.from(init.body ? [Buffer.from(init.body)] : []);
  Object.assign(req, {
    method: init.method || 'GET',
    url: parsed.pathname.slice(mount.length) + parsed.search || '/',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status;
  let headers;
  let body;
  await handlers.get(mount)(
    req,
    {
      on() {},
      writeHead(s, h) {
        status = s;
        headers = h;
      },
      end(b) {
        body = b;
      },
    },
    () => {
      status = 404;
      body = '{}';
    },
  );
  return new Response(body, { status, headers });
}

const NOMINATIM_ROWS = {
  Toulouse: [
    { category: 'place', type: 'city', name: 'Toulouse', lat: '43.6', lon: '1.44', geojson: { type: 'Point', coordinates: [1.44, 43.6] } },
    { category: 'boundary', type: 'administrative', addresstype: 'city', name: 'Toulouse', lat: '43.6', lon: '1.44', osm_type: 'relation', osm_id: 35738, geojson: { type: 'Polygon', coordinates: [square(43.6, 1.44, 0.05)] } },
  ],
  'Central Park': [
    { category: 'leisure', type: 'park', name: 'Central Park', lat: '40.78', lon: '-73.965', osm_type: 'relation', osm_id: 8, geojson: { type: 'Polygon', coordinates: [square(40.78, -73.965, 0.01)] } },
  ],
  'Bagmati Province': [
    {
      category: 'boundary',
      type: 'administrative',
      addresstype: 'province',
      name: 'Bagmati Province',
      lat: '27.7',
      lon: '85.3',
      osm_type: 'relation',
      osm_id: 12345,
      geojson: { type: 'Polygon', coordinates: [square(27.7, 85.3, 0.4)] },
    },
  ],
};

const PLACES = {
  Toulouse: {
    lat: 43.6,
    lng: 1.44,
    name: 'Toulouse',
    label: 'Toulouse, France',
    types: ['locality', 'political'],
  },
  'Central Park': {
    lat: 40.78,
    lng: -73.965,
    name: 'Central Park',
    label: 'Central Park, New York',
    types: ['park'],
  },
  'Congress Avenue': {
    lat: 30.268,
    lng: -97.7427,
    name: 'Congress Avenue',
    label: 'Congress Ave, Austin',
    types: ['route'],
  },
  'Bagmati Province': {
    lat: 27.7,
    lng: 85.3,
    name: 'Bagmati Province',
    label: 'Bagmati Province, Nepal',
    types: ['administrative_area_level_1', 'political'],
  },
};

const viewerAt = (lat, lon, height = 4000) => ({
  camera: { positionCartographic: { latitude: (lat * Math.PI) / 180, longitude: (lon * Math.PI) / 180, height } },
});

test('default settings: outline, street and building asks send nothing to Overpass', async (t) => {
  const prior = process.env.OVERPASS_UPSTREAMS;
  delete process.env.OVERPASS_UPSTREAMS;
  t.after(() => {
    if (prior !== undefined) process.env.OVERPASS_UPSTREAMS = prior;
  });
  // Any request that escapes the injected transports fails the test.
  t.mock.method(globalThis, 'fetch', async (url) => assert.fail(`unexpected network request ${url}`));

  const upstream = [];
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gev-outline-rungs-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const gate = createNominatimGate({
    settings: { endpoint: 'https://nominatim.openstreetmap.org/search', isPublic: true, dailyCap: 50 },
    fetchImpl: async (url) => {
      upstream.push(String(url));
      const q = new URL(url).searchParams.get('q');
      return Response.json(NOMINATIM_ROWS[q] || []);
    },
    usage: createGateStateStore({ file: path.join(stateDir, 'state.json') }),
    sleep: async () => {},
  });
  const handlers = routes(overpassProxy(), geocodeProxy({ gate }));
  const local = [];
  const transport = (url, init) => {
    local.push(`${init?.method || 'GET'} ${String(url).split('?')[0]}`);
    return call(handlers, url, init);
  };
  const services = createApplicationRequestServices({ fetchImpl: transport });
  const resolver = createAnnotationResolver({
    featureSource: services.features,
    outlineRungs: createOutlineRungs({
      tiles: fixtureTiles(),
      nominatim: createNominatimOutlineClient({ fetchImpl: transport }),
    }),
  });
  const placeSearch = { geocode: async (q) => ({ place: PLACES[q] || null, answered: true }) };
  const resolve = async (viewer, args) => {
    const result = await resolver.resolveAnnotationTarget({ viewer, placeSearch, footprint: true, deferFootprint: true, ...args });
    return { result, outline: await result.resolveOutline() };
  };

  const paris = await resolve(viewerAt(43.6, 1.44, 40_000), { target: 'Toulouse' });
  assert.ok(paris.outline?.ring?.length >= 4, 'city outlined');
  assert.equal(paris.outline.outlineSource, 'nominatim');

  const park = await resolve(viewerAt(40.78, -73.965), { target: 'Central Park' });
  assert.equal(park.outline?.outlineSource, 'nominatim');

  const areas = createVoiceAreas({
    viewer: viewerAt(27.7, 85.3, 40_000),
    annotationResolver: resolver,
    placeSearch,
  });
  const verified = await areas.resolveAreaAction({
    query: 'Bagmati Province',
    level: 'admin1',
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.sourceIdentity, 'Bagmati Province');
  assert.equal(areas.store.get(verified.areaId).meta.adminLevel, 'admin1');

  const street = await resolve(viewerAt(30.27, -97.742), {
    target: 'Congress Avenue',
  });
  assert.equal(street.outline?.outlineSource, 'openfreemap');

  const building = await resolve(viewerAt(30.2747, -97.7403, 800), {
    latitude: CAPITOL.lat,
    longitude: CAPITOL.lon,
    entityKind: 'building',
    target: 'this building',
  });
  assert.equal(building.outline?.footprintKind, 'building');
  assert.equal(building.outline?.outlineSource, 'openfreemap');

  assert.ok(
    upstream.every((url) =>
      url.startsWith('https://nominatim.openstreetmap.org/search?'),
    ),
  );
  assert.equal(
    upstream.length,
    3,
    'one upstream request per explicit ask that needed one',
  );
  assert.ok(!upstream.some((url) => /overpass/i.test(url)));
  // The only Overpass traffic is the local capability probe, answered locally.
  assert.ok(
    local.filter((line) => line.includes('/api/overpass')).every((line) => line === 'GET /api/overpass/status'),
    local.join('\n'),
  );
});

test('a cancelled ask stops between rungs and never reaches Nominatim', async () => {
  const nominatim = fakeNominatim({ polygons: [[square(43.6, 1.44, 0.05)]], class: 'boundary' });
  const rungs = createOutlineRungs({ tiles: fixtureTiles(), nominatim });
  // Cancelled while the configured ladder ran.
  const controller = new AbortController();
  await assert.rejects(
    rungs.resolve(ctx({ scope: 'city', target: 'Toulouse', signal: controller.signal }), {
      base: async () => {
        controller.abort();
        return UNAVAILABLE;
      },
      finish: (fp) => fp,
    }),
    { name: 'AbortError' },
  );
  // Cancelled before it started: not even the ladder runs.
  const run = ladder(UNAVAILABLE);
  await assert.rejects(
    rungs.resolve(ctx({ scope: 'city', target: 'Toulouse', signal: AbortSignal.abort() }), run),
    { name: 'AbortError' },
  );
  assert.equal(run.calls.base, 0);
  assert.equal(nominatim.asks.length, 0);
});
