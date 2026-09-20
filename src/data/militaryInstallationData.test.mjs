import test from 'node:test';
import assert from 'node:assert/strict';
import {
  humanizeInstallationClass,
  isValidInstallationBoundingBox,
  normalizeMilitaryInstallations,
} from './militaryInstallationData.js';

test('normalizes allowed OSM installation features and deduplicates ids', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    { type: 'way', id: 7, center: { lat: 12, lon: 77 }, tags: { military: 'airfield', name: 'Example' }, geometry: [{ lat: 12, lon: 77 }, { lat: 12.1, lon: 77 }, { lat: 12, lon: 77.1 }] },
    { type: 'way', id: 7, center: { lat: 12, lon: 77 }, tags: { military: 'airfield' } },
    { type: 'node', id: 8, lat: 0, lon: 179.9, tags: { landuse: 'military' } },
  ] }, '2026-07-21T00:00:00.000Z');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].class, 'airfield');
  assert.deepEqual(result.records[0].footprint[0], [77, 12]);
  assert.equal(result.records[1].longitude, 179.9);
  assert.equal(result.droppedCount, 1);
});

test('drops malformed and unsupported OSM features', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    { type: 'node', id: 1, lat: 95, lon: 0, tags: { military: 'range' } },
    { type: 'node', id: 2, lat: 1, lon: 2, tags: { military: 'radar' } },
    // Not one of node/way/relation: Overpass areas carry no placeable centre.
    { type: 'area', id: 3, lat: 1, lon: 2, tags: { military: 'airfield' } },
    // A non-safe-integer id cannot form a stable `osm:<type>:<id>` key.
    { type: 'way', id: 4.5, center: { lat: 1, lon: 2 }, tags: { military: 'range' } },
    { type: 'node', lat: 1, lon: 2, tags: { military: 'range' } },
  ] });
  assert.deepEqual(result.records, []);
  assert.equal(result.droppedCount, 5);
});

test('an unnamed feature reads as its class, never as a raw OSM id', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    { type: 'way', id: 10981656305, center: { lat: 30.2, lon: -97.7 }, tags: { military: 'range' } },
    { type: 'way', id: 22, center: { lat: 30.3, lon: -97.6 }, tags: { military: 'airfield' } },
    { type: 'node', id: 33, lat: 30.4, lon: -97.5, tags: { military: 'naval_base' } },
    { type: 'node', id: 44, lat: 30.5, lon: -97.4, tags: { landuse: 'military' } },
    // A blank OSM name must fall through to the class, not to an empty label.
    { type: 'node', id: 55, lat: 30.6, lon: -97.3, tags: { military: 'range', name: '   ' } },
  ] }, '2026-08-18T00:00:00.000Z');

  assert.deepEqual(
    result.records.map((record) => record.name),
    ['Firing range', 'Military airfield', 'Naval base', 'Military land', 'Firing range'],
  );
  for (const record of result.records) {
    assert.doesNotMatch(record.name, /\d/, `label must carry no OSM id: ${record.name}`);
    assert.doesNotMatch(record.name, /[()]/, `label must carry no id parenthetical: ${record.name}`);
  }
  // The id is not lost — attribution and the details panel still resolve it.
  assert.equal(result.records[0].id, 'osm:way:10981656305');
  assert.deepEqual(result.records[0].sources, [
    { name: 'OpenStreetMap', id: 'way/10981656305', retrievedAt: '2026-08-18T00:00:00.000Z' },
  ]);
});

test('a real OSM name always wins over the class label', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    { type: 'way', id: 1, center: { lat: 30, lon: -97 }, tags: { military: 'range', name: 'Camp Swift' } },
    { type: 'way', id: 2, center: { lat: 30.1, lon: -97.1 }, tags: { military: 'airfield', 'name:en': 'Bergstrom' } },
  ] });
  assert.deepEqual(result.records.map((record) => record.name), ['Camp Swift', 'Bergstrom']);
});

test('an unmapped class title-cases instead of leaking an underscored tag', () => {
  assert.equal(humanizeInstallationClass('danger_area'), 'Danger area');
  assert.equal(humanizeInstallationClass('checkpoint'), 'Checkpoint');
  assert.equal(humanizeInstallationClass('training_area_north'), 'Training area north');
  assert.equal(humanizeInstallationClass(''), 'Mapped installation');
  assert.equal(humanizeInstallationClass(null), 'Mapped installation');
});

test('accepts only small non-dateline request bboxes', () => {
  assert.equal(isValidInstallationBoundingBox({ south: -1, west: 170, north: 1, east: 179 }), true);
  assert.equal(isValidInstallationBoundingBox({ south: -1, west: 179, north: 1, east: -179 }), false);
  assert.equal(isValidInstallationBoundingBox({ south: -20, west: 0, north: 20, east: 1 }), false);
});

// ── Bounds-midpoint fallback (Overpass `out geom` omits `center`) ────────────
// Overpass honours only the LAST geometry mode in `out center tags geom`, so
// ways/relations arrive with `bounds` (and geometry) but no center point —
// and every one of them used to be dropped silently here. A barracks mapped
// as a way rendered as an empty screen with no error anywhere.
test('a way with bounds but no center derives its point from the bbox midpoint', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    {
      type: 'way',
      id: 1001,
      bounds: { minlat: 50.0, minlon: 8.0, maxlat: 50.02, maxlon: 8.04 },
      tags: { military: 'barracks', name: 'Warendorf Depot' },
    },
  ] });
  assert.equal(result.records.length, 1, 'way must not be dropped for lacking a center');
  // 50.01 lands as 50.010000000000005 in IEEE-754 — compare to full precision
  // of what the midpoint actually is, not a decimal idealization.
  assert.ok(Math.abs(result.records[0].latitude - 50.01) < 1e-9);
  assert.ok(Math.abs(result.records[0].longitude - 8.02) < 1e-9);
});

test('an explicit center still wins over the bounds midpoint', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    {
      type: 'way',
      id: 1002,
      center: { lat: 32.7, lon: -117.1 },
      bounds: { minlat: 32.0, minlon: -118.0, maxlat: 33.0, maxlon: -116.0 },
      tags: { military: 'airfield', name: 'Explicit Center Wins' },
    },
  ] });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].latitude, 32.7);
  assert.equal(result.records[0].longitude, -117.1);
});

test('a half-filled or inverted bounds box is dropped, not averaged into a bad point', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    {
      type: 'way', id: 1003,
      bounds: { minlat: 50.0, minlon: 8.0, maxlon: 8.04 },
      tags: { military: 'barracks' },
    },
    {
      type: 'way', id: 1004,
      bounds: { minlat: 51.0, minlon: 8.0, maxlat: 50.0, maxlon: 8.04 },
      tags: { military: 'barracks' },
    },
    {
      type: 'way', id: 1005,
      bounds: { minlat: 91.0, minlon: 8.0, maxlat: 92.0, maxlon: 8.04 },
      tags: { military: 'barracks' },
    },
  ] });
  assert.deepEqual(result.records, [], 'no plausible-looking lies from broken boxes');
  assert.equal(result.droppedCount, 3);
});
