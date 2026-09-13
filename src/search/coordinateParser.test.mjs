import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinateQuery, formatCoordinateLabel } from './coordinateParser.js';
import { createCoordinateGeocoder } from './coordinateGeocoder.js';
import { createPresetGeocoder } from './presetGeocoder.js';

test('parseCoordinateQuery parses comma-separated decimal degrees', () => {
  const res = parseCoordinateQuery('43.1731, -79.0384');
  assert.ok(res);
  assert.equal(res.lat, 43.1731);
  assert.equal(res.lng, -79.0384);
  assert.equal(res.label, '43.1731° N, 79.0384° W');
});

test('parseCoordinateQuery parses space-separated decimal degrees', () => {
  const res = parseCoordinateQuery('43.1731 -79.0384');
  assert.ok(res);
  assert.equal(res.lat, 43.1731);
  assert.equal(res.lng, -79.0384);
});

test('parseCoordinateQuery parses cardinal notation with degree symbols', () => {
  const res = parseCoordinateQuery('43.1731° N, 79.0384° W');
  assert.ok(res);
  assert.equal(res.lat, 43.1731);
  assert.equal(res.lng, -79.0384);
});

test('parseCoordinateQuery parses prefix cardinal notation', () => {
  const res = parseCoordinateQuery('N 43.1731, W 79.0384');
  assert.ok(res);
  assert.equal(res.lat, 43.1731);
  assert.equal(res.lng, -79.0384);
});

test('parseCoordinateQuery parses Degrees Minutes Seconds (DMS)', () => {
  const res = parseCoordinateQuery('40° 42\' 46" N, 74° 00\' 21" W');
  assert.ok(res);
  assert.ok(Math.abs(res.lat - 40.71277) < 0.001);
  assert.ok(Math.abs(res.lng - (-74.00583)) < 0.001);
});

test('parseCoordinateQuery parses valid MGRS coordinates', () => {
  const res = parseCoordinateQuery('33UXP0500444998');
  assert.ok(res);
  assert.ok(Math.abs(res.lat - 48.2494) < 0.01);
  assert.ok(Math.abs(res.lng - 16.4145) < 0.01);
});

test('parseCoordinateQuery rejects out-of-range coordinates', () => {
  assert.equal(parseCoordinateQuery('95.0, 10.0'), null);
  assert.equal(parseCoordinateQuery('10.0, 195.0'), null);
  assert.equal(parseCoordinateQuery('-92.0, 0'), null);
});

test('parseCoordinateQuery ignores plain text place names', () => {
  assert.equal(parseCoordinateQuery('London'), null);
  assert.equal(parseCoordinateQuery('Times Square, NY'), null);
  assert.equal(parseCoordinateQuery(''), null);
});

test('createCoordinateGeocoder immediately answers valid coordinates', async () => {
  const geocoder = createCoordinateGeocoder();
  const outcome = await geocoder.geocode('51.5074, -0.1278');
  assert.equal(outcome.answered, true);
  assert.ok(outcome.place);
  assert.equal(outcome.place.lat, 51.5074);
  assert.equal(outcome.place.lng, -0.1278);
  assert.equal(outcome.place.types[0], 'coordinate');
});

test('createPresetGeocoder matches bundled city presets keyless', async () => {
  const samplePresets = {
    london: {
      name: 'London',
      viewBounds: { southwest: { lat: 51.4, lng: -0.2 }, northeast: { lat: 51.6, lng: 0.1 } },
      pois: [
        { name: 'Big Ben', lat: 51.5007, lon: -0.1246 },
        { name: 'London Eye', lat: 51.5033, lon: -0.1195 },
      ],
    },
    sf: {
      name: 'San Francisco',
      pois: [
        { name: 'Golden Gate Bridge', lat: 37.8199, lon: -122.4783 },
      ],
    },
    nyc: {
      name: 'New York',
      pois: [
        { name: 'Empire State Building', lat: 40.7484, lon: -73.9857 },
      ],
    },
  };

  const emptyGeocoder = createPresetGeocoder();
  const unhandled = await emptyGeocoder.geocode('London');
  assert.equal(unhandled.answered, false);

  const geocoder = createPresetGeocoder({ presets: samplePresets });
  const london = await geocoder.geocode('London');
  assert.equal(london.answered, true);
  assert.equal(london.place.label, 'London');
  assert.ok(london.place.lat);

  const sf = await geocoder.geocode('San Francisco');
  assert.equal(sf.answered, true);
  assert.equal(sf.place.label, 'San Francisco');

  const poi = await geocoder.geocode('Empire State Building');
  assert.equal(poi.answered, true);
  assert.ok(poi.place.label.includes('Empire State Building'));
});
