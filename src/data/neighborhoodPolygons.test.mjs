// src/data/neighborhoodPolygons.test.mjs — pins the bundled DataSF "Analysis
// Neighborhoods" dataset (PDDL 1.0, see local_data/neighborhoods/SOURCE.md) and
// its resolution contract through the source-agnostic loader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupNeighborhoodRing } from './neighborhoodPolygons.js';

const FILE = new URL('./local_data/neighborhoods/san-francisco.json', import.meta.url);

// SF proper + Treasure Island; generous but excludes everything non-SF.
const SF_BOUNDS = { west: -122.55, south: 37.70, east: -122.35, north: 37.84 };

function eachRing(geometry, fn) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) for (const ring of poly) fn(ring);
}

test('SF neighborhoods file parses with the expected DataSF shape', () => {
  const fc = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.city, 'San Francisco');
  // DataSF Analysis Neighborhoods is exactly 41 areas (dataset j2bu-swwd).
  assert.equal(fc.features.length, 41);
  for (const f of fc.features) {
    const name = f.properties && f.properties.name;
    assert.ok(typeof name === 'string' && name.trim().length > 0,
      `every feature has a non-empty properties.name (got ${JSON.stringify(name)})`);
    assert.ok(f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
      `${name}: geometry is Polygon|MultiPolygon`);
    eachRing(f.geometry, (ring) => {
      assert.ok(ring.length >= 4, `${name}: ring has >= 4 points`);
      const [f0, l0] = [ring[0], ring.at(-1)];
      assert.ok(f0[0] === l0[0] && f0[1] === l0[1], `${name}: ring is closed`);
      for (const [lon, lat] of ring) {
        assert.ok(lon >= SF_BOUNDS.west && lon <= SF_BOUNDS.east
          && lat >= SF_BOUNDS.south && lat <= SF_BOUNDS.north,
          `${name}: coordinate [${lon}, ${lat}] inside SF bounds`);
      }
    });
  }
});

test('the five demo neighborhoods resolve to real polygons through the loader', async () => {
  const cases = [
    // [lat, lon, geocoder-style query, expected dataset name]
    [37.7941, -122.4078, 'Chinatown', 'Chinatown'],
    [37.8021, -122.4369, 'Marina District', 'Marina'],
    [37.7599, -122.4148, 'Mission District', 'Mission'],
    [37.7989, -122.4662, 'Presidio', 'Presidio'],
    [37.7785, -122.4056, 'South of Market', 'South of Market'],
  ];
  for (const [lat, lon, query, expected] of cases) {
    const hit = await lookupNeighborhoodRing(lat, lon, query);
    assert.ok(hit, `${query} must resolve`);
    assert.equal(hit.name, expected);
    assert.ok(Array.isArray(hit.ring) && hit.ring.length >= 4,
      `${query}: real ring, not a synthesized disc (got ${hit.ring && hit.ring.length} pts)`);
    for (const [rlon, rlat] of hit.ring) {
      assert.ok(rlon >= SF_BOUNDS.west && rlon <= SF_BOUNDS.east
        && rlat >= SF_BOUNDS.south && rlat <= SF_BOUNDS.north,
        `${query}: ring stays inside SF bounds`);
    }
  }
});

test('name specificity: Presidio vs Presidio Heights, Mission vs Outer Mission', async () => {
  // "Presidio Heights" must NOT collapse onto the (larger) Presidio.
  const heights = await lookupNeighborhoodRing(37.7886, -122.4531, 'Presidio Heights');
  assert.equal(heights?.name, 'Presidio Heights');
  // Bare "Mission" query must not match "Outer Mission"/"Mission Bay".
  const mission = await lookupNeighborhoodRing(37.7599, -122.4148, 'Mission');
  assert.equal(mission?.name, 'Mission');
});

test('points outside covered cities / unmatched names return null', async () => {
  // Austin, TX — outside every bundled city bbox.
  assert.equal(await lookupNeighborhoodRing(30.2672, -97.7431, 'Downtown'), null);
  // Inside SF but a name the dataset does not carry — no point-in-polygon fallback.
  assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, 'Zilker Park'), null);
});

test('taxonomy aliases: old names reach the renamed DataSF polygon', async () => {
  // DataSF renamed "Financial District" → "Financial District/South Beach";
  // the word-subset matcher alone can never bridge that (P0-2 alias map).
  const fidi = await lookupNeighborhoodRing(37.7946, -122.3999, 'Financial District');
  assert.equal(fidi?.name, 'Financial District/South Beach');
  // Colloquial "Downtown" (in SF) maps to the same polygon.
  const downtown = await lookupNeighborhoodRing(37.7946, -122.3999, 'Downtown');
  assert.equal(downtown?.name, 'Financial District/South Beach');
  // "Downtown/Civic Center" deliberately has NO alias — the taxonomy split it,
  // and a confident wrong polygon would block the live resolver ladder.
  assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, 'Downtown/Civic Center'), null);
});

// --- Branch floor (cycle 4): geometry kernels and pack degradation -----------

import { __internals } from './neighborhoodPolygons.js';

const { normalize, pointInRing, toPolygons, containingOuterRing, largestOuterRing, cityLoaders } = __internals;

test('the normalize key folds case, punctuation, and whitespace runs to single spaces', () => {
  assert.equal(normalize('Financial District/South Beach'), 'financial district south beach');
  assert.equal(normalize('  Mission\tDistrict  '), 'mission district');
  assert.equal(normalize('Outer---Mission'), 'outer mission');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '', 'null input is an empty key, not a crash');
});

test('pointInRing is a real ray-cast: edges, vertices, and outside all classify', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInRing(5, 5, square), true);
  assert.equal(pointInRing(15, 5, square), false);
  assert.equal(pointInRing(-1, -1, square), false);
  // A concave notch is honored — a bbox test would misclassify this point.
  // The notch vertex (6,4) pulls the top boundary DOWN into the polygon, so
  // the region above the V (like (5,7)) is a bite taken OUT of the shape.
  const notched = [[0, 0], [10, 0], [10, 10], [6, 4], [2, 10], [0, 10]];
  assert.equal(pointInRing(5, 3, notched), true, 'below the notch is inside');
  assert.equal(pointInRing(5, 7, notched), false, 'inside the notch bite is outside');
});

test('toPolygons folds geometry variants; junk degrades to an empty set', () => {
  const poly = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
  assert.deepEqual(toPolygons({ type: 'Polygon', coordinates: poly }), [poly]);
  assert.deepEqual(toPolygons({ type: 'MultiPolygon', coordinates: [poly] }), [poly]);
  assert.deepEqual(toPolygons({ type: 'LineString', coordinates: [] }), [],
    'an unsupported geometry type carries no polygons');
  assert.deepEqual(toPolygons(null), []);
  assert.deepEqual(toPolygons(undefined), []);
});

test('containingOuterRing honors holes and skips degenerate parts', () => {
  const degenerate = { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0]]] } };
  assert.equal(containingOuterRing(degenerate, 0.5, 0.5), null,
    'a 2-vertex ring is degenerate, not a boundary');
  const withHole = {
    geometry: {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]], // hole
      ],
    },
  };
  assert.ok(containingOuterRing(withHole, 1, 1), 'inside the outer ring → returned');
  assert.equal(containingOuterRing(withHole, 5, 5), null, 'inside the hole → null');
  assert.equal(containingOuterRing({ geometry: null }, 1, 1), null);
});

test('largestOuterRing picks the part with the most vertices across a MultiPolygon', () => {
  const small = [[0, 0], [1, 0], [1, 1], [0, 0]];
  const big = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 1], [0, 0]];
  // GeoJSON nesting: a polygon is [ring, …holes], a MultiPolygon is [polygon, …].
  assert.deepEqual(largestOuterRing({ type: 'MultiPolygon', coordinates: [[small], [big]] }), big);
  assert.deepEqual(largestOuterRing({ type: 'Polygon', coordinates: [big] }), big);
  // The degeneracy guard lives in containingOuterRing, not here: any
  // non-empty ring counts as usable for the name-match fallback.
  assert.deepEqual(largestOuterRing({ type: 'Polygon', coordinates: [[[0, 0]]] }), [[0, 0]]);
  assert.equal(largestOuterRing({ type: 'Polygon', coordinates: [] }), null,
    'a polygon with no rings at all has no fallback ring');
  assert.equal(largestOuterRing(null), null);
});

test('an empty or punctuation-only name in a covered city resolves to null', async () => {
  // Inside SF: the name gate runs before any polygon work.
  assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, ''), null);
  assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, '///'), null,
    'a name with no word characters has an empty match key');
  assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, null), null);
});

test('a failed or malformed city pack degrades to null once, without poisoning the memo', async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    // Swap the memoized pack for a rejecting one and re-resolve.
    cityLoaders.delete('san-francisco');
    cityLoaders.set('san-francisco', async () => { throw new Error('chunk gone'); });
    assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, 'Chinatown'), null,
      'a failed pack looks like no coverage to the caller');
    assert.ok(warnings.some((args) => String(args[0]).includes('san-francisco pack unavailable')),
      'the degradation warns once, out loud');
    // A pack whose payload is malformed degrades to an empty feature set.
    cityLoaders.delete('san-francisco');
    cityLoaders.set('san-francisco', async () => ({ features: 'corrupt' }));
    assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, 'Chinatown'), null);
    // Features without names, unusable geometry, or no containing ring are skipped.
    cityLoaders.delete('san-francisco');
    cityLoaders.set('san-francisco', async () => ({
      features: [
        { properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
        { properties: { name: 'No Geometry' } },
        {
          properties: { name: 'Far Away' },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
        },
        {
          properties: { name: 'Chinatown Annex' },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
        },
      ],
    }));
    assert.equal(await lookupNeighborhoodRing(37.7793, -122.4193, 'Chinatown'), null,
      'name matches with no real geometry resolve to null, not a wrong polygon');
  } finally {
    // Restore the real pack for any later lookups in this process.
    cityLoaders.delete('san-francisco');
    console.warn = warn;
  }
  const restored = await lookupNeighborhoodRing(37.7793, -122.4193, 'Chinatown');
  assert.equal(restored?.name, 'Chinatown', 'the real pack re-memoizes after the swap');
});
