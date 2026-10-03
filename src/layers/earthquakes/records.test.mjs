import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEarthquakeSnapshot } from './records.js';

test('normalizeEarthquakeSnapshot parses valid GeoJSON earthquake features', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        id: 'us7000m123',
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [-122.4194, 37.7749, 10.5],
        },
        properties: {
          mag: 4.2,
          place: 'San Francisco Bay Area, CA',
          time: 1711929600000,
        },
      },
    ],
  };

  const rows = normalizeEarthquakeSnapshot(geojson);
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    stableId: 'us7000m123',
    usgsId: 'us7000m123',
    lon: -122.4194,
    lat: 37.7749,
    depthKm: 10.5,
    mag: 4.2,
    place: 'San Francisco Bay Area, CA',
    time: 1711929600000,
  });
});

test('normalizeEarthquakeSnapshot generates index-based stable IDs when id is missing or blank', () => {
  const geojson = {
    features: [
      {
        id: null,
        geometry: { type: 'Point', coordinates: [139.6917, 35.6895, 25.0] },
        properties: { mag: 3.5, place: 'Tokyo, Japan', time: 1711930000000 },
      },
      {
        id: '',
        geometry: { type: 'Point', coordinates: [-70.6693, -33.4489, 45.2] },
        properties: { mag: 5.1, place: 'Santiago, Chile', time: 1711931000000 },
      },
    ],
  };

  const rows = normalizeEarthquakeSnapshot(geojson);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stableId, 'event-1');
  assert.equal(rows[0].usgsId, null);
  assert.equal(rows[1].stableId, 'event-2');
  assert.equal(rows[1].usgsId, '');
});

test('normalizeEarthquakeSnapshot filters events below M2.5 without dropping the feed', () => {
  const geojson = {
    features: [
      {
        id: 'ev-sub',
        geometry: { type: 'Point', coordinates: [10, 20, 5] },
        properties: { mag: 2.49, place: 'Minor tremor' },
      },
      {
        id: 'ev-null-mag',
        geometry: { type: 'Point', coordinates: [11, 21, 5] },
        properties: { mag: null, place: 'Uncalculated' },
      },
      {
        id: 'ev-threshold',
        geometry: { type: 'Point', coordinates: [12, 22, 5] },
        properties: { mag: 2.5, place: 'Threshold event' },
      },
      {
        id: 'ev-strong',
        geometry: { type: 'Point', coordinates: [13, 23, 5] },
        properties: { mag: 6.8, place: 'Major event' },
      },
    ],
  };

  const rows = normalizeEarthquakeSnapshot(geojson);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stableId, 'ev-threshold');
  assert.equal(rows[0].mag, 2.5);
  assert.equal(rows[1].stableId, 'ev-strong');
  assert.equal(rows[1].mag, 6.8);
});

test('normalizeEarthquakeSnapshot normalizes optional fields to null when omitted or invalid', () => {
  const geojson = {
    features: [
      {
        id: 'ev-sparse',
        geometry: { coordinates: [-100, 40] }, // depth omitted
        properties: { mag: 3.0, place: 12345, time: 'invalid' }, // place not string, time not number
      },
    ],
  };

  const rows = normalizeEarthquakeSnapshot(geojson);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].depthKm, null);
  assert.equal(rows[0].place, null);
  assert.equal(rows[0].time, null);
});

test('normalizeEarthquakeSnapshot returns null for malformed structures or non-array features', () => {
  assert.equal(normalizeEarthquakeSnapshot(null), null);
  assert.equal(normalizeEarthquakeSnapshot(undefined), null);
  assert.equal(normalizeEarthquakeSnapshot({}), null);
  assert.equal(normalizeEarthquakeSnapshot({ features: 'not-an-array' }), null);
  assert.equal(normalizeEarthquakeSnapshot({ features: null }), null);
});

test('normalizeEarthquakeSnapshot returns null for invalid geometries or out-of-range coordinates', () => {
  const baseFeature = {
    id: 'test',
    geometry: { type: 'Point', coordinates: [0, 0, 0] },
    properties: { mag: 3.0 },
  };

  // Non-Point geometry
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }],
    }),
    null,
  );

  // Missing or short coordinates
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, geometry: { type: 'Point', coordinates: [0] } }],
    }),
    null,
  );

  // Longitude out of range [-180, 180]
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, geometry: { type: 'Point', coordinates: [180.1, 0, 0] } }],
    }),
    null,
  );
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, geometry: { type: 'Point', coordinates: [-180.1, 0, 0] } }],
    }),
    null,
  );

  // Latitude out of range [-90, 90]
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, geometry: { type: 'Point', coordinates: [0, 90.1, 0] } }],
    }),
    null,
  );
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, geometry: { type: 'Point', coordinates: [0, -90.1, 0] } }],
    }),
    null,
  );

  // Non-finite depth
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, geometry: { type: 'Point', coordinates: [0, 0, NaN] } }],
    }),
    null,
  );

  // Magnitude > 10
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, properties: { mag: 10.1 } }],
    }),
    null,
  );

  // Non-object or array properties
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, properties: 'invalid' }],
    }),
    null,
  );
  assert.equal(
    normalizeEarthquakeSnapshot({
      features: [{ ...baseFeature, properties: [] }],
    }),
    null,
  );
});

test('normalizeEarthquakeSnapshot returns null when feed contains duplicate IDs', () => {
  const geojson = {
    features: [
      {
        id: 'duplicate-id',
        geometry: { type: 'Point', coordinates: [0, 0, 0] },
        properties: { mag: 3.0 },
      },
      {
        id: 'duplicate-id',
        geometry: { type: 'Point', coordinates: [1, 1, 1] },
        properties: { mag: 4.0 },
      },
    ],
  };

  assert.equal(normalizeEarthquakeSnapshot(geojson), null);
});
