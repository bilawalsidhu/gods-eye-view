import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CONAE_RECORDS, parseConaeGoes } from './parse.js';

const NOW = Date.parse('2026-10-15T04:00:00Z');
// Synthetic values using the field names seen in the contributor's WFS sample.
// No actual third-party detections are bundled.
const feature = (properties = {}, geometry = { type: 'Point', coordinates: [-60, -30] }) => ({
  type: 'Feature', geometry,
  properties: {
    'Fecha_Local_UTC-3': '2026-10-14 21:20:00',
    Satelite: 'GOES19', Fire_Radiative_Power: 12.5, ...properties,
  },
});
const collection = (features = [feature()], extra = {}) => ({
  type: 'FeatureCollection', features, totalFeatures: features.length,
  numberReturned: features.length,
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } },
  ...extra,
});

test('CONAE preserves WGS84, converts UTC-3 across midnight and keeps unknown confidence', () => {
  const [row] = parseConaeGoes(collection(), NOW);
  assert.deepEqual(row, {
    provider: 'conae-goes', lat: -30, lon: -60,
    acqMs: Date.parse('2026-10-15T00:20:00Z'), frp: 12.5,
    confidence: null, brightness: null, daynight: '',
    instrument: 'GOES', satellite: 'GOES-19',
  });
});

test('CONAE filters the trailing 24h at acquisition time, including bounded clock skew', () => {
  const rows = [
    feature({ 'Fecha_Local_UTC-3': '2026-10-14 01:00:00' }),
    feature({ 'Fecha_Local_UTC-3': '2026-10-14 00:59:59' }),
    feature({ 'Fecha_Local_UTC-3': '2026-10-15 01:10:00' }),
    feature({ 'Fecha_Local_UTC-3': '2026-10-15 01:10:01' }),
  ];
  assert.equal(parseConaeGoes(collection(rows), NOW).length, 2);
});

test('unknown FRP remains null, while a measured zero is retained', () => {
  for (const value of [null, undefined, '', -9999, Infinity, 'bad']) {
    assert.equal(parseConaeGoes(collection([feature({ Fire_Radiative_Power: value })]), NOW)[0].frp, null);
  }
  assert.equal(parseConaeGoes(collection([feature({ Fire_Radiative_Power: 0 })]), NOW)[0].frp, 0);
});

test('empty data is distinct from malformed, wrong-CRS and incomplete collections', () => {
  assert.deepEqual(parseConaeGoes(collection([]), NOW), []);
  for (const payload of [
    {}, { type: 'FeatureCollection', features: null },
    collection([], { numberMatched: 103 }),
    collection([feature()], { totalFeatures: 103 }),
    collection([feature()], { numberReturned: 2 }),
    collection([feature()], { crs: { properties: { name: 'EPSG:3857' } } }),
    collection(Array(MAX_CONAE_RECORDS + 1).fill(feature())),
  ]) assert.throws(() => parseConaeGoes(payload, NOW));
});

test('invalid positions, missing time and impossible dates fail closed, including mixed corruption', () => {
  const invalid = [
    feature({}, { type: 'LineString', coordinates: [[-60, -30], [-61, -31]] }),
    feature({}, { type: 'Point', coordinates: [181, -30] }),
    feature({}, { type: 'Point', coordinates: [null, -30] }),
    feature({ 'Fecha_Local_UTC-3': null }),
    feature({ 'Fecha_Local_UTC-3': '2026-02-30 12:00:00' }),
    feature({ 'Fecha_Local_UTC-3': '2026-10-14T21:20:00Z' }),
    feature({ Satelite: 'unknown' }),
  ];
  for (const bad of invalid) {
    assert.throws(() => parseConaeGoes(collection([bad]), NOW));
    assert.throws(() => parseConaeGoes(collection([feature(), bad]), NOW));
  }
});
