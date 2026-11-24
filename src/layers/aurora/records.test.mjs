import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OVATION_HEIGHT,
  OVATION_WIDTH,
  auroraBandCounts,
  auroraColor,
  auroraPixels,
  auroraReach,
  ovationAt,
  parseKp,
  parseOvation,
  parseScales,
  parseSolarWind,
  parseUtc,
} from './records.js';

/** An OVATION payload whose value at each node is `valueAt(lon, lat)`. */
function ovationPayload(valueAt = () => 0) {
  const coordinates = [];
  for (let lon = 0; lon < OVATION_WIDTH; lon++)
    for (let lat = -90; lat <= 90; lat++)
      coordinates.push([lon, lat, valueAt(lon, lat)]);
  return {
    'Observation Time': '2026-11-24T15:52:00Z',
    'Forecast Time': '2026-11-24T17:13:00Z',
    'Data Format': '[Longitude, Latitude, Aurora]',
    coordinates,
    type: 'MultiPoint',
  };
}

test('the OVATION grid is read by node and dated by its own times', () => {
  const { grid, observedAt, forecastAt } = parseOvation(
    ovationPayload((lon, lat) => (lon === 10 && lat === 65 ? 42 : 0)),
  );
  assert.equal(grid.length, OVATION_WIDTH * OVATION_HEIGHT);
  assert.equal(ovationAt(grid, 10, 65), 42);
  // Longitude wraps: -350 is 10°E.
  assert.equal(ovationAt(grid, -350, 65), 42);
  assert.equal(ovationAt(grid, 11, 65), 0);
  assert.equal(observedAt, Date.parse('2026-11-24T15:52:00Z'));
  assert.equal(forecastAt, Date.parse('2026-11-24T17:13:00Z'));
});

test('values are clamped to whole percent and malformed payloads are refused', () => {
  const { grid } = parseOvation(
    ovationPayload((lon, lat) => (lat === 70 ? (lon === 0 ? 140 : -5) : 1.6)),
  );
  assert.equal(ovationAt(grid, 0, 70), 100);
  assert.equal(ovationAt(grid, 1, 70), 0);
  assert.equal(ovationAt(grid, 1, 0), 2);
  assert.throws(() => parseOvation({}), /Malformed NOAA SWPC response/);
  assert.throws(
    () => parseOvation({ coordinates: [[0, 0, 1]] }),
    /Malformed NOAA SWPC response/,
  );
  assert.throws(
    () =>
      parseOvation({
        coordinates: Array.from({ length: 40000 }, () => ['x', 'y', 'z']),
      }),
    /Malformed NOAA SWPC response/,
  );
});

test('the image is a north-up world from -180°, transparent below 3%', () => {
  const { grid } = parseOvation(
    ovationPayload((lon, lat) => (lat >= 60 && lat <= 70 ? 60 : 0)),
  );
  const { width, height, data } = auroraPixels(grid);
  assert.equal(width, 360);
  assert.equal(height, 180);
  const alphaAt = (lon, north) =>
    data[((90 - north) * width + (lon + 180)) * 4 + 3];
  // The cell from 65°N to 64°N is inside the band at every longitude.
  assert.ok(alphaAt(-180, 65) > 0);
  assert.ok(alphaAt(179, 65) > 0);
  assert.equal(alphaAt(0, 30), 0);
  assert.equal(alphaAt(0, -65), 0);
  assert.deepEqual(auroraColor(2), [0, 0, 0, 0]);
  // The fringe is fainter than the core; past 30% strength shows as red.
  const [, , , a10] = auroraColor(10);
  const [r30, , , a30] = auroraColor(30);
  const [r80, , , a80] = auroraColor(80);
  assert.ok(a10 < a30);
  assert.equal(a80, a30);
  assert.ok(r80 > r30);
});

test('band counts and reach describe how strong and how far the oval is', () => {
  const { grid } = parseOvation(
    ovationPayload((lon, lat) => {
      if (lat === 55 && lon === 100) return 35;
      if (lat === 67) return 12;
      if (lat === -62 && lon === 5) return 55;
      return 0;
    }),
  );
  assert.deepEqual(auroraBandCounts(grid), {
    10: OVATION_WIDTH + 2,
    30: 2,
    50: 1,
  });
  assert.deepEqual(auroraReach(grid, 10), { north: 55, south: -62 });
  assert.deepEqual(auroraReach(grid, 50), { north: null, south: -62 });
});

test('Kp, NOAA scales and solar wind come from the current SWPC products', () => {
  assert.deepEqual(
    parseKp([
      { time_tag: '2026-11-24T09:00:00', Kp: 2.33 },
      { time_tag: '2026-11-24T12:00:00', Kp: 3.67 },
      { time_tag: '2026-11-24T15:00:00', Kp: null },
    ]),
    { value: 3.67, at: Date.parse('2026-11-24T12:00:00Z') },
  );
  // The older product: a header row, then strings.
  assert.deepEqual(
    parseKp([
      ['time_tag', 'Kp'],
      ['2026-11-24 12:00:00.000', '4.00'],
    ]),
    { value: 4, at: parseUtc('2026-11-24 12:00:00.000') },
  );
  assert.equal(parseKp(null), null);
  assert.deepEqual(
    parseScales({
      0: { R: { Scale: '1' }, S: { Scale: '0' }, G: { Scale: '3' } },
      1: { R: { Scale: null }, S: { Scale: null }, G: { Scale: '2' } },
    }),
    { r: 1, s: 0, g: 3 },
  );
  assert.equal(parseScales({ 0: { R: {}, S: {}, G: {} } }), null);
  assert.deepEqual(
    parseSolarWind(
      [{ proton_speed: 512, time_tag: '2026-11-24T15:55:00Z' }],
      [{ bt: 9, bz_gsm: -7, time_tag: '2026-11-24T15:55:00Z' }],
    ),
    {
      speedKms: 512,
      bzNt: -7,
      btNt: 9,
      at: Date.parse('2026-11-24T15:55:00Z'),
    },
  );
  assert.equal(parseSolarWind(null, []), null);
});
