// Pure round-trip + fail-closed tests for the annotation <-> GeoJSON interchange.
// Run with: npm test   (node --test). No framework, no Cesium, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotationToFeature,
  featureToAnnotation,
  annotationsToFeatureCollection,
  featureCollectionToAnnotations,
} from './annotationGeoJson.js';

// A round-trip preserves the semantic fields (transient render state is intentionally not carried).
const roundTrip = (anno) => featureToAnnotation(annotationToFeature(anno));

test('point (pin/highlight/label) round-trips, height preserved', () => {
  const pin = { type: 'pin', id: 'anno-1', label: 'ILM', color: 'primary', ttlMs: null,
    anchor: { lon: -77.9, lat: 34.27, height: 12 }, to: null, ring: null };
  const f = annotationToFeature(pin);
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [-77.9, 34.27, 12]);
  assert.equal(f.properties['gev:type'], 'pin');
  assert.deepEqual(roundTrip(pin), pin);

  const hl = { type: 'highlight', id: 'anno-2', label: 'spot', color: 'amber', ttlMs: 30000,
    anchor: { lon: 2.29, lat: 48.85 }, to: null, ring: null };
  assert.deepEqual(roundTrip(hl), hl); // no height -> 2D position
});

test('area polygon round-trips: ring closed in GeoJSON, un-closed on import; centroid preserved', () => {
  const area = { type: 'area', id: 'anno-3', label: 'Marina', color: 'primary', ttlMs: null,
    anchor: { lon: -122.434, lat: 37.804 }, to: null,
    ring: [[-122.44, 37.80], [-122.43, 37.81], [-122.42, 37.80], [-122.43, 37.79]],
    footprintKind: 'area', buildingHeight: null, synthesized: false };
  const f = annotationToFeature(area);
  assert.equal(f.geometry.type, 'Polygon');
  const gjRing = f.geometry.coordinates[0];
  assert.equal(gjRing.length, 5); // 4 vertices + explicit closing point
  assert.deepEqual(gjRing[0], gjRing.at(-1)); // closed
  assert.deepEqual(f.properties['gev:anchor'], [-122.434, 37.804]);
  assert.deepEqual(roundTrip(area), area); // ring back to 4, anchor from gev:anchor
});

test('synthesized + building props are preserved', () => {
  const synth = { type: 'area', id: 'anno-4', label: 'around', color: 'primary', ttlMs: null,
    anchor: { lon: -97.74, lat: 30.27 }, to: null,
    ring: [[-97.75, 30.27], [-97.74, 30.28], [-97.73, 30.27]],
    footprintKind: 'area', buildingHeight: null, synthesized: true };
  const f = annotationToFeature(synth);
  assert.equal(f.properties['gev:synthesized'], true);
  assert.equal(roundTrip(synth).synthesized, true);

  const bldg = { type: 'area', id: 'anno-5', label: 'Pentagon', color: 'primary', ttlMs: null,
    anchor: { lon: -77.056, lat: 38.871 }, to: null,
    ring: [[-77.057, 38.870], [-77.055, 38.872], [-77.054, 38.870]],
    footprintKind: 'building', buildingHeight: 24, synthesized: false };
  assert.equal(roundTrip(bldg).footprintKind, 'building');
  assert.equal(roundTrip(bldg).buildingHeight, 24);
});

test('a hand-authored polygon with no gev:anchor falls back to the ring mean', () => {
  // Importers other than this app (a hand-written fixture, a GIS export) have
  // no `gev:anchor`; the anchor must be DERIVED, not left undefined.
  const handDrawn = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] },
    properties: { 'gev:type': 'area', 'gev:id': 'hand-1', 'gev:label': 'Quad' },
  };
  const anno = featureToAnnotation(handDrawn);
  assert.ok(anno, 'a valid closed polygon imports');
  // The GeoJSON closing duplicate is dropped BEFORE the mean, so the 5th
  // position does not bias the centroid toward the first vertex.
  assert.deepEqual(anno.anchor, { lon: 1, lat: 1 });
  assert.deepEqual(anno.ring, [[0, 0], [2, 0], [2, 2], [0, 2]]);
  // Re-exporting the import now carries the derived anchor, so the round trip
  // is stable from the second generation on.
  assert.deepEqual(annotationToFeature(anno).properties['gev:anchor'], [1, 1]);

  // An unparseable `gev:anchor` falls back the same way instead of throwing.
  const badAnchor = structuredClone(handDrawn);
  badAnchor.properties['gev:anchor'] = ['not', 'a number'];
  assert.deepEqual(featureToAnnotation(badAnchor).anchor, { lon: 1, lat: 1 });
});

test('route path round-trips with mode/distance/duration', () => {
  const path = [{ lon: -122.4, lat: 37.7, height: 5 }, { lon: -122.39, lat: 37.71, height: 6 }, { lon: -122.38, lat: 37.72, height: 7 }];
  const route = { type: 'route', id: 'anno-6', label: '590 m · 8 min', color: 'primary', ttlMs: null,
    anchor: { lon: -122.4, lat: 37.7, height: 5 }, to: null, ring: null,
    path, mode: 'foot', distanceM: 590, durationS: 480, fallback: false };
  const f = annotationToFeature(route);
  assert.equal(f.geometry.type, 'LineString');
  assert.equal(f.geometry.coordinates.length, 3);
  assert.deepEqual(roundTrip(route), route);
});

test('arrow round-trips (anchor -> to)', () => {
  const arrow = { type: 'arrow', id: 'anno-7', label: '2 km', color: 'primary', ttlMs: null,
    anchor: { lon: -122.43, lat: 37.80, height: 3 }, to: { lon: -122.40, lat: 37.81, height: 4 }, ring: null };
  const f = annotationToFeature(arrow);
  assert.equal(f.geometry.type, 'LineString');
  assert.equal(f.geometry.coordinates.length, 2);
  assert.deepEqual(roundTrip(arrow), arrow);
});

test('degenerate area (no ring) -> Point, round-trips', () => {
  const ptArea = { type: 'area', id: 'anno-8', label: 'X', color: 'primary', ttlMs: null,
    anchor: { lon: 10, lat: 20 }, to: null, ring: null, footprintKind: null, buildingHeight: null, synthesized: false };
  const f = annotationToFeature(ptArea);
  assert.equal(f.geometry.type, 'Point');
  const back = roundTrip(ptArea);
  assert.equal(back.type, 'area');
  assert.equal(back.ring, null);
  assert.deepEqual(back.anchor, { lon: 10, lat: 20 });
});

test('FeatureCollection round-trips a mixed set', () => {
  const annos = [
    { type: 'pin', id: 'a', label: 'p', color: 'primary', ttlMs: null, anchor: { lon: 1, lat: 2 }, to: null, ring: null },
    { type: 'area', id: 'b', label: 'q', color: 'amber', ttlMs: null, anchor: { lon: 3, lat: 4 }, to: null,
      ring: [[3, 4], [4, 5], [5, 4]], footprintKind: 'area', buildingHeight: null, synthesized: false },
  ];
  const fc = annotationsToFeatureCollection(annos);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 2);
  assert.deepEqual(featureCollectionToAnnotations(fc), annos);
});

test('malformed input fails CLOSED (returns null / skips)', () => {
  assert.equal(featureToAnnotation(null), null);
  assert.equal(featureToAnnotation({}), null);
  assert.equal(featureToAnnotation({ type: 'NotAFeature' }), null);
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }), null); // no gev:type
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { 'gev:type': 'route' } }), null); // route needs LineString
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }, properties: { 'gev:type': 'arrow' } }), null); // arrow needs exactly 2
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }, properties: { 'gev:type': 'area' } }), null); // <4 positions
  assert.equal(featureToAnnotation({ type: 'Feature', geometry: { type: 'Point', coordinates: ['x', 0] }, properties: { 'gev:type': 'pin' } }), null); // non-finite
  // unknown type on the annotation side too
  assert.equal(annotationToFeature({ type: 'blob', anchor: { lon: 0, lat: 0 } }), null);
  assert.equal(annotationToFeature(null), null);
  // collection helpers never throw on junk
  assert.deepEqual(featureCollectionToAnnotations({ type: 'X' }), []);
  assert.deepEqual(annotationsToFeatureCollection('nope'), { type: 'FeatureCollection', features: [] });
});

// --- Branch floor (cycle 4): the coercion edges the round-trips skip ---------

test('nullish optional fields survive as null; absent ids/labels default', () => {
  // ttlMs 0 is a REAL value (expire immediately) — ?? must keep it, not null it.
  const pin = { type: 'pin', id: 'x', label: 'L', color: 'primary', ttlMs: 0,
    anchor: { lon: 1, lat: 2 } };
  assert.equal(annotationToFeature(pin).properties['gev:ttlMs'], 0);
  assert.equal(roundTrip(pin).ttlMs, 0);
  // A mark with none of the optional fields carries explicit nulls.
  const bare = annotationToFeature({ type: 'label', anchor: { lon: 5, lat: 6 } });
  assert.equal(bare.properties['gev:id'], null);
  assert.equal(bare.properties['gev:label'], null);
  assert.equal(featureToAnnotation(bare).color, 'primary', 'import defaults the color');
});

test('height handling: non-finite heights degrade to 2D on both sides', () => {
  // NaN height is treated as absent, not carried as NaN.
  assert.deepEqual(annotationToFeature({ type: 'pin', anchor: { lon: 1, lat: 2, height: Number.NaN } })
    .geometry.coordinates, [1, 2]);
  assert.deepEqual(featureToAnnotation({
    type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2, Number.NaN] },
    properties: { 'gev:type': 'pin' },
  }).anchor, { lon: 1, lat: 2 });
  assert.equal(featureToAnnotation({
    type: 'Feature', geometry: { type: 'Point', coordinates: [1] }, properties: { 'gev:type': 'pin' },
  }), null, 'a one-element position has no latitude');
});

test('route and arrow reject degenerate geometry on export', () => {
  // A route with fewer than two valid vertices fails, including after junk filtering.
  assert.equal(annotationToFeature({ type: 'route', path: [] }), null);
  assert.equal(annotationToFeature({ type: 'route', path: [{ lon: 1, lat: 2 }] }), null);
  assert.equal(annotationToFeature({ type: 'route', path: [{ lon: 'x', lat: 2 }, { lon: 1, lat: 2 }] }), null,
    'junk vertices are filtered before the length check, not padded');
  assert.equal(annotationToFeature({ type: 'route', path: 'corrupt' }), null);
  // An arrow with a broken tip fails closed.
  assert.equal(annotationToFeature({ type: 'arrow', anchor: { lon: 1, lat: 2 }, to: null }), null);
  assert.equal(annotationToFeature({ type: 'arrow', anchor: null, to: { lon: 1, lat: 2 } }), null);
});

test('area export validates every ring vertex and closes open rings', () => {
  // One malformed vertex fails the WHOLE area, not just that vertex.
  assert.equal(annotationToFeature({
    type: 'area',
    ring: [[0, 0], [1, 0], [null, 1]],
  }), null);
  // An open ring gains the closing duplicate exactly once.
  const f = annotationToFeature({
    type: 'area',
    ring: [[0, 0], [4, 0], [4, 4], [0, 4]],
  });
  assert.equal(f.geometry.coordinates[0].length, 5);
  assert.deepEqual(f.geometry.coordinates[0].at(-1), [0, 0]);
  // An already-closed ring is NOT double-closed.
  const closed = annotationToFeature({
    type: 'area',
    ring: [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
  });
  assert.equal(closed.geometry.coordinates[0].length, 5);
  // A two-vertex ring is below the polygon minimum -> the Point fallback,
  // which requires an anchor: without one the mark is unpublishable.
  assert.equal(annotationToFeature({ type: 'area', ring: [[0, 0], [1, 1]] }), null,
    'a degenerate area with no anchor exports nothing');
  assert.equal(annotationToFeature({
    type: 'area', ring: [[0, 0], [1, 1]], anchor: { lon: 0.5, lat: 0.5 },
  }).geometry.type, 'Point');
});

test('area import drops the closing duplicate only above the triangle floor', () => {
  // Exactly the 4-position closed triangle: pop would leave 3 < … wait — the
  // pop requires length > 3, so the minimum closed triangle KEEPS its duplicate
  // only when dropping it would go below 3; 4 positions → drop → 3. Pinned:
  const tri = featureToAnnotation({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] },
    properties: { 'gev:type': 'area' },
  });
  assert.deepEqual(tri.ring, [[0, 0], [1, 0], [0, 1]], 'the closing duplicate is dropped at the minimum');
  // A polygon whose ring is malformed inside fails closed.
  assert.equal(featureToAnnotation({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], ['x', 0], [0, 1], [0, 0]]] },
    properties: { 'gev:type': 'area' },
  }), null);
  // A Polygon carrying a non-area type is a mismatch.
  assert.equal(featureToAnnotation({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] },
    properties: { 'gev:type': 'pin' },
  }), null);
  // A degenerate area Point imports with its area fields pinned.
  const pt = featureToAnnotation({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { 'gev:type': 'area', 'gev:synthesized': true, 'gev:footprintKind': 'area' },
  });
  assert.equal(pt.synthesized, true);
  assert.equal(pt.buildingHeight, null, 'a point area has no building height');
  // Geometry the declared type never uses fails closed.
  assert.equal(featureToAnnotation({
    type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[0, 0]] },
    properties: { 'gev:type': 'label' },
  }), null);
});

test('route import carries the fallback flag and rejects malformed vertices', () => {
  assert.equal(featureToAnnotation({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], ['x', 1]] },
    properties: { 'gev:type': 'route' },
  }), null, 'one malformed vertex fails the route');
  const out = featureToAnnotation({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    properties: { 'gev:type': 'route', 'gev:fallback': 1 },
  });
  assert.equal(out.fallback, true, 'truthy flags coerce');
  assert.equal(out.anchor, out.path[0], 'a route anchors at its first path vertex');
});

test('route/arrow optional fields default when absent', () => {
  // A route without mode/distance/duration carries explicit nulls.
  const bare = annotationToFeature({ type: 'route', path: [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }] });
  assert.equal(bare.properties['gev:mode'], null);
  assert.equal(bare.properties['gev:distanceM'], null);
  assert.equal(bare.properties['gev:durationS'], null);
  // A distance of 0 is a real value — ?? keeps it.
  const zeroed = annotationToFeature({
    type: 'route', path: [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }], distanceM: 0, durationS: 0,
  });
  assert.equal(zeroed.properties['gev:distanceM'], 0);
  assert.equal(zeroed.properties['gev:durationS'], 0);
  // Arrow import rejects either broken endpoint.
  assert.equal(featureToAnnotation({
    type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], ['x', 1]] },
    properties: { 'gev:type': 'arrow' },
  }), null);
  // ringCentroid degrades to null for junk rings.
  const noAnchor = featureToAnnotation({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] },
    properties: { 'gev:type': 'area' },
  });
  assert.deepEqual(noAnchor.anchor, { lon: 1 / 3, lat: 1 / 3 });
});
