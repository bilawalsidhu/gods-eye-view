import { createStandalonePlaceSearch } from '../standalone/placeSearch.js';
import { createPlaceSearch } from '../search/placeSearch.js';
// Footprint-selection contract tests — pure fixtures, no network, no browser.
//
// Locks the field-test-7 monument fix (docs/field-test-rootcause-2026-06-30.md §1):
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
import {
  resolveAnnotationTarget as resolveTarget,
  selectFootprint,
  refineScope,
  isGroundsLikeAsk,
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
  assert.ok(Math.abs(lat0 - ANCHOR_ON_WATER.lat) < 0.02, 'ring at ' + lat0);
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

// The Capitol geocoder response contains its coordinates but only ADDRESS names.
// Synthetic footprints reproduce the real Capitol/YOTEL selection without live APIs.
const CAPITOL_ANCHOR = { lat: 38.8899389, lon: -77.0090505 };
function capitolViewer() {
  return { camera: { positionCartographic: {
    latitude: CAPITOL_ANCHOR.lat * Math.PI / 180,
    longitude: CAPITOL_ANCHOR.lon * Math.PI / 180,
    height: 1000,
  } } };
}
function installCapitolMocks(t, elements, components = [
  { long_name: 'Washington', types: ['locality', 'political'] },
  { long_name: 'Capitol Hill', types: ['neighborhood', 'political'] },
]) {
  installGoogleMocks(t, async (url) => {
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      return { json: async () => ({ status: 'OK', results: [{
        formatted_address: 'Washington, DC 20004, USA',
        types: ['establishment', 'landmark', 'point_of_interest', 'tourist_attraction'],
        address_components: components,
        geometry: { location: { lat: CAPITOL_ANCHOR.lat, lng: CAPITOL_ANCHOR.lon } },
      }] }) };
    }
    assert.equal(String(url), '/api/overpass');
    return { ok: true, status: 200, json: async () => ({ elements }) };
  });
}

for (const [target, deferFootprint] of [
  ['United States Capitol', true],
  ['United States Capitol, Washington, DC', false],
]) {
  test(`address-only geocode retains landmark identity: ${target}`, async t => {
    const capitol = squareWay(CAPITOL_ANCHOR, 0, 0, 20000, { building: 'yes', name: 'United States Capitol' });
    const hotel = squareWay(CAPITOL_ANCHOR, 620, -140, 3000, { building: 'yes', tourism: 'hotel', name: 'YOTEL Washington DC' });
    installCapitolMocks(t, [hotel, capitol]);
    const result = await resolveAnnotationTarget({ viewer: capitolViewer(), target, entityKind: 'building', footprint: true, deferFootprint });
    assert.ok(result);
    const outline = deferFootprint ? await result.resolveOutline() : result;
    assert.deepEqual(outline.ring, capitol.geometry.map(p => [p.lon, p.lat]));
    assert.equal(outline.footprintKind, 'building');
  });
}

test('address-only landmark without a matching outline keeps its geocoded point', async t => {
  const hotel = squareWay(CAPITOL_ANCHOR, 620, -140, 3000, { building: 'yes', tourism: 'hotel', name: 'YOTEL Washington DC' });
  installCapitolMocks(t, [hotel]);
  const result = await resolveAnnotationTarget({ viewer: capitolViewer(), target: 'US Capitol building, Washington', entityKind: 'building', footprint: true, deferFootprint: true });
  assert.ok(result);
  assert.deepEqual([result.lat, result.lon], [CAPITOL_ANCHOR.lat, CAPITOL_ANCHOR.lon]);
  assert.equal(await result.resolveOutline(), null);
});

test('missing address components do not turn a formatted city address into the landmark name', async t => {
  const capitol = squareWay(CAPITOL_ANCHOR, 0, 0, 20000, { building: 'yes', name: 'United States Capitol' });
  const hotel = squareWay(CAPITOL_ANCHOR, 620, -140, 3000, { building: 'yes', name: 'YOTEL Washington DC' });
  installCapitolMocks(t, [hotel, capitol], []);
  const result = await resolveAnnotationTarget({ viewer: capitolViewer(), target: 'United States Capitol building', footprint: true });
  assert.deepEqual(result.ring, capitol.geometry.map(p => [p.lon, p.lat]));
});

test('a genuine geocoded feature name still canonicalizes an alternate user name', async t => {
  const capitol = squareWay(CAPITOL_ANCHOR, 0, 0, 20000, { building: 'yes', name: 'United States Capitol' });
  const decoy = squareWay(CAPITOL_ANCHOR, 620, -140, 3000, { building: 'yes', name: 'Congress meeting building' });
  installCapitolMocks(t, [decoy, capitol], [{ long_name: 'United States Capitol', types: ['landmark'] }]);
  const result = await resolveAnnotationTarget({ viewer: capitolViewer(), target: 'Congress meeting building', footprint: true });
  assert.deepEqual(result.ring, capitol.geometry.map(p => [p.lon, p.lat]));
});

// ── Keyless geocoding ────────────────────────────────────────────────────────
//
// `geocodePlace` was Google-only: no key returned null, and so did a key whose
// Geocoding API is not enabled (Google answers HTTP 200 with REQUEST_DENIED).
// Either way the annotation silently failed to place. Both now fall through to
// Photon. These drive the second case, because it reaches the SAME fallback
// through a running Google branch — the no-key branch cannot be driven from
// `node --test`, since the key expression reads `import.meta.env`, which only
// Vite defines.

/** Photon's GeoJSON shape, trimmed to the properties the adapter consumes. */
function photonFeature({ name, lat, lon, tags = {}, extent = null, ...rest }) {
  return {
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { name, ...tags, ...rest, ...(extent ? { extent } : {}) },
  };
}

const GOOGLE_FOUND_NOTHING = { ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) };

test('keyless: a key that geocodes to nothing still anchors the annotation', async (t) => {
  const requests = [];
  installGoogleMocks(t, async (url) => {
    requests.push(String(url));
    if (String(url).startsWith('https://maps.googleapis.com/')) return GOOGLE_FOUND_NOTHING;
    return {
      ok: true,
      json: async () => ({
        features: [photonFeature({
          name: 'Lady Bird Lake',
          lat: 30.25,
          lon: -97.73,
          city: 'Austin',
          state: 'Texas',
          country: 'United States',
          tags: { osm_key: 'natural', osm_value: 'water' },
          // Photon orders extent [west, north, east, south] — a naive [w,s,e,n]
          // read would invert the box and still look like a valid viewport.
          extent: [-97.8, 30.28, -97.68, 30.24],
        })],
      }),
    };
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'Lady Bird Lake',
  });

  assert.ok(resolved, 'a Google miss must not leave the annotation unplaced');
  assert.equal(resolved.source, 'geocode');
  assert.deepEqual([resolved.lat, resolved.lon], [30.25, -97.73]);
  // The label is shortened the same way a Google `formatted_address` is.
  assert.equal(resolved.label, 'Lady Bird Lake');
  // Photon's extent reaches the framing code in the Places `{low,high}` shape,
  // right way up — this is what sizes a grounds disc and the flyTo box.
  assert.deepEqual(resolved.viewport, {
    low: { latitude: 30.24, longitude: -97.8 },
    high: { latitude: 30.28, longitude: -97.68 },
  });
  // Google is asked first and exactly once; one Photon call answers it.
  assert.equal(requests.filter((url) => url.includes('maps.googleapis.com')).length, 1);
  assert.equal(requests.filter((url) => url.includes('photon.komoot.io')).length, 1);
});

test('keyless: OSM matching uses the feature\'s canonical name, not the user\'s words', async (t) => {
  // The reason `primaryName` is carried out of Photon at all. The ask names a
  // landmark AND its surroundings; the geocoded feature is called just "Tejano
  // Monument". Score the OSM candidates on the raw utterance and the locality
  // tokens win — this is the Thompson-Austin bug (field test 7) reached through
  // the keyless path. Score them on the canonical name and the monument wins.
  const decoy = squareWay(ANCHOR, -250, -250, 3000, {
    building: 'yes', tourism: 'hotel', name: 'Texas Capitol Austin Visitor Center',
  });
  const monument = squareWay(ANCHOR, 5, 5, 300, { tourism: 'artwork', name: 'Tejano Monument' });

  installGoogleMocks(t, async (url, init) => {
    const href = String(url);
    if (href.startsWith('https://maps.googleapis.com/')) return GOOGLE_FOUND_NOTHING;
    if (href.startsWith('/api/google/text-search')) return { ok: true, json: async () => ({ places: [] }) };
    if (href.startsWith('https://photon.komoot.io/')) {
      return {
        ok: true,
        json: async () => ({
          features: [photonFeature({
            name: 'Tejano Monument',
            lat: ANCHOR.lat,
            lon: ANCHOR.lon,
            city: 'Austin',
            tags: { osm_key: 'historic', osm_value: 'memorial' },
          })],
        }),
      };
    }
    assert.equal(href, '/api/overpass');
    assert.equal(init?.method, 'POST');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ elements: [decoy, monument] }) };
  });

  const resolved = await resolveAnnotationTarget({
    viewer: closeViewportViewer(),
    target: 'the monument near the Texas Capitol, Austin',
    footprint: true,
  });

  assert.ok(resolved.ring, 'the monument polygon is monument-scale and exactly named — it must outline');
  // The anchor re-centres on the chosen polygon, so its position IS the verdict:
  // the monument sits on the anchor, the decoy 354 m south-west of it.
  assert.ok(
    approximateMetres(resolved.lat, resolved.lon, ANCHOR.lat, ANCHOR.lon) < 50,
    `outlined a polygon ${Math.round(approximateMetres(resolved.lat, resolved.lon, ANCHOR.lat, ANCHOR.lon))} m from the monument`,
  );
});

/** Metres between two coordinates — enough precision for a few hundred metres. */
function approximateMetres(lat1, lon1, lat2, lon2) {
  const mLat = 111320;
  const dy = (lat1 - lat2) * mLat;
  const dx = (lon1 - lon2) * mLat * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

test('keyless: a Photon outage is not remembered as "no such place"', async (t) => {
  // Google answering ZERO_RESULTS is a verdict about GOOGLE. Photon holds
  // plenty of places Google does not — that asymmetry is why this fallback
  // exists — so a Google verdict plus a Photon timeout must leave the query
  // open. Caching it would keep an annotation unplaceable for the rest of the
  // session, on a network that has since recovered.
  const photonUp = {
    ok: true,
    json: async () => ({
      features: [photonFeature({
        name: 'Waller Creek', lat: 30.2665, lon: -97.7385, city: 'Austin',
        tags: { osm_key: 'waterway', osm_value: 'stream' },
      })],
    }),
  };
  let photonReachable = false;
  const requests = [];
  installGoogleMocks(t, async (url) => {
    requests.push(String(url));
    if (String(url).startsWith('https://maps.googleapis.com/')) return GOOGLE_FOUND_NOTHING;
    if (!photonReachable) throw new Error('network down');
    return photonUp;
  });

  const target = 'Waller Creek';
  assert.equal(await resolveAnnotationTarget({ viewer: closeViewportViewer(), target }), null);
  const duringOutage = requests.length;

  photonReachable = true;
  const retried = await resolveAnnotationTarget({ viewer: closeViewportViewer(), target });

  assert.ok(retried, 'the same target must resolve once the network is back');
  assert.deepEqual([retried.lat, retried.lon], [30.2665, -97.7385]);
  assert.ok(
    requests.length > duringOutage,
    'the retry was served from a poisoned cache instead of asking again',
  );
});

test('a not-found is remembered only when every source consulted gave a verdict', async () => {
  // The full truth table, because the no-key row is the one the behavioural
  // tests above cannot reach: `import.meta.env` only exists under Vite, so
  // `node --test` can never take the branch that skips Google entirely.
  const cases = [
    // no key: Photon is the only source, so Photon alone decides
    [{ googleConsulted: false, photonAnswered: true }, true],
    [{ googleConsulted: false, photonAnswered: false }, false],
    // with a key: Google must have said "no such place", AND Photon must have replied
    [{ googleConsulted: true, googleSaysNoSuchPlace: true, photonAnswered: true }, true],
    [{ googleConsulted: true, googleSaysNoSuchPlace: true, photonAnswered: false }, false],
    // Google declined (REQUEST_DENIED / OVER_QUERY_LIMIT) — never a verdict
    [{ googleConsulted: true, googleSaysNoSuchPlace: false, photonAnswered: true }, false],
    [{ googleConsulted: true, googleSaysNoSuchPlace: false, photonAnswered: false }, false],
  ];
  for (const [sources, expected] of cases) {
    const providers = [sources.googleConsulted ? Boolean(sources.googleSaysNoSuchPlace) : true, sources.photonAnswered]
      .map((answered) => ({ geocode: async () => ({ place: null, answered }) }));
    assert.equal((await createPlaceSearch({ providers }).geocode('miss')).answered, expected, JSON.stringify(sources));
  }
  // An omitted Google verdict defaults to "did not say no such place".

});

function resolveAnnotationTarget(options) {
  return resolveTarget({ placeSearch: createStandalonePlaceSearch({ resolveApiKey: () => globalThis.window?.__GOOGLE_MAPS_API_KEY__ }), ...options });
}
