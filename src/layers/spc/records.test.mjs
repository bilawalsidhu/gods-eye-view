import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSpcOutlook,
  parseSpcTime,
  spcSnapshotState,
  spcProduct,
  spcBands,
  SPC_MAX_AGE_MS,
} from './records.js';
import { NOW, ring, feature, collection } from './fixtures.test-support.mjs';

const normalize = (body, product = 'day1-categorical') =>
  normalizeSpcOutlook(body, { product, fetchedAt: NOW });

test('normalizes NOAA categorical fields, Polygon/MultiPolygon and all interior holes without mutation', () => {
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [[ring(), ring(-98, 32, 2)], [ring(-80, 30, 1)]],
  };
  const body = collection(feature({}, geometry));
  const before = structuredClone(body);
  const snapshot = normalize(body);
  assert.deepEqual(body, before);
  assert.deepEqual(snapshot.rows[0].polygons, geometry.coordinates);
  assert.equal(snapshot.rows[0].code, 'MRGL');
  assert.equal(snapshot.rows[0].fill, '#66a366');
  assert.equal(snapshot.rows[0].stroke, '#005500');
  assert.equal(snapshot.issuedAt, Date.parse('2026-10-21T05:51:00Z'));
  assert.equal(snapshot.validFrom, Date.parse('2026-10-21T12:00:00Z'));
  assert.equal(
    spcSnapshotState(snapshot, NOW),
    'ready',
    'future validity is normal for forecasts',
  );
  assert.equal(
    spcSnapshotState(normalize(collection(feature())), NOW),
    'ready',
  );
});

test('every risk classification has a distinct official color and validates dn/label agreement', () => {
  for (const type of ['categorical', 'tornado']) {
    const bands = spcBands(type);
    assert.equal(new Set(bands.map((b) => b.fill)).size, bands.length);
    for (const band of bands) {
      const snapshot = normalize(
        collection(feature({ dn: band.dn, label: band.code })),
        `day2-${type}`,
      );
      assert.equal(snapshot.rows[0].label, band.label);
      assert.equal(snapshot.rows[0].fill, band.fill);
    }
  }
  assert.equal(
    normalize(collection(feature({ dn: 10, label: '0.1' })), 'day1-tornado')
      .rows[0].label,
    '10%',
  );
  assert.throws(() => normalize(collection(feature({ dn: 3, label: 'SLGT' }))));
  assert.throws(() =>
    normalize(collection(feature({ dn: 99, label: 'unknown' }))),
  );
});

test('malformed collections and partial/mixed issues fail closed instead of claiming no risk', () => {
  for (const body of [
    null,
    {},
    { features: [] },
    { type: 'FeatureCollection', features: null },
    { ...collection(), error: {} },
    { ...collection(), exceededTransferLimit: true },
    { ...collection(), properties: { exceededTransferLimit: true } },
    { ...collection(), crs: { name: 'EPSG:3857' } },
  ])
    assert.throws(() => normalize(body));
  for (const props of [
    { objectid: null },
    { objectid: '1' },
    { dn: '3' },
    { label: null },
    { issue: 'bad' },
    { expire: null },
    { expire: '202610201200' },
    { valid: '202610221200' },
    { issue: '202610221201' },
  ])
    assert.throws(() => normalize(collection(feature(props))));
  assert.throws(() => normalize(collection(feature(), feature())));
  assert.throws(() =>
    normalize(
      collection(feature(), feature({ objectid: 2, issue: '202610210600' })),
    ),
  );
  assert.throws(() =>
    normalizeSpcOutlook(collection(), { product: 'day1-categorical' }),
  );
  assert.equal(spcProduct('day1', 'categorical'), 'day1-categorical');
  assert.equal(spcProduct('day3', 'tornado'), null);
  for (const product of ['day3-categorical', 'constructor', 'toString'])
    assert.throws(() => normalize(collection(), product));
});

test('rejects malformed, degenerate, unclosed and oversized geometry, including invalid holes', () => {
  const geometries = [
    null,
    { type: 'Point', coordinates: [0, 0] },
    { type: 'Polygon', coordinates: [] },
    { type: 'MultiPolygon', coordinates: [] },
    { type: 'Polygon', coordinates: [ring().slice(0, -1)] },
    {
      type: 'Polygon',
      coordinates: [
        ring(),
        [
          [0, 0],
          [1, 1],
        ],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [2, 2],
          [0, 0],
        ],
      ],
    },
  ];
  for (const coordinate of [
    [181, 30],
    [10, 91],
    [NaN, 30],
    ['10', 30],
    [10, 30, 5],
  ]) {
    const bad = ring();
    bad[1] = coordinate;
    geometries.push({ type: 'Polygon', coordinates: [bad] });
  }
  geometries.push({
    type: 'Polygon',
    coordinates: [Array(100_001).fill([0, 0])],
  });
  for (const geometry of geometries)
    assert.throws(() => normalize(collection(feature({}, geometry))));
});

test('UTC dates reject rollover, local date text and malformed fields', () => {
  assert.equal(
    parseSpcTime('202402291230'),
    Date.parse('2024-02-29T12:30:00Z'),
  );
  for (const value of [
    '202602291230',
    '202613011200',
    '202610212400',
    '202610211260',
    '2026102112',
    '2026-10-21T12:00Z',
    202610211200,
    null,
  ])
    assert.equal(parseSpcTime(value), null);
});

test('empty, stale, expired and over-age outlooks are different states', () => {
  const snapshot = normalize(collection(feature()));
  assert.equal(spcSnapshotState(null, NOW), 'unavailable');
  assert.equal(spcSnapshotState(normalize(collection()), NOW), 'empty');
  assert.equal(spcSnapshotState({ ...snapshot, stale: true }, NOW), 'stale');
  assert.equal(spcSnapshotState(snapshot, NOW + 600_000), 'stale');
  assert.equal(spcSnapshotState(snapshot, NOW + SPC_MAX_AGE_MS), 'unavailable');
  assert.equal(
    spcSnapshotState(
      { ...snapshot, fetchedAt: snapshot.validUntil },
      snapshot.validUntil,
    ),
    'expired',
  );
  assert.equal(
    spcSnapshotState({ ...snapshot, issuedAt: NOW + 600_000 }, NOW),
    'unavailable',
  );
});
