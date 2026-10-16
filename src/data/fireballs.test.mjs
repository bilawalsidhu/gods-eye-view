import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFireballCoordinates,
  parseFireballTimestamp,
  parseCneosFireballRecord,
  normalizeFireballPayload,
  fireballToGeoJsonFeature,
} from './fireballs.js';
import { cneosFireballsUrl } from './spaceProviderRequests.js';

test('parseFireballCoordinates handles cardinal hemisphere directions and bounds', () => {
  // Northern + Eastern
  assert.deepEqual(
    parseFireballCoordinates('45.2', 'N', '12.8', 'E'),
    [45.2, 12.8],
  );

  // Southern + Western
  assert.deepEqual(
    parseFireballCoordinates('33.5', 'S', '70.6', 'W'),
    [-33.5, -70.6],
  );

  // Equator and Prime Meridian
  assert.deepEqual(parseFireballCoordinates('0', 'N', '0', 'E'), [0, 0]);

  // Out of bounds latitude / longitude
  assert.equal(parseFireballCoordinates('95.0', 'N', '10.0', 'E'), null);
  assert.equal(parseFireballCoordinates('10.0', 'N', '185.0', 'E'), null);

  // Invalid direction letters
  assert.equal(parseFireballCoordinates('45.0', 'X', '10.0', 'E'), null);
  assert.equal(parseFireballCoordinates('45.0', 'N', '10.0', 'Z'), null);

  // Non-finite coordinates
  assert.equal(parseFireballCoordinates('abc', 'N', '10.0', 'E'), null);
  assert.equal(parseFireballCoordinates(null, 'N', undefined, 'W'), null);
});

test('parseFireballTimestamp parses CNEOS UTC timestamps into ISO and epoch ms', () => {
  const result = parseFireballTimestamp('2023-02-13 02:59:21');
  assert.ok(result);
  assert.equal(result.iso, '2023-02-13T02:59:21.000Z');
  assert.equal(result.epochMs, Date.UTC(2023, 1, 13, 2, 59, 21));

  // Invalid timestamps
  assert.equal(parseFireballTimestamp('invalid-date'), null);
  assert.equal(parseFireballTimestamp(''), null);
  assert.equal(parseFireballTimestamp(null), null);
});

test('parseCneosFireballRecord maps CNEOS row array to normalized event', () => {
  const fields = [
    'date',
    'energy',
    'impact-e',
    'lat',
    'lat-dir',
    'lon',
    'lon-dir',
    'alt',
    'vel',
  ];
  const row = [
    '2023-02-13 02:59:21',
    '15.5',
    '0.45',
    '49.8',
    'N',
    '0.1',
    'E',
    '34.5',
    '14.2',
  ];

  const record = parseCneosFireballRecord(fields, row);
  assert.ok(record);
  assert.equal(record.date, '2023-02-13T02:59:21.000Z');
  assert.equal(record.lat, 49.8);
  assert.equal(record.lon, 0.1);
  assert.equal(record.altitudeKm, 34.5);
  assert.equal(record.velocityKmS, 14.2);
  assert.equal(record.impactEnergyKt, 0.45);
  assert.equal(record.opticalEnergyJoules, 15.5 * 1e10);
  assert.match(record.id, /^cneos-fireball-\d+-49\.80-0\.10$/);
});

test('parseCneosFireballRecord handles missing optional fields and drops invalid rows', () => {
  const fields = [
    'date',
    'energy',
    'impact-e',
    'lat',
    'lat-dir',
    'lon',
    'lon-dir',
    'alt',
    'vel',
  ];
  const rowMissingFields = [
    '2022-05-10 12:00:00',
    null,
    null,
    '25.0',
    'S',
    '140.0',
    'W',
    null,
    null,
  ];

  const record = parseCneosFireballRecord(fields, rowMissingFields);
  assert.ok(record);
  assert.equal(record.lat, -25.0);
  assert.equal(record.lon, -140.0);
  assert.equal(record.altitudeKm, null);
  assert.equal(record.velocityKmS, null);
  assert.equal(record.impactEnergyKt, null);
  assert.equal(record.opticalEnergyJoules, null);

  // Missing coordinates drops record
  const badRow = [
    '2022-05-10 12:00:00',
    '10',
    '0.1',
    null,
    null,
    '140.0',
    'W',
    '30',
    '15',
  ];
  assert.equal(parseCneosFireballRecord(fields, badRow), null);
});

test('normalizeFireballPayload parses full payload, deduplicates, and sorts descending', () => {
  const payload = {
    signature: { source: 'NASA/JPL CNEOS', version: '1.0' },
    count: '3',
    fields: ['date', 'lat', 'lat-dir', 'lon', 'lon-dir'],
    data: [
      ['2021-01-01 10:00:00', '10.0', 'N', '20.0', 'E'],
      ['2023-01-01 10:00:00', '15.0', 'N', '25.0', 'E'],
      ['2021-01-01 10:00:00', '10.0', 'N', '20.0', 'E'], // Duplicate
    ],
  };

  const normalized = normalizeFireballPayload(payload);
  assert.equal(normalized.count, 2);
  assert.equal(normalized.events.length, 2);
  // Most recent first
  assert.equal(normalized.events[0].date, '2023-01-01T10:00:00.000Z');
  assert.equal(normalized.events[1].date, '2021-01-01T10:00:00.000Z');

  // Empty or invalid payload
  assert.deepEqual(normalizeFireballPayload(null), { count: 0, events: [] });
  assert.deepEqual(normalizeFireballPayload({}), { count: 0, events: [] });
});

test('fireballToGeoJsonFeature builds standard Point Feature with altitude in metres', () => {
  const event = {
    id: 'fireball-test-1',
    date: '2023-02-13T02:59:21.000Z',
    epochMs: 1676257161000,
    lat: 49.8,
    lon: 0.1,
    altitudeKm: 34.5,
    velocityKmS: 14.2,
    opticalEnergyJoules: 15.5e10,
    impactEnergyKt: 0.45,
  };

  const feature = fireballToGeoJsonFeature(event);
  assert.equal(feature.type, 'Feature');
  assert.equal(feature.id, 'fireball-test-1');
  assert.equal(feature.geometry.type, 'Point');
  assert.deepEqual(feature.geometry.coordinates, [0.1, 49.8, 34500]);
  assert.equal(feature.properties.impactEnergyKt, 0.45);
  assert.equal(feature.properties.altitudeKm, 34.5);
});

test('cneosFireballsUrl formats query parameters correctly', () => {
  const defaultUrl = cneosFireballsUrl();
  assert.equal(defaultUrl.origin, 'https://ssd-api.jpl.nasa.gov');
  assert.equal(defaultUrl.pathname, '/fireball.api');
  assert.equal(defaultUrl.searchParams.get('req-loc'), 'true');

  const customUrl = cneosFireballsUrl({
    dateMin: '2022-01-01',
    dateMax: '2023-01-01',
    energyMin: 0.5,
    velMin: 12.0,
    limit: 50,
    sort: 'date',
  });
  assert.equal(customUrl.searchParams.get('date-min'), '2022-01-01');
  assert.equal(customUrl.searchParams.get('date-max'), '2023-01-01');
  assert.equal(customUrl.searchParams.get('energy-min'), '0.5');
  assert.equal(customUrl.searchParams.get('vel-min'), '12');
  assert.equal(customUrl.searchParams.get('limit'), '50');
  assert.equal(customUrl.searchParams.get('sort'), 'date');
});
