// COORDINATE PARSING — what the search box accepts as a coordinate, and what it
// refuses. A refusal hands the text to the geocoders; a wrong accept flies the
// operator somewhere they never asked for and looks like success, so every
// malformed and ambiguous form below is pinned.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCoordinateQuery,
  formatCoordinateLabel,
} from './coordinateParser.js';

test('a plain decimal pair is latitude then longitude', () => {
  assert.deepEqual(parseCoordinateQuery('43.1731, -79.0384'), {
    lat: 43.1731,
    lon: -79.0384,
    label: '43.1731° N, 79.0384° W',
  });
  assert.deepEqual(parseCoordinateQuery('43.1731,-79.0384')?.lat, 43.1731);
  assert.deepEqual(
    parseCoordinateQuery('  43.1731 ; -79.0384 ')?.lon,
    -79.0384,
  );
  assert.deepEqual(parseCoordinateQuery('43.1731 -79.0384')?.lon, -79.0384);
  assert.deepEqual(parseCoordinateQuery('0, 0'), {
    lat: 0,
    lon: 0,
    label: '0.0000° N, 0.0000° E',
  });
  assert.deepEqual(parseCoordinateQuery('-33.8568, 151.2153')?.lat, -33.8568);
  assert.deepEqual(parseCoordinateQuery('30, -97')?.lat, 30);
  assert.deepEqual(parseCoordinateQuery('.5, -.25')?.lon, -0.25);
});

test('hemisphere letters fix the axis, in either order', () => {
  assert.deepEqual(parseCoordinateQuery('N 40, W 74'), {
    lat: 40,
    lon: -74,
    label: '40.0000° N, 74.0000° W',
  });
  // The reviewer's case: written longitude-first, it must not read as latitude.
  assert.deepEqual(parseCoordinateQuery('W 40, N 74'), {
    lat: 74,
    lon: -40,
    label: '74.0000° N, 40.0000° W',
  });
  assert.deepEqual(parseCoordinateQuery('40N, 74W')?.lon, -74);
  assert.deepEqual(parseCoordinateQuery('74w, 40n'), {
    lat: 40,
    lon: -74,
    label: '40.0000° N, 74.0000° W',
  });
  assert.deepEqual(parseCoordinateQuery('40° N, 74° W')?.lat, 40);
  // Written the way a coordinate is usually pasted, with no comma.
  assert.deepEqual(parseCoordinateQuery('40.7128 N 74.0060 W'), {
    lat: 40.7128,
    lon: -74.006,
    label: '40.7128° N, 74.0060° W',
  });
  assert.deepEqual(parseCoordinateQuery('40.7128° N 74.0060° W')?.lon, -74.006);
  assert.deepEqual(parseCoordinateQuery('N 40.7128 W 74.0060'), {
    lat: 40.7128,
    lon: -74.006,
    label: '40.7128° N, 74.0060° W',
  });
  assert.deepEqual(parseCoordinateQuery('74.0060 W 40.7128 N')?.lat, 40.7128);
  // One letter is enough: it fixes its own axis, the other takes what is left.
  assert.deepEqual(parseCoordinateQuery('40 N, -74')?.lon, -74);
  assert.deepEqual(parseCoordinateQuery('-74, 40 N'), {
    lat: 40,
    lon: -74,
    label: '40.0000° N, 74.0000° W',
  });
});

test('malformed and ambiguous coordinates are refused, never guessed', () => {
  for (const query of [
    // The reviewer's case: trailing text must not be discarded.
    '12junk, 34oops',
    '12junk,34',
    '12junk 34',
    '1e3 5',
    '1e3',
    '1E3',
    '1e-3',
    '1.2.3',
    '12-34',
    '40 NW 74',
    '40 N 74',
    '40 W 74',
    '40 E 74',
    '°40 74',
    '40°° 74',
    '40 74°°',
    '40 26 46 N 79 58 56 W',
    '43.1731, -79.0384x',
    'abc, def',
    'Paris',
    'New York, NY',
    '',
    '   ',
    ',',
    '40',
    '40,',
    ', 74',
    '40, 74, 12',
    '40.0.0, 74',
    '1e3, 5',
    '0x40, 74',
    '40 74 12',
    // Two letters naming the same axis leaves the other axis unstated.
    'N 40, N 74',
    'E 40, W 74',
    'S 40, 40 S',
    // A sign and a letter both claim the direction.
    '-40N, 74W',
    'N -40, W 74',
    // Two letters on one component.
    'N40W, 74',
    // Out of range.
    '91, 0',
    '-90.1, 0',
    '0, 181',
    '0, -180.5',
    'N 100, W 74',
    // Degrees/minutes/seconds is out of scope and must fall through, not
    // be read as a decimal pair.
    '40°26\'46"N, 79°58\'56"W',
    '40 26 46, 79 58 56',
    // A grid reference is out of scope too.
    '33UXP0500444998',
  ]) {
    assert.equal(
      parseCoordinateQuery(query),
      null,
      `${JSON.stringify(query)} must be refused`,
    );
  }
});

test('non-strings are refused without throwing', () => {
  for (const query of [null, undefined, 42, {}, [], ['40', '74']])
    assert.equal(parseCoordinateQuery(query), null);
});

test('the label reads the way a coordinate is written', () => {
  assert.equal(
    formatCoordinateLabel(43.1731, -79.0384),
    '43.1731° N, 79.0384° W',
  );
  assert.equal(
    formatCoordinateLabel(-33.8568, 151.2153),
    '33.8568° S, 151.2153° E',
  );
  assert.equal(formatCoordinateLabel(0, 0), '0.0000° N, 0.0000° E');
});

test('the poles and the dateline are inside the accepted range', () => {
  assert.deepEqual(parseCoordinateQuery('90, 180')?.lat, 90);
  assert.deepEqual(parseCoordinateQuery('-90, -180')?.lon, -180);
});

test('two-dimensional WGS84 geo URIs resolve to the same decimal coordinate', () => {
  for (const query of [
    'geo:39.7392,-104.9903',
    'geo:39.7392,-104.9903;crs=wgs84',
    '  GEO:39.7392,-104.9903;CRS=WGS84  ',
  ]) {
    assert.deepEqual(parseCoordinateQuery(query), {
      lat: 39.7392,
      lon: -104.9903,
      label: '39.7392° N, 104.9903° W',
    });
  }
  for (const [query, decimal] of [
    ['geo:0,0', '0,0'],
    ['geo:-33.8568,151.2153', '-33.8568,151.2153'],
    ['geo:90,180', '90,180'],
    ['geo:-90,-180;crs=wgs84', '-90,-180'],
    ['geo:09,007', '9,7'],
    ['geo:-0,-0', '-0,-0'],
  ]) {
    assert.deepEqual(
      parseCoordinateQuery(query),
      parseCoordinateQuery(decimal),
    );
  }
});

test('malformed or unsupported geo URIs are refused without losing their meaning', () => {
  for (const query of [
    'geo:',
    'geo:39.7392',
    'geo:,104.9903',
    'geo:39.7392,,104.9903',
    'geo:39.7392,-104.9903,',
    'geo:91,0',
    'geo:-90.1,0',
    'geo:0,181',
    'geo:0,-180.1',
    'geo:000,0',
    'geo:0,0000',
    'geo:+39.7392,-104.9903',
    'geo:.5,-.25',
    'geo:1e1,2',
    'geo:NaN,0',
    'geo:Infinity,0',
    'geo:39.7392, -104.9903',
    'geo:39.7392;-104.9903',
    'geo:39.7392N,104.9903W',
    'geo:39.7392,-104.9903,1600',
    'geo:39.7392,-104.9903;u=10',
    'geo:39.7392,-104.9903;crs=unknown',
    'geo:39.7392,-104.9903;crs=wgs84;crs=wgs84',
    'geo:39.7392,-104.9903;crs=wgs84;u=0',
    'geo:39.7392,-104.9903;custom=value',
    'geo:0,0?q=39.7392,-104.9903(Denver)',
    'geo:39.7392,-104.9903#Denver',
    'geo:39.7392,-104.9903 trailing text',
    'geo://39.7392,-104.9903',
    'https://example.com/geo:39.7392,-104.9903',
  ]) {
    assert.equal(parseCoordinateQuery(query), null, query);
  }
});

test('whitespace boundaries preserve degree signs and hemisphere ownership', () => {
  for (const query of ['40 ° 74', '40° 74', '40 N, 74', 'N 40 74']) {
    assert.equal(parseCoordinateQuery(query)?.lat, 40, query);
    assert.equal(parseCoordinateQuery(query)?.lon, 74, query);
  }
  for (const query of ['40 ° N 74 ° W', 'N 40 ° W 74 °', '40\tN\n74\tW']) {
    assert.equal(parseCoordinateQuery(query)?.lat, 40, query);
    assert.equal(parseCoordinateQuery(query)?.lon, -74, query);
  }
});

test('a signed plain component leaves a spaced letter with the other component', () => {
  assert.deepEqual(
    parseCoordinateQuery('-40 N 74'),
    parseCoordinateQuery('-40, N 74'),
  );
  assert.deepEqual(
    parseCoordinateQuery('40 N -74'),
    parseCoordinateQuery('40 N, -74'),
  );
});
