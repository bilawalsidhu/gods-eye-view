import test from 'node:test';
import assert from 'node:assert/strict';
import {
  perimeterAnchorDegrees,
  normalizeFirePerimeterSnapshot,
  firePerimeterSnapshot,
} from './records.js';

const ring = [
  [-108.1, 35.2],
  [-108.0, 35.2],
  [-108.0, 35.3],
  [-108.1, 35.2],
];

function feature(overrides = {}) {
  return {
    id: 1,
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
      poly_IncidentName: 'Fixture Fire',
      attr_UniqueFireIdentifier: '2026-NMGNF-000123',
      attr_IncidentSize: 512.5,
      attr_PercentContained: 40,
      attr_POOState: 'US-NM',
      attr_IncidentTypeCategory: 'WF',
      attr_FireDiscoveryDateTime: 1757900000000,
      poly_DateCurrent: 1757950000000,
      poly_PolygonDateTime: 1757940000000,
      attr_FireCause: 'Natural',
      attr_FireBehaviorGeneral: 'Active',
      attr_TotalIncidentPersonnel: 380,
      attr_POOCounty: 'Sandoval',
      attr_EstimatedCostToDate: 4200000,
      attr_IncidentComplexityLevel: 'Type 3 Incident',
      attr_CpxName: 'ROWE CREEK COMPLEX',
      ...overrides.properties,
    },
    ...overrides,
  };
}

test('a valid snapshot yields one row per incident with polygons preserved', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [
      feature(),
      feature({
        id: 2,
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[ring], [ring]],
        },
        properties: { attr_UniqueFireIdentifier: '2026-AZASF-000456' },
      }),
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    stableId: '2026-NMGNF-000123',
    name: 'Fixture Fire',
    acres: 512.5,
    containedPct: 40,
    state: 'US-NM',
    category: 'WF',
    discoveredTime: 1757900000000,
    updatedTime: 1757950000000,
    polygonTime: 1757940000000,
    cause: 'Natural',
    behavior: 'Active',
    personnel: 380,
    county: 'Sandoval',
    costToDate: 4200000,
    complexity: 'Type 3 Incident',
    complexName: 'ROWE CREEK COMPLEX',
    polygons: [[ring]],
  });
  assert.equal(rows[1].polygons.length, 2);
});

test('a missing unique fire identifier falls back to the feature id', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [feature({ properties: { attr_UniqueFireIdentifier: null } })],
  });
  assert.equal(rows[0].stableId, '1');
});

test('optional attributes normalize to null rather than leaking undefined', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [
      feature({
        properties: {
          poly_IncidentName: null,
          attr_IncidentSize: null,
          attr_PercentContained: null,
          attr_POOState: null,
          attr_IncidentTypeCategory: null,
          attr_FireDiscoveryDateTime: null,
          poly_DateCurrent: null,
          poly_PolygonDateTime: null,
          attr_FireCause: null,
          attr_FireBehaviorGeneral: null,
          attr_TotalIncidentPersonnel: null,
          attr_POOCounty: null,
          attr_EstimatedCostToDate: null,
          attr_IncidentComplexityLevel: null,
          attr_CpxName: null,
        },
      }),
    ],
  });
  assert.deepEqual(
    {
      name: rows[0].name,
      acres: rows[0].acres,
      containedPct: rows[0].containedPct,
      state: rows[0].state,
      category: rows[0].category,
      discoveredTime: rows[0].discoveredTime,
      updatedTime: rows[0].updatedTime,
      polygonTime: rows[0].polygonTime,
      cause: rows[0].cause,
      behavior: rows[0].behavior,
      personnel: rows[0].personnel,
      county: rows[0].county,
      costToDate: rows[0].costToDate,
      complexity: rows[0].complexity,
      complexName: rows[0].complexName,
    },
    {
      name: null,
      acres: null,
      containedPct: null,
      state: null,
      category: null,
      discoveredTime: null,
      updatedTime: null,
      polygonTime: null,
      cause: null,
      behavior: null,
      personnel: null,
      county: null,
      costToDate: null,
      complexity: null,
      complexName: null,
    },
  );
});

test('a feed that is not a feature collection is rejected as a whole', () => {
  for (const payload of [null, {}, { features: null }, { features: {} }]) {
    assert.equal(normalizeFirePerimeterSnapshot(payload), null);
  }
});

test('an invalid feature is skipped so one bad incident cannot blank the layer', () => {
  const good = feature({
    id: 2,
    properties: { attr_UniqueFireIdentifier: 'good' },
  });
  for (const bad of [
    feature({ geometry: null }),
    feature({ geometry: { type: 'Point', coordinates: [0, 1] } }),
    feature({
      geometry: {
        type: 'Polygon',
        coordinates: [[[Infinity, 35.2], ...ring.slice(1)]],
      },
    }),
    feature({
      geometry: {
        type: 'Polygon',
        coordinates: [[[-200, 35.2], ...ring.slice(1)]],
      },
    }),
    feature({ geometry: { type: 'Polygon', coordinates: [ring.slice(0, 2)] } }),
    feature({ properties: null }),
    feature({ id: null, properties: { attr_UniqueFireIdentifier: null } }),
  ]) {
    const rows = normalizeFirePerimeterSnapshot({ features: [bad, good] });
    assert.equal(rows.length, 1, 'bad feature must be skipped, not fatal');
    assert.equal(rows[0].stableId, 'good');
  }
});

test('a duplicate incident id keeps the first occurrence and skips the rest', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [
      feature(),
      feature({
        properties: {
          attr_UniqueFireIdentifier: '2026-NMGNF-000123',
          attr_IncidentSize: 999,
        },
      }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].acres, 512.5);
});

test('a perimeter with no rings is skipped rather than rendered empty', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [
      feature({ geometry: { type: 'Polygon', coordinates: [] } }),
      feature({ id: 2, properties: { attr_UniqueFireIdentifier: 'other' } }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'other');
});

const NOW = 1758000000000;
const rowsOf = (...features) => normalizeFirePerimeterSnapshot({ features });
// feature() replaces all properties with the overrides' own: keep the rest.
const fixture = (id, properties) =>
  feature({ id, properties: { ...feature().properties, ...properties } });

test('each WFIGS polygon becomes one piece of its fire, born when it was mapped', () => {
  const hole = [
    [-108.08, 35.22],
    [-108.02, 35.22],
    [-108.02, 35.25],
    [-108.08, 35.22],
  ];
  const snapshot = firePerimeterSnapshot(
    rowsOf(
      feature({
        geometry: { type: 'MultiPolygon', coordinates: [[ring, hole], [ring]] },
      }),
    ),
    { fetchedAt: NOW - 1000, now: NOW },
  );
  assert.equal(snapshot.at, null);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.fetchedAt, NOW - 1000);
  assert.equal(
    snapshot.note,
    "Age counts from WFIGS mapping time, else the record's last edit. Perimeters simplified to ~100 m.",
  );
  assert.equal(snapshot.fires.length, 1);
  const [fire] = snapshot.fires;
  assert.equal(fire.id, '2026-NMGNF-000123');
  assert.equal(fire.lastGrowthTime, 1757940000000);
  assert.equal(fire.containedPct, 40);
  assert.equal('stableId' in fire || 'polygons' in fire, false);
  assert.ok(Math.abs(fire.anchor.lat - 35.2333) < 0.01);
  assert.deepEqual(
    snapshot.pieces.map(({ fireId, born, polygons, outline }) => [
      fireId,
      born,
      polygons,
      outline,
    ]),
    [
      ['2026-NMGNF-000123', 1757940000000, [[ring, hole]], [ring, hole]],
      ['2026-NMGNF-000123', 1757940000000, [[ring]], [ring]],
    ],
    'the outline is every ring, holes included',
  );
});

test('a perimeter without its mapping time falls back to the last edit; a future time is unknown', () => {
  const [fallback, future, futureEdit, none] = firePerimeterSnapshot(
    rowsOf(
      fixture(1, { poly_PolygonDateTime: null }),
      fixture(2, {
        attr_UniqueFireIdentifier: 'future',
        poly_PolygonDateTime: NOW + 3600000,
      }),
      fixture(3, {
        attr_UniqueFireIdentifier: 'future-edit',
        poly_PolygonDateTime: null,
        poly_DateCurrent: NOW + 3600000,
      }),
      fixture(4, {
        attr_UniqueFireIdentifier: 'none',
        poly_PolygonDateTime: null,
        poly_DateCurrent: null,
      }),
    ),
    { now: NOW },
  ).fires;
  assert.equal(fallback.lastGrowthTime, 1757950000000);
  assert.equal(future.lastGrowthTime, null);
  assert.equal(futureEdit.lastGrowthTime, null);
  assert.equal(none.lastGrowthTime, null);
  // A clock a few minutes ahead of ours is taken as now.
  const skewed = firePerimeterSnapshot(
    rowsOf(fixture(1, { poly_PolygonDateTime: NOW + 60000 })),
    { now: NOW },
  );
  assert.equal(skewed.fires[0].lastGrowthTime, NOW);
  assert.equal(skewed.pieces[0].born, NOW);
});

test('the revision follows fire ids and update times, not feed order', () => {
  const a = feature();
  const b = fixture(2, { attr_UniqueFireIdentifier: 'b' });
  const revision = (...features) =>
    firePerimeterSnapshot(rowsOf(...features), { now: NOW }).revision;
  assert.equal(revision(a, b), revision(b, a));
  assert.notEqual(
    revision(a, b),
    revision(
      a,
      fixture(2, { attr_UniqueFireIdentifier: 'b', poly_DateCurrent: 1 }),
    ),
  );
  assert.notEqual(revision(a, b), revision(a));

  const undated = fixture(1, { poly_DateCurrent: null });
  const shifted = ring.map(([lon, lat]) => [lon + 1, lat]);
  assert.notEqual(
    revision(undated),
    revision({
      ...undated,
      geometry: { type: 'Polygon', coordinates: [shifted] },
    }),
  );
  assert.notEqual(
    revision(undated),
    revision(
      fixture(1, {
        poly_DateCurrent: null,
        poly_PolygonDateTime: NOW,
      }),
    ),
  );
});

test('the snapshot carries staleness', () => {
  const snapshot = firePerimeterSnapshot(rowsOf(feature()), {
    stale: true,
    fetchedAt: 'yesterday',
    now: NOW,
  });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.fetchedAt, null);
  assert.deepEqual(
    snapshot.fires.map(({ id }) => id),
    ['2026-NMGNF-000123'],
  );
});

const square = [
  [-108.2, 35.0],
  [-108.0, 35.0],
  [-108.0, 35.2],
  [-108.2, 35.2],
  [-108.2, 35.0],
];
const tiny = [
  [-107.01, 34.0],
  [-107.0, 34.0],
  [-107.0, 34.01],
  [-107.01, 34.0],
];

test('the card anchors at the vertex mean of the largest polygon', () => {
  const anchor = perimeterAnchorDegrees([[tiny], [square]]);
  assert.ok(Math.abs(anchor.lon - -108.1) < 1e-9);
  assert.ok(Math.abs(anchor.lat - 35.1) < 1e-9);
});

test('incident cards stay at the dateline for closed, reversed and rotated outlines', () => {
  const vertices = [
    [179, 10],
    [-179, 10],
    [-179, 12],
    [179, 12],
  ];
  for (let start = 0; start < vertices.length; start++) {
    const rotated = [...vertices.slice(start), ...vertices.slice(0, start)];
    for (const points of [rotated, [...rotated].reverse()]) {
      const anchor = perimeterAnchorDegrees([[points.concat([points[0]])]]);
      assert.ok(Math.abs(Math.abs(anchor.lon) - 180) < 1e-9);
      assert.ok(Math.abs(anchor.lat - 11) < 1e-9);
    }
  }
});

test('incident card longitude treats vertices at either sign of 180 as the same meridian', () => {
  for (const boundary of [-180, 180]) {
    const ring = [
      [179, 10],
      [boundary, 10],
      [-179, 10],
      [-179, 12],
      [179, 12],
      [179, 10],
    ];
    const anchor = perimeterAnchorDegrees([[ring]]);
    assert.ok(Math.abs(Math.abs(anchor.lon) - 180) < 1e-9);
    assert.ok(Math.abs(anchor.lat - 10.8) < 1e-9);
  }
});

test('multipart cards compare polygon areas along short dateline edges', () => {
  const ordinary = [
    [10, 20],
    [11, 20],
    [11, 21],
    [10, 21],
    [10, 20],
  ];
  for (const width of [0.2, 2]) {
    const crossing = [
      [180 - width / 2, 10],
      [-180 + width / 2, 10],
      [-180 + width / 2, 10 + width],
      [180 - width / 2, 10 + width],
      [180 - width / 2, 10],
    ];
    for (const ring of [crossing, [...crossing].reverse()]) {
      for (const polygons of [
        [[ring], [ordinary]],
        [[ordinary], [ring]],
      ]) {
        const anchor = perimeterAnchorDegrees(polygons);
        if (width < 1) {
          assert.ok(Math.abs(anchor.lon - 10.5) < 1e-9);
          assert.ok(Math.abs(anchor.lat - 20.5) < 1e-9);
        } else {
          assert.ok(Math.abs(Math.abs(anchor.lon) - 180) < 1e-9);
          assert.ok(Math.abs(anchor.lat - 11) < 1e-9);
        }
      }
    }
  }
});
