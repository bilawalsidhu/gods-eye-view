// Footprint-selection contract tests — pure fixtures, no network, no browser.
//
// Locks the monument-resolution regression:
// a POINT-LIKE target ("Tejano Monument, Austin") must never adopt a nearby
// polygon that merely shares locality/context words ("Austin", "History").
// The fixtures replicate the REAL Overpass candidates captured over the Texas
// Capitol on 2026-07-01, where "Thompson Austin" (a hotel 680 m away) outscored
// everything because `nameOverlap * 1000` paid +1000 for the single word
// "Austin" — the monument itself is an OSM node and never even a candidate.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  resolveAnnotationTarget,
  selectFootprint,
  refineScope,
  isGroundsLikeAsk,
  placesNearViewRecovery,
  viewportBias,
  resolveRegionRingForQuery,
} from './annotationResolver.js';

// Build a square way of ~`areaM2` centred `dLatM`/`dLonM` metres from an anchor,
// in Overpass `out geom` element shape ({ tags, geometry: [{lat,lon}...] }).
function squareWay(anchor, dLatM, dLonM, areaM2, tags) {
  const mLat = 111320;
  const mLon = mLat * Math.cos((anchor.lat * Math.PI) / 180);
  const cLat = anchor.lat + dLatM / mLat;
  const cLon = anchor.lon + dLonM / mLon;
  const half = Math.sqrt(areaM2) / 2;
  const dy = half / mLat;
  const dx = half / mLon;
  const ring = [
    { lat: cLat - dy, lon: cLon - dx },
    { lat: cLat - dy, lon: cLon + dx },
    { lat: cLat + dy, lon: cLon + dx },
    { lat: cLat + dy, lon: cLon - dx },
    { lat: cLat - dy, lon: cLon - dx },
  ];
  return { type: 'way', tags, geometry: ring };
}

// The real Places anchor for "Tejano Monument, Austin" (on the Capitol grounds).
const ANCHOR = { lat: 30.27297, lon: -97.74029 };

// Real captured wrong-winners: named downtown features that share ONLY "Austin".
const wrongWinners = () => [
  squareWay(ANCHOR, -660, -90, 3093, { building: 'yes', tourism: 'hotel', name: 'Thompson Austin' }),
  squareWay(ANCHOR, -780, 120, 3772, { building: 'yes', name: 'Austin Police HQ' }),
  squareWay(ANCHOR, -380, -60, 4499, { leisure: 'park', name: 'Black Austin Matters' }),
  squareWay(ANCHOR, -240, -700, 1500, { building: 'yes', amenity: 'library', name: 'Austin Public Library - Austin History Center' }),
  // The real enclosing grounds polygon — unnamed overlap with the monument query.
  squareWay(ANCHOR, 0, 0, 100_000, { leisure: 'park', name: 'Capitol Square' }),
];

test('point mode: locality-word polygons never stand in for a monument (the Tejano bug)', () => {
  const fp = selectFootprint(wrongWinners(), ANCHOR.lat, ANCHOR.lon, 'Tejano Monument, Austin', 'point');
  assert.equal(fp, null); // keep the honest point anchor
});

test('point mode: an (almost) exactly-named, monument-scale polygon still outlines', () => {
  const els = wrongWinners();
  els.push(squareWay(ANCHOR, 5, 5, 300, { tourism: 'artwork', name: 'Tejano Monument' }));
  const fp = selectFootprint(els, ANCHOR.lat, ANCHOR.lon, 'Tejano Monument, Austin', 'point');
  assert.ok(fp, 'expected the true monument way to be accepted');
  assert.equal(fp.kind, 'area');
  // Ring is centred on the true feature (a few metres from the anchor), not downtown.
  const lat0 = fp.ring[0][1];
  assert.ok(Math.abs(lat0 - ANCHOR.lat) < 0.001, `ring landed at ${lat0}, expected ~${ANCHOR.lat}`);
});

test('point mode: an exactly-named but park-sized polygon is rejected (size cap)', () => {
  // "Pioneer Monument, Golden Gate Park" — the park matches 3/3 of its own name
  // and contains the anchor, but a 4.1 km² park must not render as a monument.
  const park = squareWay(ANCHOR, 0, 0, 4_100_000, { leisure: 'park', name: 'Golden Gate Park' });
  const fp = selectFootprint([park], ANCHOR.lat, ANCHOR.lon, 'Pioneer Monument, Golden Gate Park', 'point');
  assert.equal(fp, null);
});

test('loose mode: unchanged — word-overlap scoring still picks the named candidate', () => {
  // Pins that the fix is SCOPED to point-like targets: generic loose lookups keep
  // the existing scorer (changing it globally would need its own field evidence).
  const fp = selectFootprint(wrongWinners(), ANCHOR.lat, ANCHOR.lon, 'Tejano Monument, Austin', 'loose');
  assert.ok(fp, 'loose mode still resolves a footprint');
});

test('loose mode: a named compound still beats an unnamed containing building (Presidio case)', () => {
  const els = [
    squareWay(ANCHOR, 0, 0, 900, { building: 'yes' }), // unnamed building under the anchor
    squareWay(ANCHOR, 400, 400, 6_000_000, { landuse: 'military', name: 'Presidio of San Francisco' }),
  ];
  const fp = selectFootprint(els, ANCHOR.lat, ANCHOR.lon, 'Presidio of San Francisco', 'loose');
  assert.ok(fp);
  assert.equal(fp.kind, 'area');
});

test('strict mode: unchanged — named district-sized areas only', () => {
  const els = [
    squareWay(ANCHOR, 0, 0, 900, { building: 'yes', name: 'Mission Lofts' }), // building → rejected
    squareWay(ANCHOR, 0, 0, 12_000, { landuse: 'retail', name: 'Mission Market' }), // tiny parcel → rejected
    squareWay(ANCHOR, 200, 200, 500_000, { landuse: 'residential', name: 'Mission District' }),
  ];
  const fp = selectFootprint(els, ANCHOR.lat, ANCHOR.lon, 'Mission District', 'strict');
  assert.ok(fp);
  assert.equal(fp.kind, 'area');
  assert.ok(Math.abs(fp.ring[0][1] - (ANCHOR.lat + 200 / 111320)) < 0.01);
});

test('loose mode: a named water body beats a shore feature named after it (field test 9)', () => {
  // "Lady Bird Lake" — the anchor sits ON the water. Before natural=water joined the
  // sweep, the lake was never a candidate and a shoreline park NAMED AFTER it won on
  // word overlap, drawing a squiggle on the bank instead of the lake.
  const ANCHOR_ON_WATER = { lat: 30.2565, lon: -97.7365 };
  const els = [
    // The real lake: large named water polygon containing the anchor.
    squareWay(ANCHOR_ON_WATER, 0, 0, 3_500_000, { natural: 'water', water: 'reservoir', name: 'Lady Bird Lake' }),
    // Shore park named after the lake (partial name coverage, does not contain anchor).
    squareWay(ANCHOR_ON_WATER, 450, -300, 90_000, { leisure: 'park', name: 'Auditorium Shores at Lady Bird Lake Metropolitan Park' }),
  ];
  const fp = selectFootprint(els, ANCHOR_ON_WATER.lat, ANCHOR_ON_WATER.lon, 'Lady Bird Lake, Austin', 'loose');
  assert.ok(fp);
  assert.equal(fp.kind, 'area');
  // Ring centred on the lake fixture, not offset onto the shore park.
  const lat0 = fp.ring[0][1];
  assert.ok(Math.abs(lat0 - ANCHOR_ON_WATER.lat) < 0.02, `ring at ${  lat0}`);
  assert.ok(Math.abs(lat0 - (ANCHOR_ON_WATER.lat + 450 / 111320)) > 0.001, 'must not be the shore park');

  // Inverse: a LAND ask near the water is not stolen by the lake polygon.
  const park = selectFootprint(els, ANCHOR_ON_WATER.lat + 0.004, ANCHOR_ON_WATER.lon - 0.003, 'Auditorium Shores', 'loose');
  assert.ok(park);
  assert.ok(Math.abs(park.ring[0][1] - (ANCHOR_ON_WATER.lat + 450 / 111320)) < 0.01, 'land ask keeps the park');
});

test('isGroundsLikeAsk: label wording and entityKind both count (field test 8)', () => {
  // The model's real call shape: grounds word only in the LABEL, compound entityKind.
  assert.equal(isGroundsLikeAsk('Texas State Capitol, Austin', 'Capitol grounds', 'compound'), true);
  // Label alone is enough when no entityKind is given.
  assert.equal(isGroundsLikeAsk('Texas State Capitol, Austin', 'Capitol grounds', null), true);
  // Target wording still works as before.
  assert.equal(isGroundsLikeAsk('Texas State Capitol grounds, Austin', null, null), true);
  // An explicit non-compound entityKind vetoes grounds wording (trust the model's fact).
  assert.equal(isGroundsLikeAsk('Capitol complex', 'the complex', 'building'), false);
  // A plain building ask is not grounds-like.
  assert.equal(isGroundsLikeAsk('Texas State Capitol, Austin', 'Texas State Capitol', null), false);
});

test('refineScope: entityKind refines only an unresolved (auto) scope', () => {
  assert.equal(refineScope('auto', 'building'), 'building');
  assert.equal(refineScope('auto', 'compound'), 'compound');
  assert.equal(refineScope('auto', 'district'), 'neighborhood');
  assert.equal(refineScope('auto', 'street'), 'street');
  assert.equal(refineScope('auto', 'point_feature'), 'auto'); // point-first handled separately
  assert.equal(refineScope('auto', undefined), 'auto');
  // Real geocode types (data) always win over the model's claim.
  assert.equal(refineScope('city', 'building'), 'city');
  assert.equal(refineScope('neighborhood', 'street'), 'neighborhood');
});

function closeViewportViewer() {
  return {
    camera: {
      positionCartographic: {
        latitude: 30.2672 * Math.PI / 180,
        longitude: -97.7431 * Math.PI / 180,
        height: 1000,
      },
    },
  };
}

function geocodePayload({ lat, lon, types, label }) {
  return {
    status: 'OK',
    results: [{
      formatted_address: label,
      types,
      address_components: [{ long_name: label.split(',')[0], types }],
      geometry: { location: { lat, lng: lon } },
    }],
  };
}

function installGoogleMocks(t, handler) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = {
    __GOOGLE_MAPS_API_KEY__: 'unit-test-key',
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.fetch = handler;
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });
}

test('ask-side admin bypass: "the Texas Capitol" recovers near-view despite a far state-typed geocode', async (t) => {
  const calls = [];
  installGoogleMocks(t, async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      return { json: async () => geocodePayload({
        lat: 31.0000,
        lon: -99.0000,
        types: ['administrative_area_level_1', 'political'],
        label: 'Texas, USA',
      }) };
    }
    assert.match(String(url), /^\/api\/google\/text-search\?/);
    return {
      ok: true,
      json: async () => ({ places: [{
        latitude: 30.2747,
        longitude: -97.7404,
        name: 'Texas Capitol',
        types: ['premise'],
      }] }),
    };
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'the Texas Capitol',
  });

  assert.ok(resolved);
  assert.equal(resolved.source, 'places');
  assert.deepEqual([resolved.lat, resolved.lon], [30.2747, -97.7404]);
  assert.equal(calls.length, 2, 'admin result types must not suppress near-view recovery');
});

test('ask-side admin bypass: explicit "state of Texas" skips recovery and proximity gating', async (t) => {
  const calls = [];
  installGoogleMocks(t, async (url) => {
    calls.push(String(url));
    assert.match(String(url), /^https:\/\/maps\.googleapis\.com\/maps\/api\/geocode/);
    return { json: async () => geocodePayload({
      lat: 31.0000,
      lon: -99.0000,
      types: ['administrative_area_level_1', 'political'],
      label: 'Texas, USA',
    }) };
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'state of Texas',
  });

  assert.ok(resolved, 'the explicit state ask keeps its legitimate far centroid');
  assert.equal(resolved.source, 'geocode');
  assert.deepEqual([resolved.lat, resolved.lon], [31, -99]);
  assert.equal(calls.length, 1, 'explicit state scope bypasses near-view recovery');
});

for (const fixture of [
  {
    target: 'Empire State',
    lat: 40.7484,
    lon: -73.9857,
    types: ['premise', 'tourist_attraction'],
  },
  {
    target: 'Ohio State',
    lat: 40.0067,
    lon: -83.0305,
    types: ['university'],
  },
]) {
  test(`ask-side admin bypass: trailing name "${fixture.target}" remains guarded`, async (t) => {
    const calls = [];
    installGoogleMocks(t, async (url) => {
      calls.push(String(url));
      if (String(url).startsWith('https://maps.googleapis.com/')) {
        return { json: async () => geocodePayload({
          lat: fixture.lat,
          lon: fixture.lon,
          types: fixture.types,
          label: `${fixture.target}, USA`,
        }) };
      }
      assert.match(String(url), /^\/api\/google\/text-search\?/);
      return { ok: true, json: async () => ({ places: [] }) };
    });

    const resolved = await resolveAnnotationTarget({
      viewer: closeViewportViewer(),
      target: fixture.target,
    });

    assert.equal(resolved, null, 'a recovery miss continues through the proximity gate');
    assert.equal(calls.length, 2, 'a proper name ending in State must try near-view recovery');
  });
}

test('ask-side admin bypass: bare "Texas" remains on the guarded recovery path', async (t) => {
  const calls = [];
  installGoogleMocks(t, async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      return { json: async () => geocodePayload({
        lat: 31.0000,
        lon: -99.0000,
        types: ['administrative_area_level_1', 'political'],
        label: 'Texas, USA',
      }) };
    }
    assert.match(String(url), /^\/api\/google\/text-search\?/);
    return { ok: true, json: async () => ({ places: [] }) };
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'Texas',
  });

  assert.equal(resolved, null, 'a recovery miss continues through the proximity gate');
  assert.equal(calls.length, 2, 'bare state names are not an explicit admin-scoped ask');
});

test('ask-side admin bypass: admin level 2/3 result types never grant a township bypass', async (t) => {
  const fixtures = new Map([
    ['FB-3 township level 2 fixture', ['administrative_area_level_2', 'locality', 'political']],
    ['FB-3 township level 3 fixture', ['administrative_area_level_3', 'locality', 'political']],
  ]);
  const calls = [];
  installGoogleMocks(t, async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      const query = new URL(String(url)).searchParams.get('address');
      return { json: async () => geocodePayload({
        lat: 39.7817,
        lon: -89.6501,
        types: fixtures.get(query),
        label: `${query}, Illinois`,
      }) };
    }
    assert.match(String(url), /^\/api\/google\/text-search\?/);
    return {
      ok: true,
      json: async () => ({ places: [{
        latitude: 30.2680,
        longitude: -97.7425,
        name: 'Local township fixture',
        types: ['locality'],
      }] }),
    };
  });

  for (const target of fixtures.keys()) {
    const resolved = await resolveAnnotationTarget({
      viewer: closeViewportViewer(),
      target,
    });
    assert.ok(resolved);
    assert.equal(resolved.source, 'places');
  }

  assert.equal(
    calls.filter((url) => url.startsWith('/api/google/text-search')).length,
    2,
    'both township-level admin result types stay guarded',
  );
});

// ── Offline Natural Earth anchor rung (L9 matrix D10) ──────────────────────
// Keyless, the Places proxy 503s and geocodePlace returns null — a named
// natural region used to die as "could not resolve location" even though the
// bundled pack knows the range offline. The anchor rung must anchor it, and
// the outline rung must then grant the real ring.
test('keyless natural-region target anchors offline and resolves the real ring', async (t) => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: '' };
  // Keyless: the Places text-search proxy degrades to 503; the geocoder is
  // never fetched (geocodePlace returns null before any network).
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'the Alps',
    footprint: true, // the area draw asks for the outline inline
  });

  assert.ok(resolved, 'a curated natural region must resolve with zero keys');
  // A resolved ring is reported as the 'footprint' source; 'natural-region' is
  // the pre-outline anchor source (visible in the resolver trace).
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.synthesized, false, 'must be the real Natural Earth polygon, not a blob');
  assert.equal(resolved.footprintKind, 'area');
  assert.equal(resolved.label, 'Alps');
  assert.ok(Array.isArray(resolved.ring) && resolved.ring.length >= 8,
    `expected the Natural Earth range ring, got ${resolved.ring?.length}`);
  // Ring centroid sits in the Alps, not at a far geocoded city.
  const latMean = resolved.ring.reduce((sum, [, lat]) => sum + lat, 0) / resolved.ring.length;
  const lonMean = resolved.ring.reduce((sum, [lon]) => sum + lon, 0) / resolved.ring.length;
  assert.ok(latMean > 42 && latMean < 50, `ring lat ${latMean.toFixed(1)} not in the Alps`);
  assert.ok(lonMean > 3 && lonMean < 18, `ring lon ${lonMean.toFixed(1)} not in the Alps`);
});

test('a name outside the Natural Earth pack still fails honestly when geocoding is unavailable', async (t) => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: '' };
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'zzz no such place',
  });
  assert.equal(resolved, null);
});

// ════════════════════════════════════════════════════════════════════════════
// End-to-end resolver contract tests — mocked Google / Places / Overpass
// transports. Cover the anchor rungs (places-first, geocode, recovery, pixel,
// osm-local snap), the footprint scope ladder (admin / place / landuse /
// street / grounds / around), the throttle + transient tri-state, the cache
// semantics, and the analyst region-ring entry point. No network: every fetch
// is routed by URL, and every Overpass call by a QL-text marker.
// ════════════════════════════════════════════════════════════════════════════

// ── fixture builders ────────────────────────────────────────────────────────

/** Closed square ring of Overpass `{lat,lon}` points, half-width `halfM` metres. */
function llRing(lat, lon, halfM) {
  const mLat = 111320;
  const mLon = mLat * Math.cos((lat * Math.PI) / 180);
  const dy = halfM / mLat;
  const dx = halfM / mLon;
  return [
    { lat: lat - dy, lon: lon - dx },
    { lat: lat - dy, lon: lon + dx },
    { lat: lat + dy, lon: lon + dx },
    { lat: lat + dy, lon: lon - dx },
    { lat: lat - dy, lon: lon - dx },
  ];
}

const wayEl = (id, lat, lon, halfM, tags) => ({ type: 'way', id, tags, geometry: llRing(lat, lon, halfM) });
const relEl = (id, lat, lon, halfM, tags) => ({
  type: 'relation',
  id,
  tags,
  members: [{ role: 'outer', geometry: llRing(lat, lon, halfM) }],
});
const nodeEl = (id, lat, lon, tags) => ({ type: 'node', id, lat, lon, tags });
const areaEl = (id, name, adminLevel) => ({
  type: 'area',
  id,
  tags: { boundary: 'administrative', admin_level: String(adminLevel), name, 'name:en': name },
});

/** Unclosed `n`-point circle geometry (relation members need not close; closeRing does it). */
function circleGeometry(lat, lon, rDeg, n) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    pts.push({
      lat: lat + Math.sin(a) * rDeg,
      lon: lon + (Math.cos(a) * rDeg) / Math.cos((lat * Math.PI) / 180),
    });
  }
  return pts;
}

/** Camera-only viewer centred at (lat, lon) — viewportProximity works, picking does not. */
function viewerAt(lat, lon, height = 1000) {
  return {
    camera: {
      positionCartographic: {
        latitude: (lat * Math.PI) / 180,
        longitude: (lon * Math.PI) / 180,
        height,
      },
    },
  };
}

/** Screen-pick viewer for the pixel-fallback cascade. */
function pickViewer({ canvas, pickPosition, pickEllipsoid, globePick } = {}) {
  const scene = { canvas: canvas || { clientWidth: 800, clientHeight: 600 } };
  if (pickPosition) {
    scene.pickPositionSupported = true;
    scene.pickPosition = pickPosition;
  }
  if (globePick) scene.globe = { pick: globePick };
  const camera = {
    positionCartographic: {
      latitude: (30.2672 * Math.PI) / 180,
      longitude: (-97.7431 * Math.PI) / 180,
      height: 1000,
    },
  };
  if (pickEllipsoid) camera.pickEllipsoid = pickEllipsoid;
  if (pickEllipsoid || globePick) camera.getPickRay = () => ({});
  return { camera, scene };
}

// ── mock transport harness ──────────────────────────────────────────────────

/** Coerce a handler result into a fetch-Response-shaped object. */
function envelope(value) {
  if (Array.isArray(value)) {
    return { ok: true, status: 200, headers: null, json: async () => ({ elements: value }) };
  }
  if (value && typeof value.json === 'function') return value;
  if (value && typeof value.status === 'number') {
    return {
      ok: value.status >= 200 && value.status < 300,
      status: value.status,
      headers: value.headers || null,
      json: async () => value.body || {},
    };
  }
  if (value && typeof value.remark === 'string') {
    return { ok: true, status: 200, headers: null, json: async () => ({ elements: [], remark: value.remark }) };
  }
  if (value && value.throw) throw value.throw;
  return { ok: true, status: 200, headers: null, json: async () => value };
}

/**
 * Route every fetch by URL; route Overpass calls by a QL-text marker. Handlers:
 * geocode(url, opts), places(url, opts), overpass(ql) — each returns an
 * `envelope`-shapable value (array = Overpass elements, {status} = HTTP status,
 * {remark} = Overpass 200-error body, plain object = JSON body).
 */
function installResolverMocks(t, { geocode, places, overpass } = {}) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const overpassCalls = [];
  globalThis.window = {
    __GOOGLE_MAPS_API_KEY__: 'unit-test-key',
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://maps.googleapis.com/')) {
      if (!geocode) throw new Error(`unexpected geocode fetch: ${u}`);
      return envelope(await geocode(u, opts));
    }
    if (u.includes('/api/google/text-search')) {
      if (!places) throw new Error(`unexpected places fetch: ${u}`);
      return envelope(await places(u, opts));
    }
    if (u.includes('/api/overpass')) {
      const ql = decodeURIComponent(String(opts.body || '').replace(/^data=/, ''));
      overpassCalls.push(ql);
      if (!overpass) throw new Error(`unexpected overpass fetch: ${ql}`);
      return envelope(await overpass(ql, opts));
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  console.log = () => {}; // the resolver traces one line per target — keep test output clean
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });
  return {
    overpassCalls,
    overpassBy: (marker) => overpassCalls.filter((q) => q.includes(marker)),
  };
}

/** First `around:<r>,LAT,LON` in a QL text — the footprint sweep's anchor. */
function firstAroundCoords(ql) {
  const m = /around:\d+,(-?[\d.]+),(-?[\d.]+)/.exec(ql);
  return m ? `${Number(m[1]).toFixed(3)},${Number(m[2]).toFixed(3)}` : '?';
}

/**
 * Radius of a synthesized circular ring in metres, measured as half the
 * longitude bounding span. (Measuring from the mark centroid under-reads by
 * 44/45: the closed ring duplicates its first vertex, so the centroid sits
 * r/45 east of the geometric centre.)
 */
function ringRadiusM(ring, lat) {
  const lons = ring.map(([lon]) => lon);
  const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  return ((Math.max(...lons) - Math.min(...lons)) / 2) * mLon;
}

function geocodeBody(lat, lon, types, label, extra = {}) {
  return {
    status: 'OK',
    results: [{
      formatted_address: label,
      types,
      address_components: extra.noComponents ? undefined : [{ long_name: label.split(',')[0], types }],
      geometry: {
        location: { lat, lng: lon },
        ...(extra.bounds ? { bounds: extra.bounds } : {}),
      },
    }],
  };
}

const AUSTIN = { lat: 30.2672, lon: -97.7431 };
const PLACES_HIT = (lat, lon, name) => ({
  places: [{ latitude: lat, longitude: lon, name, types: ['monument'], id: 'p1', primaryType: 'monument' }],
});

// ── A. pixel fallback + pick cascade ────────────────────────────────────────

test('pixel fallback anchors a nameless ask to the world point under the pick', async () => {
  const viewer = pickViewer({
    pickPosition: () => Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 10),
  });
  const resolved = await resolveAnnotationTarget({ viewer, screenX: 0.5, screenY: 0.5 });
  assert.ok(resolved, 'a valid depth pick anchors the mark');
  assert.equal(resolved.source, 'pixel');
  assert.ok(Math.abs(resolved.lat - 30.27) < 1e-6);
  assert.ok(Math.abs(resolved.lon + 97.74) < 1e-6);
});

test('pick cascade: depth miss falls to ellipsoid, ellipsoid miss to globe.pick', async () => {
  // Stage 2: no depth pick support → pickEllipsoid answers.
  const ellipsoidViewer = pickViewer({
    pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(-97.75, 30.28, 0),
  });
  const viaEllipsoid = await resolveAnnotationTarget({ viewer: ellipsoidViewer, screenX: 0.5, screenY: 0.5 });
  assert.equal(viaEllipsoid.source, 'pixel');
  assert.ok(Math.abs(viaEllipsoid.lat - 30.28) < 1e-6);

  // Stage 3: degenerate depth + degenerate ellipsoid → getPickRay + globe.pick.
  const globeViewer = pickViewer({
    pickPosition: () => ({ x: 1, y: 2, z: 3 }), // finite but far inside the earth → rejected
    pickEllipsoid: () => null,
    globePick: () => Cesium.Cartesian3.fromDegrees(-97.76, 30.29, 0),
  });
  const viaGlobe = await resolveAnnotationTarget({ viewer: globeViewer, screenX: 0.25, screenY: 0.75 });
  assert.equal(viaGlobe.source, 'pixel');
  assert.ok(Math.abs(viaGlobe.lat - 30.29) < 1e-6);

  // A throwing pickPosition is a missed pick, not a crash — the cascade continues.
  const throwingViewer = pickViewer({
    pickPosition: () => { throw new Error('depth buffer unavailable'); },
    pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(-97.77, 30.30, 0),
  });
  const viaThrow = await resolveAnnotationTarget({ viewer: throwingViewer, screenX: 0.5, screenY: 0.5 });
  assert.ok(Math.abs(viaThrow.lat - 30.30) < 1e-6);
});

test('pick cascade: every stage degenerate → honest null', async () => {
  const viewer = pickViewer({
    pickPosition: () => null,
    pickEllipsoid: () => null,
    globePick: () => null,
  });
  const resolved = await resolveAnnotationTarget({ viewer, screenX: 0.5, screenY: 0.5 });
  assert.equal(resolved, null, 'no name and no world point → no annotation');
});

test('a zero-sized canvas makes the pixel fallback a miss', async () => {
  const viewer = pickViewer({ canvas: { clientWidth: 0, clientHeight: 0 } });
  const resolved = await resolveAnnotationTarget({ viewer, screenX: 0.5, screenY: 0.5 });
  assert.equal(resolved, null);
});

// ── B. caches + abort ───────────────────────────────────────────────────────

test('definitive geocode misses cache for the NEG TTL, then re-fetch', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let calls = 0;
  installResolverMocks(t, {
    geocode: () => { calls += 1; return { status: 'ZERO_RESULTS' }; },
    places: () => ({ places: [] }),
    overpass: () => [],
  });
  const ask = () => resolveAnnotationTarget({ viewer: viewerAt(AUSTIN.lat, AUSTIN.lon), target: 'Papa Zero' });

  assert.equal(await ask(), null);
  assert.equal(await ask(), null, 'a definitive ZERO_RESULTS is served from the cache');
  assert.equal(calls, 1);
  t.mock.timers.tick(61_000);
  assert.equal(await ask(), null, 'after the TTL the miss is retried');
  assert.equal(calls, 2);
  t.mock.timers.reset();
});

test('transient geocode failures (throttle, network) never poison the cache', async (t) => {
  let throttleCalls = 0;
  let throwCalls = 0;
  installResolverMocks(t, {
    geocode: (url) => {
      if (String(url).includes('quebec')) { throttleCalls += 1; return { status: 'OVER_QUERY_LIMIT' }; }
      throwCalls += 1;
      throw new Error('network unreachable');
    },
    places: () => ({ places: [] }),
    overpass: () => [],
  });
  const viewer = viewerAt(AUSTIN.lat, AUSTIN.lon);
  assert.equal(await resolveAnnotationTarget({ viewer, target: 'quebec flats' }), null);
  assert.equal(await resolveAnnotationTarget({ viewer, target: 'quebec flats' }), null);
  assert.equal(throttleCalls, 2, 'OVER_QUERY_LIMIT is transient — each ask re-fetches');
  assert.equal(await resolveAnnotationTarget({ viewer, target: 'uniform reach' }), null);
  assert.equal(await resolveAnnotationTarget({ viewer, target: 'uniform reach' }), null);
  assert.equal(throwCalls, 2, 'a network throw is transient — each ask re-fetches');
});

test('places: a miss is definitive, an HTTP 500 and a throw are transient', async (t) => {
  let missCalls = 0;
  let errorCalls = 0;
  let throwCalls = 0;
  installResolverMocks(t, {
    places: (url) => {
      const q = new URL(`http://x${  url}`).searchParams.get('q');
      if (q === 'romeo spot') { missCalls += 1; return { places: [] }; }
      if (q === 'sierra spot') { errorCalls += 1; return { status: 500 }; }
      throwCalls += 1;
      throw new Error('proxy offline');
    },
  });
  const viewer = viewerAt(AUSTIN.lat, AUSTIN.lon);
  assert.equal(await placesNearViewRecovery(viewer, 'romeo spot', null), null);
  assert.equal(await placesNearViewRecovery(viewer, 'romeo spot', null), null);
  assert.equal(missCalls, 1, 'a Places miss is definitive and cached');
  assert.equal(await placesNearViewRecovery(viewer, 'sierra spot', null), null);
  assert.equal(await placesNearViewRecovery(viewer, 'sierra spot', null), null);
  assert.equal(errorCalls, 2, 'an HTTP 500 is transient — retried every ask');
  assert.equal(await placesNearViewRecovery(viewer, 'tango spot', null), null);
  assert.equal(await placesNearViewRecovery(viewer, 'tango spot', null), null);
  assert.equal(throwCalls, 2, 'a thrown fetch is transient — retried every ask');
});

test('an abort mid-geocode leaves no cache poison', async (t) => {
  let calls = 0;
  installResolverMocks(t, {
    geocode: (url, opts) => new Promise((resolve, reject) => {
      calls += 1;
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    places: () => ({ places: [] }),
    overpass: () => [],
  });
  const viewer = viewerAt(AUSTIN.lat, AUSTIN.lon);
  const ask = async () => {
    const ctrl = new AbortController();
    const pending = resolveAnnotationTarget({ viewer, target: 'hotel california', signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    return pending;
  };
  assert.equal(await ask(), null);
  assert.equal(await ask(), null);
  assert.equal(calls, 2, 'the aborted ask must not have cached a negative result');
});

test('a pre-aborted ask aborts the Overpass call before it starts', async (t) => {
  const mocks = installResolverMocks(t, {
    overpass: () => { throw new Error('the fetch must reject via the aborted signal'); },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'kilo yard',
    latitude: 30.27,
    longitude: -97.74,
    footprint: true,
    signal: AbortSignal.abort(),
  });
  assert.ok(resolved, 'the anchor survives the aborted outline');
  assert.equal(resolved.ring, null, 'the outline is a transient miss, not a crash');
  assert.equal(mocks.overpassCalls.length, 1, 'the fetch ran only to observe the abort');
});

// ── C. places-first + recovery ──────────────────────────────────────────────

test('monument-like names try Places Text Search FIRST and trust a near hit', async (t) => {
  let geocodeCalls = 0;
  installResolverMocks(t, {
    geocode: () => { geocodeCalls += 1; return geocodeBody(30.27, -97.74, ['premise'], 'Oscar Monument, Austin'); },
    places: () => PLACES_HIT(30.2747, -97.7404, 'Oscar Monument'),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'Oscar Monument',
  });
  assert.equal(resolved.source, 'places');
  assert.deepEqual([resolved.lat, resolved.lon], [30.2747, -97.7404]);
  assert.equal(resolved.label, 'Oscar Monument');
  assert.equal(geocodeCalls, 0, 'a trusted near Places hit skips the geocoder entirely');
});

test('entityKind point_feature earns the same places-first path', async (t) => {
  let geocodeCalls = 0;
  installResolverMocks(t, {
    geocode: () => { geocodeCalls += 1; return geocodeBody(30.27, -97.74, ['premise'], 'Heroes of Waterloo, Austin'); },
    places: () => PLACES_HIT(30.2740, -97.7410, 'Heroes of Waterloo'),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'Heroes of Waterloo',
    entityKind: 'point_feature',
  });
  assert.equal(resolved.source, 'places');
  assert.equal(geocodeCalls, 0);
});

test('a Places hit beyond the trust bound falls through to geocode', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['premise'], 'Plaza Saltillo, Austin'),
    // ~9.2 km from the view centre — beyond the 8 km trust bound.
    places: () => PLACES_HIT(30.35, -97.74, 'Distant Monument'),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'Plaza Saltillo',
  });
  assert.equal(resolved.source, 'geocode', 'an untrusted far Places hit defers to the geocoder');
  assert.deepEqual([resolved.lat, resolved.lon], [30.27, -97.74]);
});

// ── D. osm-local monument snap ──────────────────────────────────────────────
// The sweep cache keys on ~1 km coord buckets, so every test here uses its own
// view-centre anchor (30.27 / 30.29 / 30.31 / …) to get a fresh bucket.

const MONUMENT_MARKER = 'historic"~"memorial';

test('geocoded monument snaps to the real OSM feature at the view centre', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['premise'], 'Alamo Cenotaph, Austin'),
    overpass: (ql) => {
      assert.match(ql, new RegExp(MONUMENT_MARKER));
      // One node with lat/lon and one way with only a `center` — both are valid features.
      return [
        nodeEl(1, 30.2680, -97.7420, { name: 'Alamo Cenotaph' }),
        { type: 'way', id: 2, tags: { name: 'Unrelated Fountain' }, center: { lat: 30.27, lon: -97.74 } },
      ];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.27, -97.74),
    target: 'Alamo Cenotaph',
  });
  assert.equal(resolved.source, 'osm-local', 'the geocode point is replaced by the real feature');
  assert.deepEqual([resolved.lat, resolved.lon], [30.2680, -97.7420]);
  assert.equal(resolved.label, 'Alamo Cenotaph');
  assert.equal(mocks.overpassBy(MONUMENT_MARKER).length, 1);
});

test('monument sweep miss keeps the geocode anchor and caches the feature set', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.29, -97.74, ['premise'], 'Lima Monument, Austin'),
    overpass: (ql) => (ql.includes(MONUMENT_MARKER)
      ? [nodeEl(1, 30.29, -97.74, { name: 'Something Else Entirely' })]
      : []),
  });
  const ask = () => resolveAnnotationTarget({ viewer: viewerAt(30.29, -97.74), target: 'Lima Monument' });
  assert.equal((await ask()).source, 'geocode', 'a sweep with no name match keeps the geocode anchor');
  assert.equal((await ask()).source, 'geocode');
  assert.equal(mocks.overpassBy(MONUMENT_MARKER).length, 1, 'the fetched feature set is cached');
});

test('a transient monument sweep is retried, never cached', async (t) => {
  let sweeps = 0;
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.31, -97.74, ['premise'], 'Mike Monument, Austin'),
    overpass: (ql) => {
      if (ql.includes(MONUMENT_MARKER)) { sweeps += 1; return { status: 500 }; }
      return [];
    },
  });
  const ask = () => resolveAnnotationTarget({ viewer: viewerAt(30.31, -97.74), target: 'Mike Monument' });
  assert.equal((await ask()).source, 'geocode');
  assert.equal((await ask()).source, 'geocode');
  assert.equal(sweeps, 2, 'a poisoned bucket would disable the snap for the session');
  assert.equal(mocks.overpassBy(MONUMENT_MARKER).length, 2);
});

test('empty sweep results cache as definitive (one query for the session)', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.33, -97.74, ['premise'], 'November Monument, Austin'),
    overpass: (ql) => (ql.includes(MONUMENT_MARKER) ? [] : []),
  });
  const ask = () => resolveAnnotationTarget({ viewer: viewerAt(30.33, -97.74), target: 'November Monument' });
  assert.equal((await ask()).source, 'geocode');
  assert.equal((await ask()).source, 'geocode');
  assert.equal(mocks.overpassBy(MONUMENT_MARKER).length, 1, 'a definitive empty sweep is cached');
});

test('concurrent monument asks share one in-flight sweep', async (t) => {
  let sweepCount = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.35, -97.74, ['premise'], 'Sig Monument, Austin'),
    overpass: (ql) => {
      if (ql.includes(MONUMENT_MARKER)) {
        sweepCount += 1;
        return gate.then(() => [nodeEl(1, 30.3480, -97.7420, { name: 'Sig Monument' })]);
      }
      return [];
    },
  });
  const viewer = viewerAt(30.35, -97.74);
  const p1 = resolveAnnotationTarget({ viewer, target: 'Sig Monument' });
  await new Promise((r) => setTimeout(r, 5));
  const p2 = resolveAnnotationTarget({ viewer, target: 'Sig Monument' });
  await new Promise((r) => setTimeout(r, 5));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(sweepCount, 1, 'the batch dedups to one Overpass query');
  assert.equal(r1.source, 'osm-local');
  assert.equal(r2.source, 'osm-local');
});

test('bare deictic asks never snap (empty query words)', async (t) => {
  const mocks = installResolverMocks(t, {
    places: () => ({ places: [] }),
    geocode: () => geocodeBody(30.37, -97.74, ['premise'], 'The Thing, Austin'),
    overpass: (ql) => (ql.includes(MONUMENT_MARKER) ? [nodeEl(1, 30.368, -97.742, { name: 'Omega Cenotaph' })] : []),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.37, -97.74),
    target: 'a b', // every word is ≤2 chars → no name to match with
    entityKind: 'point_feature',
  });
  assert.equal(resolved.source, 'geocode', 'no matchable words → keep the geocode anchor');
  assert.equal(mocks.overpassBy(MONUMENT_MARKER).length, 1, 'the sweep still ran');
});

// ── E. footprint scope ladder ───────────────────────────────────────────────

test('around_the_thing buffers the landmark instead of drawing its footprint', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['premise'], 'November Fountain, Austin'),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'November Fountain',
    intent: 'around_the_thing',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.synthesized, true, 'the around-disc is approximate by design');
  assert.equal(resolved.footprintKind, 'area');
  assert.equal(resolved.ring.length, 45, 'a 44-segment closed ring');
  const radiusM = ringRadiusM(resolved.ring, resolved.lat);
  assert.ok(Math.abs(radiusM - 400) < 1, `the around-buffer is 400 m, got ${radiusM.toFixed(1)}`);
  assert.equal(mocks.overpassCalls.length, 0, 'pure local math — no Overpass call');
});

test('explicit state ask traces the admin boundary (exact-name candidate wins)', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(31.0, -99.0, ['administrative_area_level_1', 'political'], 'Texas, USA'),
    overpass: (ql) => {
      if (ql.includes('is_in(')) {
        // A duplicate "<name> County"-style area and the real state — the exact-name
        // bonus must pick the real one.
        return [areaEl(2, 'Texas', 4), areaEl(1, 'Texas', 4)];
      }
      if (ql.includes('rel(pivot')) {
        const id = Number(/area\((\d+)\)/.exec(ql)[1]);
        return [relEl(id, 31.0, -99.0, 20_000, { boundary: 'administrative', name: 'Texas' })];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'state of Texas',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.synthesized, false);
  assert.equal(resolved.footprintKind, 'area');
  assert.ok(resolved.ring.length >= 4);
  assert.equal(mocks.overpassBy('is_in(').length, 1, 'the candidate sweep runs once');
  assert.equal(mocks.overpassBy('rel(pivot').length, 1, 'the exact-name candidate pivots first');
});

test('admin: no name match is a definitive miss that keeps the point', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['administrative_area_level_2', 'political'], 'Winterop County, USA'),
    overpass: (ql) => (ql.includes('is_in(') ? [areaEl(1, 'Harris', 3)] : []),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'county of Winterop',
    footprint: true,
  });
  assert.equal(resolved.source, 'geocode', 'the honest point beats a wrong-scope boundary');
  assert.equal(resolved.ring, null);
  assert.equal(mocks.overpassBy('rel(pivot').length, 0, 'no candidate ever pivots');
});

test('admin pivots fall through dead candidates to the first usable relation', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['administrative_area_level_2', 'political'], 'Delta County, USA'),
    overpass: (ql) => {
      if (ql.includes('is_in(')) return [areaEl(1, 'Delta County', 6), areaEl(2, 'Delta County', 6), areaEl(3, 'Delta County', 6)];
      if (ql.includes('rel(pivot')) {
        const id = Number(/area\((\d+)\)/.exec(ql)[1]);
        // Candidate 1: no relation backing. Candidate 2: incomplete geometry. Candidate 3: real.
        if (id === 1) return [];
        if (id === 2) {
          return [{
            type: 'relation',
            id: 2,
            members: [{ role: 'outer', geometry: [{ lat: 30.27, lon: -97.74 }, { lat: 30.28, lon: -97.74 }] }],
          }];
        }
        return [relEl(3, 30.27, -97.74, 2_000, { boundary: 'administrative', name: 'Delta County' })];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'county of Delta',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.ring.length, 5, 'the usable candidate closed its ring');
  assert.equal(mocks.overpassBy('rel(pivot').length, 3, 'both dead candidates were walked past');
});

test('admin: an oversized boundary for the scope is skipped for the next candidate', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['locality', 'political'], 'Epsilon, USA'),
    overpass: (ql) => {
      if (ql.includes('is_in(')) return [areaEl(1, 'Epsilon', 8), areaEl(2, 'Epsilon', 8)];
      if (ql.includes('rel(pivot')) {
        const id = Number(/area\((\d+)\)/.exec(ql)[1]);
        // Candidate 1 is 36,000 km² — wildly over the 9,000 km² city cap.
        return [id === 1
          ? relEl(1, 30.27, -97.74, 95_000, { boundary: 'administrative', name: 'Epsilon' })
          : relEl(2, 30.27, -97.74, 2_000, { boundary: 'administrative', name: 'Epsilon' })];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'Epsilon',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  const spanLon = resolved.ring[1][0] - resolved.ring[0][0];
  assert.ok(spanLon < 0.05, `the city-sized candidate won, span ${  (spanLon * 96_000).toFixed(0)  } m`);
  assert.equal(mocks.overpassBy('rel(pivot').length, 2, 'the oversized boundary was rejected before caching');
});

test('a 4,500-point country ring is pre-decimated before Douglas-Peucker', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(31.5, -99.5, ['administrative_area_level_1', 'political'], 'Zeta, USA'),
    overpass: (ql) => {
      if (ql.includes('is_in(')) return [areaEl(1, 'Zeta', 4)];
      if (ql.includes('rel(pivot')) {
        return [{
          type: 'relation',
          id: 1,
          members: [{ role: 'outer', geometry: circleGeometry(31.5, -99.5, 0.3, 4_500) }],
        }];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(AUSTIN.lat, AUSTIN.lon),
    target: 'state of Zeta',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.ok(resolved.ring.length > 3, 'the simplified ring still closes');
  assert.ok(resolved.ring.length < 4_500, 'the ring was decimated');
});

const NBHD_ANCHOR = { lat: 30.2764, lon: -97.7400 }; // Austin — outside the bundled SF pack

test('neighborhood ladder: admin miss → place miss → strict named landuse', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon, ['sublocality', 'political'], 'Rio Bravo, Austin'),
    overpass: (ql) => {
      if (ql.includes('is_in(')) return []; // no admin boundary at all
      if (ql.includes('boundary"="place')) return []; // no place= polygon
      if (ql.includes('["building"]')) {
        return [wayEl(1, NBHD_ANCHOR.lat, NBHD_ANCHOR.lon, 354, { landuse: 'residential', name: 'Rio Bravo District' })];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon),
    target: 'Rio Bravo',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.footprintKind, 'area');
  assert.equal(resolved.synthesized, false);
  assert.equal(mocks.overpassBy('["building"]').length, 1, 'strict mode found the district-sized landuse');
});

test('neighborhood ladder: strict miss → loose named park beats a synthesized disc', async (t) => {
  let sweepCount = 0;
  installResolverMocks(t, {
    geocode: () => geocodeBody(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon, ['sublocality', 'political'], 'Whiskey Hill, Austin'),
    overpass: (ql) => {
      if (ql.includes('is_in(') || ql.includes('boundary"="place')) return [];
      if (ql.includes('["building"]')) {
        sweepCount += 1;
        // Strict pass: nothing district-sized. Loose pass: a 0.26 km² named park
        // (Fort Mason shape) that the strict 0.3 km² floor rejects.
        return sweepCount === 1
          ? [wayEl(1, NBHD_ANCHOR.lat, NBHD_ANCHOR.lon, 15, { building: 'yes' })]
          : [wayEl(2, NBHD_ANCHOR.lat, NBHD_ANCHOR.lon, 255, { leisure: 'park', name: 'Whiskey Hill' })];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon),
    target: 'Whiskey Hill',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.synthesized, false, 'a real 0.26 km² park beats a buffered blob');
  assert.equal(resolved.footprintKind, 'area');
});

test('neighborhood ladder: strict + loose miss → synthesized neighborhood blob', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon, ['sublocality', 'political'], 'Xavier, Austin'),
    overpass: (ql) => (ql.includes('["building"]') ? [] : []),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon),
    target: 'Xavier',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.synthesized, true, 'both OSM rungs definitively empty → the honest blob');
  const radiusM = ringRadiusM(resolved.ring, resolved.lat);
  assert.ok(Math.abs(radiusM - 750) < 1, `neighborhood blob is 750 m, got ${radiusM.toFixed(1)}`);
});

test('neighborhood ladder: a loose BUILDING match is refused (honest point)', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon, ['sublocality', 'political'], 'Yankee, Austin'),
    overpass: (ql) => {
      if (ql.includes('is_in(') || ql.includes('boundary"="place')) return [];
      if (ql.includes('["building"]')) {
        return [wayEl(1, NBHD_ANCHOR.lat, NBHD_ANCHOR.lon, 15, { building: 'yes', name: 'Yankee Lofts' })];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon),
    target: 'Yankee',
    footprint: true,
  });
  assert.equal(resolved.source, 'geocode', 'a building must not stand in for a neighborhood');
  assert.equal(resolved.ring, null);
});

test('neighborhood ladder: a transient admin lookup aborts the ladder (retryable)', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon, ['sublocality', 'political'], 'Zulu, Austin'),
    overpass: (ql) => (ql.includes('is_in(') ? { status: 500 } : []),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(NBHD_ANCHOR.lat, NBHD_ANCHOR.lon),
    target: 'Zulu',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(resolved.ring, null);
  assert.equal(await resolved.resolveOutline(), undefined, 'transient ≠ definitive: the retry ladder stays open');
});

test('bundled SF pack resolves Marina District offline (no Overpass at all)', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(37.8066, -122.4392, ['sublocality', 'political'], 'Marina District, San Francisco'),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(37.8066, -122.4392),
    target: 'Marina District',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.synthesized, false, 'the bundled polygon is a REAL boundary');
  assert.ok(resolved.ring.length >= 4);
  const latMean = resolved.ring.reduce((sum, [, lat]) => sum + lat, 0) / resolved.ring.length;
  assert.ok(latMean > 37.78 && latMean < 37.83, `ring should sit in the Marina, got ${latMean.toFixed(3)}`);
  assert.equal(mocks.overpassCalls.length, 0, 'the offline pack resolves with zero network');
});

// ── street scope ────────────────────────────────────────────────────────────

const STREET_ANCHOR = { lat: 30.2700, lon: -97.7450 };

test('street: a same-named district wins (tier C)', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(STREET_ANCHOR.lat, STREET_ANCHOR.lon, ['route', 'political'], 'Zephyr Way, Austin'),
    overpass: (ql) => {
      if (ql.includes('city_block')) {
        return [wayEl(1, STREET_ANCHOR.lat, STREET_ANCHOR.lon, 158, { place: 'quarter', name: 'Zephyr District' })];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(STREET_ANCHOR.lat, STREET_ANCHOR.lon),
    target: 'Zephyr Way',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.footprintKind, 'area', 'a street resolves to an AREA, never a building');
  assert.equal(mocks.overpassBy('["highway"]["name"]').length, 0, 'tier C answered — tier F never ran');
});

test('street: falls back to a buffered corridor ribbon along the centerline', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(STREET_ANCHOR.lat, STREET_ANCHOR.lon, ['route', 'political'], 'Xenia Street, Austin'),
    overpass: (ql) => {
      if (ql.includes('city_block')) return [];
      if (ql.includes('["highway"]["name"]')) {
        // Two collinear segments that stitch into one 3-point centerline.
        const seg = (a, b) => [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }];
        return [
          { type: 'way', id: 1, tags: { highway: 'residential', name: 'Xenia Street' }, geometry: seg([30.26, -97.75], [30.261, -97.749]) },
          { type: 'way', id: 2, tags: { highway: 'residential', name: 'Xenia Street' }, geometry: seg([30.261, -97.749], [30.262, -97.748]) },
        ];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(STREET_ANCHOR.lat, STREET_ANCHOR.lon),
    target: 'Xenia Street',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.footprintKind, 'area');
  assert.ok(resolved.ring.length >= 6, `the corridor ribbon closed (${resolved.ring.length} points)`);
  assert.equal(mocks.overpassBy('["highway"]["name"]').length, 1);
});

test('street: definitive null vs transient undefined (per the ladder contract)', async (t) => {
  let transientAnchor = true;
  installResolverMocks(t, {
    geocode: () => geocodeBody(STREET_ANCHOR.lat, STREET_ANCHOR.lon, ['route', 'political'], 'Whitman Avenue, Austin'),
    overpass: (ql) => {
      if (ql.includes('city_block')) return transientAnchor ? { status: 500 } : [];
      return []; // tier F empty both times
    },
  });
  const transient = await resolveAnnotationTarget({
    viewer: viewerAt(STREET_ANCHOR.lat, STREET_ANCHOR.lon),
    target: 'Whitman Avenue',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(await transient.resolveOutline(), undefined, 'a tier-C HTTP 500 is transient');
  transientAnchor = false;
  const definitive = await resolveAnnotationTarget({
    viewer: viewerAt(STREET_ANCHOR.lat, STREET_ANCHOR.lon),
    target: 'Whitman Avenue',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(await definitive.resolveOutline(), null, 'both tiers empty → definitively no polygon');
});

// ── grounds scope ───────────────────────────────────────────────────────────
// The enclosing-sweep cache keys on ~1 km coord buckets — one anchor per test.

test('grounds: a building ask upgrades to the real enclosing polygon', async (t) => {
  const anchor = { lat: 30.2800, lon: -97.7300 };
  installResolverMocks(t, {
    places: () => ({ places: [] }),
    geocode: () => geocodeBody(anchor.lat, anchor.lon, ['premise'], 'Iota Capitol, Austin'),
    overpass: (ql) => {
      if (ql.includes('["building"]')) {
        return [wayEl(1, anchor.lat, anchor.lon, 15, { building: 'yes', name: 'Iota Capitol' })];
      }
      if (ql.includes('["leisure"]["name"]')) {
        return [wayEl(2, anchor.lat, anchor.lon, 158, { leisure: 'park', name: 'Iota Capitol Square' })];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(anchor.lat, anchor.lon),
    target: 'Iota Capitol grounds',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.footprintKind, 'area');
  assert.equal(resolved.synthesized, false, 'the real grounds polygon, not the dome, not a disc');
  const spanM = (resolved.ring[1][0] - resolved.ring[0][0]) * 111_320 * Math.cos((resolved.lat * Math.PI) / 180);
  assert.ok(Math.abs(spanM - 316) < 5, `the square grounds polygon won (span ${spanM.toFixed(0)} m)`);
});

test('grounds: no enclosing polygon → viewport-sized synthesized disc', async (t) => {
  const BOUNDS = {
    southwest: { lat: 30.26, lng: -97.75 },
    northeast: { lat: 30.28, lng: -97.73 },
  };
  const sizedAnchor = { lat: 30.2600, lon: -97.7100 };
  const plainAnchor = { lat: 30.2500, lon: -97.7000 };
  installResolverMocks(t, {
    places: () => ({ places: [] }),
    geocode: (url) => {
      const q = new URL(url).searchParams.get('address');
      // First ask carries a geocode viewport; the second does not.
      return q.startsWith('Juliet')
        ? geocodeBody(sizedAnchor.lat, sizedAnchor.lon, ['premise'], 'Juliet Capitol, Austin', { bounds: BOUNDS })
        : geocodeBody(plainAnchor.lat, plainAnchor.lon, ['premise'], 'Kilo Capitol, Austin');
    },
    overpass: (ql) => (ql.includes('["leisure"]["name"]') ? [] : []),
  });
  const sized = await resolveAnnotationTarget({
    viewer: viewerAt(sizedAnchor.lat, sizedAnchor.lon),
    target: 'Juliet Capitol grounds',
    footprint: true,
  });
  assert.equal(sized.synthesized, true);
  assert.ok(sized.viewport, 'the Places/geocode viewport is carried through');
  const r1 = ringRadiusM(sized.ring, sized.lat);
  assert.ok(Math.abs(r1 - 1200) < 1, `a ~2.9 km viewport clamps to the 1200 m max, got ${r1.toFixed(0)}`);

  const plain = await resolveAnnotationTarget({
    viewer: viewerAt(plainAnchor.lat, plainAnchor.lon),
    target: 'Kilo Capitol grounds',
    footprint: true,
  });
  assert.equal(plain.viewport, null);
  const r2 = ringRadiusM(plain.ring, plain.lat);
  assert.ok(Math.abs(r2 - 300) < 1, `no viewport → the 300 m default disc, got ${r2.toFixed(0)}`);
});

test('grounds: transient enclosing sweep keeps the point retryable (never the dome)', async (t) => {
  const anchor = { lat: 30.2700, lon: -97.7200 };
  installResolverMocks(t, {
    places: () => ({ places: [] }),
    geocode: () => geocodeBody(anchor.lat, anchor.lon, ['premise'], 'Hotel Capitol, Austin'),
    overpass: (ql) => {
      if (ql.includes('["building"]')) {
        return [wayEl(1, anchor.lat, anchor.lon, 15, { building: 'yes', name: 'Hotel Capitol' })];
      }
      return { status: 500 }; // enclosing sweep transient
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(anchor.lat, anchor.lon),
    target: 'Hotel Capitol grounds',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(resolved.ring, null);
  assert.equal(await resolved.resolveOutline(), undefined, 'retryable — never the bare building shape');
});

// ── scope sanity + drift ────────────────────────────────────────────────────

test('an oversized footprint for the asked scope is dropped (scope sanity)', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['premise'], 'Victor Plaza, Austin', { noComponents: true }),
    overpass: (ql) => (ql.includes('["building"]')
      ? [wayEl(1, 30.27, -97.74, 707, { landuse: 'retail', name: 'Victor Plaza District' })]
      : []),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.27, -97.74),
    target: 'Victor Plaza',
    footprint: true,
  });
  assert.equal(resolved.source, 'geocode', 'a 2 km² area is not a building — the point stays');
  assert.equal(resolved.ring, null);
});

test('a footprint centroid beyond the proximity gate is dropped', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['premise'], 'Wilco Plaza, Austin'),
    overpass: (ql) => (ql.includes('["building"]')
      ? [wayEl(1, 30.27, -96.84, 200, { leisure: 'park', name: 'Wilco Plaza' })] // ~87 km east
      : []),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.27, -97.74),
    target: 'Wilco Plaza',
    footprint: true,
  });
  assert.equal(resolved.source, 'geocode', 'the anchor passed the gate, the polygon did not');
  assert.equal(resolved.ring, null);
});

// ── F. Overpass throttle + body-error mapping ───────────────────────────────

test('Overpass throttles and body-level errors map to the tri-state contract', async (t) => {
  // Always one minute in the future: a hardcoded HTTP-date is a time bomb
  // that detonates the moment the suite runs past it (this one did).
  const FUT = new Date(Date.now() + 60_000).toUTCString();
  const retry = (v) => ({ get: (k) => (String(k).toLowerCase() === 'retry-after' ? v : null) });
  // One anchor per scenario — 30.271 + (n-1)·0.001, all explicit coords so no
  // geocoder runs and the footprint cache keys stay disjoint.
  const scenarios = new Map([
    [1, { status: 429, headers: retry('7') }],
    [2, { status: 429, headers: retry(FUT) }],
    [3, { status: 429, headers: retry('soon') }],
    [4, { status: 503, headers: retry('5') }],
    [5, { status: 503 }],
    [6, { remark: 'runtime error: server timed out' }],
    [7, { status: 500 }],
    [8, { status: 429, headers: retry('9') }],
  ]);
  installResolverMocks(t, {
    overpass: (ql) => {
      const lat = Number(firstAroundCoords(ql).split(',')[0]);
      return scenarios.get(Math.round((lat - 30.271) / 0.001) + 1) ?? [];
    },
  });
  const ask = (n, defer = true) => resolveAnnotationTarget({
    viewer: viewerAt(30.27, -97.74),
    latitude: 30.271 + (n - 1) * 0.001,
    longitude: -97.74,
    footprint: true,
    deferFootprint: defer,
  });
  assert.deepEqual(await (await ask(1)).resolveOutline(), { rateLimited: true, retryAfterMs: 7_000 });
  const dateBased = await (await ask(2)).resolveOutline();
  assert.equal(dateBased.rateLimited, true);
  assert.ok(dateBased.retryAfterMs > 0, 'an HTTP-date Retry-After converts to a positive delay');
  assert.deepEqual(
    await (await ask(3)).resolveOutline(),
    { rateLimited: true, retryAfterMs: null },
    'an unparseable header yields a null delay',
  );
  assert.deepEqual(
    await (await ask(4)).resolveOutline(),
    { rateLimited: true, retryAfterMs: 5_000 },
    '503 + Retry-After throttles too',
  );
  assert.equal(await (await ask(5)).resolveOutline(), undefined, '503 without Retry-After is plain transient');
  assert.equal(await (await ask(6)).resolveOutline(), undefined, 'a 200 body with a runtime-error remark is transient');
  assert.equal(await (await ask(7)).resolveOutline(), undefined, 'a plain 500 is transient');
  // Inline path: a throttle never poisons the anchor either.
  const inline = await ask(8, false);
  assert.equal(inline.source, 'coordinate');
  assert.equal(inline.ring, null, 'the inline anchor survives a throttled outline');
});

test('an Overpass timeout aborts the in-flight fetch (transient undefined)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] }); // setTimeout also intercepts clearTimeout
  installResolverMocks(t, {
    overpass: (ql, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('client timeout')));
    }),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.27, -97.74),
    latitude: 30.29,
    longitude: -97.74,
    footprint: true,
    deferFootprint: true,
  });
  const pending = resolved.resolveOutline();
  // resolveOutline awaits the Natural Earth rung before reaching the Overpass
  // fetch — yield one macrotask so the abort timer exists on the mock clock.
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(15_000);
  assert.equal(await pending, undefined, 'the 12 s budget fired and the fetch aborted');
  t.mock.timers.reset();
});

// ── G. progressive outline ──────────────────────────────────────────────────

test('deferFootprint returns the anchor now and the outline later (cached)', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['premise'], 'Acorn Hall, Austin'),
    overpass: (ql) => (ql.includes('["building"]')
      ? [wayEl(1, 30.27, -97.74, 15, { building: 'yes', name: 'Acorn Hall', height: '15 m' })]
      : []),
  });
  const anchor = await resolveAnnotationTarget({
    viewer: viewerAt(30.27, -97.74),
    target: 'Acorn Hall',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(anchor.ring, null, 'the anchor draws immediately');
  assert.equal(anchor.source, 'geocode');
  assert.equal(typeof anchor.resolveOutline, 'function');
  const patch = await anchor.resolveOutline();
  assert.equal(patch.ring.length, 5);
  assert.equal(patch.footprintKind, 'building');
  assert.equal(patch.buildingHeight, 15);
  assert.equal(patch.synthesized, false);
  await anchor.resolveOutline();
  assert.equal(mocks.overpassBy('["building"]').length, 1, 'the upgrade is served from the footprint cache');
});

// ── H. analyst region-ring entry point ──────────────────────────────────────

test('resolveRegionRingForQuery: empty name → null', async () => {
  assert.equal(await resolveRegionRingForQuery('   '), null);
});

test('resolveRegionRingForQuery: Natural Earth multi-ring region → largest ring', async (t) => {
  const mocks = installResolverMocks(t, {});
  const ring = await resolveRegionRingForQuery('Andes');
  assert.ok(ring, 'the Andes resolve offline');
  assert.equal(ring.name, 'Andes');
  assert.ok(ring.ring.length >= 3);
  assert.equal(mocks.overpassCalls.length, 0);
});

test('resolveRegionRingForQuery: non-admin geocode → honest null', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['premise'], 'Bravopolis, Texas'),
  });
  assert.equal(await resolveRegionRingForQuery('Bravopolis'), null, 'a building is not a region');
  assert.equal(mocks.overpassCalls.length, 0, 'the scope gate rejects before any Overpass call');
});

test('resolveRegionRingForQuery: admin geocode → boundary ring (or honest null)', async (t) => {
  let empty = false;
  installResolverMocks(t, {
    geocode: (url) => {
      const q = new URL(url).searchParams.get('address');
      return geocodeBody(40.0, -83.0, ['administrative_area_level_1', 'political'], `${q}, USA`);
    },
    overpass: (ql) => {
      if (ql.includes('is_in(')) return empty ? [] : [areaEl(1, 'Ohio', 4)];
      if (ql.includes('rel(pivot')) return [relEl(1, 40.0, -83.0, 20_000, { boundary: 'administrative', name: 'Ohio' })];
      return [];
    },
  });
  const ohio = await resolveRegionRingForQuery('Ohio');
  assert.ok(ohio);
  assert.equal(ohio.name, 'Ohio');
  assert.ok(ohio.ring.length >= 4);
  empty = true;
  assert.equal(await resolveRegionRingForQuery('Nevada'), null, 'no boundary → honest null');
});

// ── I. placesNearViewRecovery ───────────────────────────────────────────────

test('placesNearViewRecovery: near geocode is kept; no view centre → null', async () => {
  const viewer = viewerAt(AUSTIN.lat, AUSTIN.lon);
  assert.equal(
    await placesNearViewRecovery(viewer, 'the capitol', { lat: 30.27, lon: -97.74 }),
    null,
    'a near geocode is not recovered away',
  );
  assert.equal(await placesNearViewRecovery({}, 'the capitol', null), null, 'no view centre → no recovery');
});

test('placesNearViewRecovery: far/absent geocode recovers via Places within bound', async (t) => {
  installResolverMocks(t, {
    places: (url) => {
      const q = new URL(`http://x${  url}`).searchParams.get('q');
      if (q === 'alpha recovery') return PLACES_HIT(30.2747, -97.7404, 'Alpha Capitol');
      if (q === 'bravo recovery') return PLACES_HIT(30.35, -97.74, 'Far Capitol');
      throw new Error('places proxy offline');
    },
  });
  const viewer = viewerAt(AUSTIN.lat, AUSTIN.lon);
  const hit = await placesNearViewRecovery(viewer, 'alpha recovery', { lat: 31.5, lon: -97.74 });
  assert.ok(hit, 'a far geocode recovers from Places');
  assert.equal(hit.label, 'Alpha Capitol');
  assert.equal(
    await placesNearViewRecovery(viewer, 'bravo recovery', { lat: 31.5, lon: -97.74 }),
    null,
    'a Places hit beyond the trust bound is not trusted',
  );
  assert.equal(
    await placesNearViewRecovery(viewer, 'charlie recovery', null),
    null,
    'a throwing Places proxy recovers nothing',
  );
});

// ── J. viewport helpers + ground/building height ────────────────────────────

test('viewportBias: rectangle → bounds string; null/NaN/throw → null', () => {
  const rect = () => Cesium.Rectangle.fromDegrees(-97.8, 30.2, -97.7, 30.3);
  assert.equal(viewportBias({ camera: { computeViewRectangle: rect } }), '30.2000,-97.8000|30.3000,-97.7000');
  assert.equal(viewportBias({ camera: { computeViewRectangle: () => null } }), null);
  assert.equal(viewportBias({ camera: { computeViewRectangle: () => ({ south: Number.NaN, west: 0, north: 0, east: 0 }) } }), null);
  assert.equal(viewportBias({ camera: { computeViewRectangle() { throw new Error('no scene'); } } }), null);
  assert.equal(viewportBias({}), null);
});

test('a hostile camera cannot break the anchor path (viewportProximity catch)', async () => {
  const resolved = await resolveAnnotationTarget({
    viewer: { camera: { get positionCartographic() { throw new Error('no carto'); } } },
    latitude: 30.27,
    longitude: -97.74,
  });
  assert.ok(resolved, 'explicit coords anchor without any camera');
  assert.equal(resolved.source, 'coordinate');
  assert.equal(resolved.height, 0);
});

test('ground height: clampToHeight wins; a throw falls to the globe; no globe → 0', async () => {
  const clamped = {
    scene: {
      clampToHeightSupported: true,
      clampToHeight: () => Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 42),
    },
  };
  const h1 = await resolveAnnotationTarget({ viewer: clamped, latitude: 30.27, longitude: -97.74 });
  assert.ok(Math.abs(h1.height - 42) < 1e-4, `clampToHeight height, got ${h1.height}`);

  const throwing = {
    scene: {
      clampToHeightSupported: true,
      clampToHeight: () => { throw new Error('tiles not ready'); },
      globe: { getHeight: () => 7 },
    },
  };
  const h2 = await resolveAnnotationTarget({ viewer: throwing, latitude: 30.27, longitude: -97.74 });
  assert.equal(h2.height, 7, 'a throwing clamp falls through to the globe');

  const bare = { scene: {} };
  const h3 = await resolveAnnotationTarget({ viewer: bare, latitude: 30.27, longitude: -97.74 });
  assert.equal(h3.height, 0, 'no clamp support and no globe → ellipsoid 0');
});

test('building height falls back to levels×3.3+roof when tags omit height', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.27, -97.74, ['premise'], 'Victor Lofts, Austin'),
    overpass: (ql) => (ql.includes('["building"]')
      ? [wayEl(1, 30.27, -97.74, 15, { building: 'yes', name: 'Victor Lofts', 'building:levels': '3', 'roof:height': '2' })]
      : []),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.27, -97.74),
    target: 'Victor Lofts',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.ok(Math.abs(resolved.buildingHeight - 11.9) < 1e-9, `levels fallback, got ${resolved.buildingHeight}`);
});

// ── K. relation stitching + ladder tails (final gap closure) ────────────────

test('a multipolygon relation stitches split outer ways into the largest closed ring', async (t) => {
  // Three disjoint closed squares delivered as scrambled way fragments. Stitching
  // must chain each square from its pieces (head/tail attach in all four
  // orientations), then pick the largest closed component by AREA.
  const P1 = { lat: 30.4200, lon: -97.7000 };
  const P2 = { lat: 30.4200, lon: -97.6980 };
  const P3 = { lat: 30.4220, lon: -97.6980 };
  const P4 = { lat: 30.4220, lon: -97.7000 };
  const R1 = { lat: 30.4350, lon: -97.7150 };
  const R2 = { lat: 30.4350, lon: -97.7100 };
  const R3 = { lat: 30.4400, lon: -97.7100 };
  const R4 = { lat: 30.4400, lon: -97.7150 };
  const S1 = { lat: 30.4120, lon: -97.7080 };
  const S2 = { lat: 30.4120, lon: -97.7072 };
  const S3 = { lat: 30.4128, lon: -97.7072 };
  const S4 = { lat: 30.4128, lon: -97.7080 };
  const OUTER = 'outer';
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.4375, -97.7125, ['locality', 'political'], 'Theta, USA'),
    overpass: (ql) => {
      if (ql.includes('is_in(')) return [areaEl(1, 'Theta', 8)];
      if (ql.includes('rel(pivot')) {
        return [{
          type: 'relation',
          id: 1,
          members: [
            // Square A (mid-sized): built via a head-attach (reverse-prepend) and a tail-attach.
            { role: OUTER, geometry: [P2, P3] }, // chain head — attach at its head, reversed tail → prepend
            { role: OUTER, geometry: [P2, P1] }, // head of chain == this head → prepend-reverse branch
            { role: OUTER, geometry: [P3, P4, P1] }, // tail of chain == this head → forward tail-append
            // Square B (largest): tail-attach against a REVERSED fragment.
            { role: OUTER, geometry: [R1, R2, R3] },
            { role: OUTER, geometry: [R1, R4, R3] }, // given reversed — tail matches its LAST point
            // Square C (smallest): another reversed-prepend attach.
            { role: OUTER, geometry: [S2, S3] },
            { role: OUTER, geometry: [S1, S2] },
            { role: OUTER, geometry: [S3, S4, S1] },
          ],
        }];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.4375, -97.7125),
    target: 'Theta',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.footprintKind, 'area');
  assert.equal(resolved.ring.length, 5, 'the largest square closed into a 4-corner ring');
  const lons = resolved.ring.map(([lon]) => lon);
  const lats = resolved.ring.map(([, lat]) => lat);
  assert.ok(Math.abs(Math.min(...lons) - R1.lon) < 1e-6
    && Math.abs(Math.max(...lons) - R2.lon) < 1e-6
    && Math.abs(Math.min(...lats) - R1.lat) < 1e-6
    && Math.abs(Math.max(...lats) - R3.lat) < 1e-6,
  'the LARGEST square won, not the first-stitched one');
});

test('neighborhood ladder: a strong admin match IS the neighborhood (place= skipped)', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.2860, -97.7300, ['sublocality', 'political'], 'Kilo, Austin'),
    overpass: (ql) => {
      if (ql.includes('is_in(')) return [areaEl(1, 'Kilo', 9)];
      if (ql.includes('rel(pivot')) return [relEl(1, 30.2860, -97.7300, 450, { boundary: 'administrative', name: 'Kilo' })];
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.2860, -97.7300),
    target: 'Kilo',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.synthesized, false, 'the admin boundary itself is the neighborhood');
  assert.equal(resolved.ring.length, 5);
  assert.equal(mocks.overpassBy('boundary"="place').length, 0,
    'full-coverage admin match → the place= leg is never consulted');
});

test('neighborhood ladder: a transient strict-landuse sweep keeps the point retryable', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.2930, -97.7260, ['sublocality', 'political'], 'Mike, Austin'),
    overpass: (ql) => {
      if (ql.includes('is_in(')) return []; // definitively no admin polygon
      if (ql.includes('boundary"="place')) return []; // definitively no place polygon
      if (ql.includes('["building"]')) return { status: 500 }; // strict sweep → transient
      return [];
    },
  });
  const anchor = await resolveAnnotationTarget({
    viewer: viewerAt(30.2930, -97.7260),
    target: 'Mike',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(await anchor.resolveOutline(), undefined,
    'transient strict sweep → retryable, never a definitive miss');
  assert.equal(mocks.overpassBy('["building"]').length, 1, 'the ladder stopped at the strict rung');
});

test('admin pivot: a transient relation lookup is retryable, not a definitive miss', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.3000, -97.7150, ['locality', 'political'], 'November, USA'),
    overpass: (ql) => {
      if (ql.includes('is_in(')) return [areaEl(1, 'November', 8)];
      if (ql.includes('rel(pivot')) return { status: 500 }; // pivot fetch → network blip
      return [];
    },
  });
  const anchor = await resolveAnnotationTarget({
    viewer: viewerAt(30.3000, -97.7150),
    target: 'November',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(await anchor.resolveOutline(), undefined, 'a blipped pivot must not neg-cache');
});

// An oversized neighborhood admin + the post-loop place= recovery legs.
const oversizedPivotHandler = (name, placeOutcome) => (ql) => {
  if (ql.includes('is_in(')) return [areaEl(1, name, 9)];
  if (ql.includes('rel(pivot')) return [relEl(1, 30.3100, -97.7000, 15_000, { boundary: 'administrative', name: 'Oscar' })];
  if (ql.includes('boundary"="place')) {
    if (typeof placeOutcome === 'function') return placeOutcome(ql);
    return placeOutcome;
  }
  return [];
};

const placeHitFixture = (name, anchor, halfM = 400) => {
  const big = { type: 'way', id: 40, tags: { place: 'neighbourhood', name }, geometry: circleGeometry(anchor.lat, anchor.lon, 0.4, 8) };
  return [
    { type: 'way', id: 41, tags: { place: 'neighbourhood', name }, geometry: [{ lat: anchor.lat, lon: anchor.lon }, { lat: anchor.lat + 0.001, lon: anchor.lon }] }, // <3 coords → skipped
    wayEl(42, anchor.lat, anchor.lon, 500, { place: 'neighbourhood', name: 'Unrelated' }), // no word overlap → skipped
    wayEl(43, anchor.lat, anchor.lon, 500, { place: 'neighbourhood', name: `${name} Point` }), // 0.5 coverage < 0.6 → skipped
    big, // ~1.7e9 m² > the 80 km² neighborhood cap → skipped
    wayEl(44, anchor.lat, anchor.lon, halfM, { place: 'neighbourhood', name }), // the winner
  ];
};

test('an oversized neighborhood admin consults place= and adopts its polygon', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.3100, -97.7000, ['sublocality', 'political'], 'Oscar, Austin'),
    overpass: oversizedPivotHandler('Oscar', placeHitFixture('Oscar', { lat: 30.3100, lon: -97.7000 })),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.3100, -97.7000),
    target: 'Oscar',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.synthesized, false, 'the place= polygon is a real boundary');
  const radiusM = ringRadiusM(resolved.ring, resolved.lat);
  assert.ok(Math.abs(radiusM - 400) < 2, `the winning place polygon is the 800 m one, got ${radiusM.toFixed(0)}`);
  assert.equal(mocks.overpassBy('boundary"="place').length, 1);
});

test('an oversized neighborhood admin with a transient place= stays retryable', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.3200, -97.6900, ['sublocality', 'political'], 'Papa, Austin'),
    overpass: oversizedPivotHandler('Papa', { status: 500 }),
  });
  const anchor = await resolveAnnotationTarget({
    viewer: viewerAt(30.3200, -97.6900),
    target: 'Papa',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(await anchor.resolveOutline(), undefined, 'transient place= → retry, never a cached wrong blob');
});

test('an oversized neighborhood admin with no place= is a definitive miss', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.3300, -97.6800, ['sublocality', 'political'], 'Quebec, Austin'),
    overpass: oversizedPivotHandler('Quebec', []),
  });
  const anchor = await resolveAnnotationTarget({
    viewer: viewerAt(30.3300, -97.6800),
    target: 'Quebec',
    footprint: true,
    deferFootprint: true,
  });
  const outcome = await anchor.resolveOutline();
  assert.equal(outcome?.synthesized, true,
    'no admin AND no place polygon → the ladder falls through to the honest blob');
});

// A pivot whose relation exists but is geometrically incomplete → the POST-LOOP
// neighborhood place= consultation (distinct from the oversized in-loop one above).
const degeneratePivotHandler = (name, placeOutcome) => (ql) => {
  if (ql.includes('is_in(')) return [areaEl(1, name, 9)];
  if (ql.includes('rel(pivot')) {
    return [{
      type: 'relation',
      id: 1,
      members: [{ role: 'outer', geometry: [{ lat: 30.34, lon: -97.67 }, { lat: 30.341, lon: -97.671 }] }],
    }]; // <3 coords → unusable → the candidate loop exhausts
  }
  if (ql.includes('boundary"="place')) {
    if (typeof placeOutcome === 'function') return placeOutcome(ql);
    return placeOutcome;
  }
  return [];
};

test('a dead pivot falls through to the post-loop place= consultation (hit)', async (t) => {
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.3400, -97.6700, ['sublocality', 'political'], 'Romeo, Austin'),
    overpass: degeneratePivotHandler('Romeo', placeHitFixture('Romeo', { lat: 30.3400, lon: -97.6700 })),
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.3400, -97.6700),
    target: 'Romeo',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.synthesized, false);
  assert.equal(mocks.overpassBy('boundary"="place').length, 1, 'place= ran AFTER the pivot loop died');
});

test('a dead pivot: post-loop place= transient → undefined, definitive miss → blob', async (t) => {
  const mocksA = installResolverMocks(t, {
    geocode: () => geocodeBody(30.3500, -97.6600, ['sublocality', 'political'], 'Sierra, Austin'),
    overpass: degeneratePivotHandler('Sierra', { status: 503 }),
  });
  const transient = await resolveAnnotationTarget({
    viewer: viewerAt(30.3500, -97.6600),
    target: 'Sierra',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(await transient.resolveOutline(), undefined, 'post-loop transient place= → retry');
  assert.equal(mocksA.overpassBy('rel(pivot').length, 1, 'the pivot ran before place=');
  assert.equal(mocksA.overpassBy('boundary"="place').length, 1, 'place= consulted after the loop died');

  installResolverMocks(t, {
    geocode: () => geocodeBody(30.3600, -97.6500, ['sublocality', 'political'], 'Tango, Austin'),
    overpass: degeneratePivotHandler('Tango', []),
  });
  const definitive = await resolveAnnotationTarget({
    viewer: viewerAt(30.3600, -97.6500),
    target: 'Tango',
    footprint: true,
    deferFootprint: true,
  });
  const blob = await definitive.resolveOutline();
  assert.equal(blob?.synthesized, true, 'post-loop definitive place= miss → the ladder synthesizes');
  const radiusM = ringRadiusM(blob.ring, blob.lat);
  assert.ok(Math.abs(radiusM - 750) < 1, `the honest 750 m blob, got ${radiusM.toFixed(1)}`);
});

test('a live external abort propagates into the in-flight Overpass fetch', async (t) => {
  const capturedSignals = [];
  const ac = new AbortController();
  const mocks = installResolverMocks(t, {
    geocode: () => geocodeBody(30.2980, -97.7220, ['sublocality', 'political'], 'Whiskey, Austin'),
    overpass: (ql, opts) => {
      if (ql.includes('is_in(')) {
        capturedSignals.push(opts.signal);
        // Behave like fetch: the abort rejects the in-flight body.
        return new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      }
      return [];
    },
  });
  const anchor = await resolveAnnotationTarget({
    viewer: viewerAt(30.2980, -97.7220),
    target: 'Whiskey',
    footprint: true,
    deferFootprint: true,
    signal: ac.signal,
  });
  const pending = anchor.resolveOutline(); // the deferred ladder starts the candidate sweep
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r)); // geocode hop → sweep dispatch
  assert.equal(capturedSignals.length, 1, 'the candidate sweep is in flight');
  assert.equal(capturedSignals[0].aborted, false);
  ac.abort();
  assert.equal(capturedSignals[0].aborted, true, 'the external abort reached the internal controller');
  assert.equal(await pending, undefined, 'aborted mid-flight → honest transient');
  assert.equal(mocks.overpassBy('rel(pivot').length, 0, 'nothing downstream ran after the abort');
});

test('street tier F stitches scrambled fragments and drops the unrelated way', async (t) => {
  installResolverMocks(t, {
    geocode: () => geocodeBody(30.5500, -97.7600, ['route', 'political'], 'Golf Street, Austin'),
    overpass: (ql) => {
      if (ql.includes('city_block')) return [];
      if (ql.includes('["highway"]["name"]')) {
        const seg = (a, b) => [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }];
        const A = [30.5500, -97.7600];
        const B = [30.5500, -97.7580];
        const C = [30.5500, -97.7560];
        const D = [30.5520, -97.7600];
        const E = [30.5540, -97.7600];
        return [
          { type: 'way', id: 1, tags: { highway: 'residential', name: 'Golf Street' }, geometry: seg(A, B) },
          // Given tail-first so it can only attach by REVERSING onto the line's tail.
          { type: 'way', id: 2, tags: { highway: 'residential', name: 'Golf Street' }, geometry: seg(C, B) },
          // Attaches at the line's HEAD, same orientation → prepend the reversed rest.
          { type: 'way', id: 3, tags: { highway: 'residential', name: 'Golf Street' }, geometry: seg(A, D) },
          // Attaches at the line's HEAD, reversed orientation → prepend as-is.
          { type: 'way', id: 4, tags: { highway: 'residential', name: 'Golf Street' }, geometry: seg(E, D) },
          // Same name but no shared endpoint → left unstitched, out of the corridor.
          { type: 'way', id: 5, tags: { highway: 'residential', name: 'Golf Street' }, geometry: seg([30.5600, -97.7500], [30.5610, -97.7510]) },
        ];
      }
      return [];
    },
  });
  const resolved = await resolveAnnotationTarget({
    viewer: viewerAt(30.5500, -97.7600),
    target: 'Golf Street',
    footprint: true,
  });
  assert.equal(resolved.source, 'footprint');
  assert.equal(resolved.footprintKind, 'area');
  assert.ok(resolved.ring.length >= 10, `a 5-point centerline doubles into the ribbon (${resolved.ring.length} pts)`);
  const maxLon = Math.max(...resolved.ring.map(([lon]) => lon));
  assert.ok(maxLon < -97.7555, `the corridor hugs the stitched line (max lon ${maxLon.toFixed(4)}) — the far way was dropped`);
});
