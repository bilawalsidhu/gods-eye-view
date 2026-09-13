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

// Regression, field test 2026-09-13: Austin returned six elements and rendered
// ONE. The proxy asks for `out center tags geom`, but Overpass geometry modes
// are exclusive — `geom` wins and no `center` is ever emitted — so every way and
// relation arrived with `bounds`/`geometry` and no centre point, and the
// normalizer dropped all of them. Camp Mabry and the Texas National Guard sites
// were invisible while a single tagged NODE carried the whole layer. Every
// fixture above uses `center:`, which real payloads never contain.
test('ways and relations are placed from bounds when no center is emitted', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    {
      type: 'way',
      id: 27894251,
      bounds: { minlat: 30.3094702, minlon: -97.7687456, maxlat: 30.3281592, maxlon: -97.7563896 },
      geometry: [{ lat: 30.3136655, lon: -97.7672354 }, { lat: 30.3119275, lon: -97.7640938 }, { lat: 30.32, lon: -97.757 }],
      tags: { landuse: 'military', name: 'Camp Mabry' },
    },
  ] }, '2026-09-13T00:00:00.000Z');
  assert.equal(result.records.length, 1, 'a way with bounds but no center must still place');
  assert.equal(result.droppedCount, 0);
  const [camp] = result.records;
  assert.equal(camp.name, 'Camp Mabry');
  // Overpass derives `out center` from the bounding box; match it exactly.
  assert.ok(Math.abs(camp.latitude - 30.3188147) < 1e-6, `latitude was ${camp.latitude}`);
  assert.ok(Math.abs(camp.longitude - -97.7625676) < 1e-6, `longitude was ${camp.longitude}`);
  assert.equal(camp.footprint.length, 3, 'the footprint still comes from geometry');
});

test('a relation is placed from member geometry when it has neither center nor bounds', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    {
      type: 'relation',
      id: 42,
      members: [
        { type: 'way', geometry: [{ lat: 10, lon: 20 }, { lat: 10, lon: 20.5 }] },
        { type: 'way', geometry: [{ lat: 11, lon: 20.5 }, { lat: 11, lon: 20 }] },
      ],
      tags: { military: 'naval_base', name: 'Example Naval Base' },
    },
  ] });
  assert.equal(result.records.length, 1, 'relation geometry lives on its members');
  assert.equal(result.records[0].latitude, 10.5);
  assert.equal(result.records[0].longitude, 20.25);
});

test('an element with no usable geometry at all is still dropped', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    { type: 'way', id: 9, tags: { landuse: 'military', name: 'Nowhere' } },
    { type: 'way', id: 10, bounds: { minlat: 'x', minlon: null }, tags: { landuse: 'military' } },
    { type: 'relation', id: 11, members: [{ type: 'way', geometry: [] }], tags: { military: 'range' } },
  ] });
  assert.deepEqual(result.records, []);
  assert.equal(result.droppedCount, 3);
});

test('drops malformed and unsupported OSM features', () => {
  const result = normalizeMilitaryInstallations({ elements: [
    { type: 'node', id: 1, lat: 95, lon: 0, tags: { military: 'range' } },
    { type: 'node', id: 2, lat: 1, lon: 2, tags: { military: 'radar' } },
  ] });
  assert.deepEqual(result.records, []);
  assert.equal(result.droppedCount, 2);
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
