// NOMINATIM RESULT MAPPING — what counts as a usable hit.
//
// Every numeric field arrives as a string and may be absent or nonsense, and
// `Number(null)` is 0: a hit with no coordinates read as (0, 0) would fly the
// camera to the Atlantic and look like a successful search. These cases pin
// every field that must be refused rather than coerced.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nominatimLatitude,
  nominatimLongitude,
  nominatimToGeocodeResult,
  nominatimViewboxFromBounds,
  typesFromNominatim,
  viewportFromNominatim,
} from './nominatimGeocode.js';

test('a coordinate field is a number in range, or nothing', () => {
  assert.equal(nominatimLatitude('43.1731'), 43.1731);
  assert.equal(nominatimLatitude(-33.8568), -33.8568);
  assert.equal(nominatimLatitude('90'), 90);
  assert.equal(nominatimLongitude('-180'), -180);

  for (const value of [
    null,
    undefined,
    '',
    '   ',
    'abc',
    NaN,
    Infinity,
    true,
    false,
    [],
    ['43'],
    {},
    '91',
    '-90.5',
  ])
    assert.equal(
      nominatimLatitude(value),
      null,
      `${JSON.stringify(value)} is not a latitude`,
    );

  for (const value of [null, '', '181', '-180.5', true, []])
    assert.equal(
      nominatimLongitude(value),
      null,
      `${JSON.stringify(value)} is not a longitude`,
    );
});

test('a hit without real coordinates produces no result at all', () => {
  for (const hit of [
    null,
    undefined,
    {},
    { lat: null, lon: null, display_name: 'Nowhere' },
    { lat: '', lon: '', display_name: 'Nowhere' },
    { lat: '43.17', lon: null, display_name: 'Half a place' },
    { lat: null, lon: '-79.03', display_name: 'Half a place' },
    { lat: '91', lon: '0', display_name: 'Off the pole' },
    { lat: '0', lon: '999', display_name: 'Off the world' },
    // Coordinates but no name: nothing to show the operator.
    { lat: '43.17', lon: '-79.03' },
    { lat: '43.17', lon: '-79.03', display_name: '   ' },
  ])
    assert.equal(
      nominatimToGeocodeResult(hit),
      null,
      `${JSON.stringify(hit)} must not become a result`,
    );
});

test('a real hit carries its point, label, types and box', () => {
  const result = nominatimToGeocodeResult({
    lat: '43.1731',
    lon: '-79.0384',
    display_name: 'Niagara Falls, Ontario, Canada',
    name: 'Niagara Falls',
    addresstype: 'city',
    boundingbox: ['43.0500', '43.1500', '-79.1500', '-79.0000'],
  });
  assert.deepEqual(result.geometry.location, { lat: 43.1731, lng: -79.0384 });
  assert.equal(result.formatted_address, 'Niagara Falls, Ontario, Canada');
  assert.deepEqual(result.types, ['locality', 'political']);
  assert.deepEqual(result.geometry.bounds, {
    southwest: { lat: 43.05, lng: -79.15 },
    northeast: { lat: 43.15, lng: -79 },
  });
  assert.equal(result.address_components[0].long_name, 'Niagara Falls');
});

test('a box with an impossible or inverted edge is dropped, not framed', () => {
  for (const boundingbox of [
    undefined,
    [],
    ['43.05', '43.15', '-79.15'],
    ['43.05', '43.15', '-79.15', '999'],
    ['43.05', '43.15', '-999', '-79.0'],
    ['-91', '43.15', '-79.15', '-79.0'],
    ['43.05', '91', '-79.15', '-79.0'],
    [null, '43.15', '-79.15', '-79.0'],
    ['', '43.15', '-79.15', '-79.0'],
    // South above north is not a box.
    ['43.15', '43.05', '-79.15', '-79.0'],
  ]) {
    assert.equal(
      viewportFromNominatim({ boundingbox }),
      null,
      `${JSON.stringify(boundingbox)} must not become a viewport`,
    );
    const result = nominatimToGeocodeResult({
      lat: '43.1731',
      lon: '-79.0384',
      display_name: 'Somewhere',
      boundingbox,
    });
    assert.ok(result, 'the point itself still stands');
    assert.equal(
      result.geometry.bounds,
      undefined,
      'a place with no usable box is framed as a point',
    );
  }
});

test('types fall back to a place rather than guessing a category', () => {
  assert.deepEqual(typesFromNominatim({ addresstype: 'country' }), [
    'country',
    'political',
  ]);
  assert.deepEqual(typesFromNominatim({ class: 'highway', type: 'primary' }), [
    'route',
  ]);
  assert.deepEqual(typesFromNominatim({}), [
    'point_of_interest',
    'establishment',
  ]);
  assert.deepEqual(typesFromNominatim(null), [
    'point_of_interest',
    'establishment',
  ]);
});

test('a viewport hint is sent only when every edge is a real coordinate', () => {
  assert.equal(
    nominatimViewboxFromBounds('30.1,-97.95|30.52,-97.55'),
    '-97.95,30.52,-97.55,30.1',
  );

  for (const bounds of [
    null,
    undefined,
    '',
    'not bounds',
    '30.1,-97.95',
    // Out of range on each edge in turn.
    '-91,-97.95|30.52,-97.55',
    '30.1,-999|30.52,-97.55',
    '30.1,-97.95|91,-97.55',
    '30.1,-97.95|30.52,999',
    // Inverted latitudes are not a box.
    '30.52,-97.95|30.1,-97.55',
    '30.1,-97.95|30.1,-97.55',
  ])
    assert.equal(
      nominatimViewboxFromBounds(bounds),
      null,
      `${JSON.stringify(bounds)} must not become a viewbox`,
    );
});
