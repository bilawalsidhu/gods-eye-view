// Edge cases for wind: on a fixed
// grid direction, speed and legend agree whichever way the centre is picked,
// and an empty field is never presented as calm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWindAtCenter } from './inspection.js';
import { windReadingResult } from './presentation.js';
import { sampleWind, windColor, windSpeed } from './model.js';
import { windStats } from './index.js';
import * as geo from '../../geo/index.js';

const at = (lonDeg, latDeg) => geo.cartesian3.fromDegrees(lonDeg, latDeg);
const grid = { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 };
const field = (u, v) => ({
  grid,
  u: Float32Array.from({ length: 12 }, () => u),
  v: Float32Array.from({ length: 12 }, () => v),
});
const options = {
  units: 'km/h',
  overlay: 'speed',
  model: 'GFS',
  validTime: '2026-09-14 18:00 UTC',
  status: 'Model forecast',
};
/** Inspect either the current map centre or a captured position. */
const viaEngine = (snapshot, point) =>
  inspectWindAtCenter(
    snapshot,
    {
      camera: { pickEllipsoid: () => point },
      host: { canvas: { clientWidth: 800, clientHeight: 600 } },
    },
    options,
  );
const viaPosition = (snapshot, point) =>
  inspectWindAtCenter(snapshot, null, { ...options, position: point });
const windLine = (reading) =>
  windReadingResult(reading).lines.find(({ id }) => id === 'wind').text;

test('edge:wind: a fixed grid gives the same direction, speed and legend colour on both pick paths', () => {
  // 5 m/s blowing toward the west: the wind comes FROM the east.
  const snapshot = field(-5, 0);
  for (const point of [at(10, 20), at(180, 0), at(-180, 0), at(-45.5, -60)]) {
    const cesiumReading = viaEngine(snapshot, point);
    const navaraReading = viaPosition(snapshot, point);
    for (const reading of [cesiumReading, navaraReading]) {
      assert.equal(reading.from, 'E');
      assert.equal(reading.speed, 5);
      assert.equal(reading.wind, '18.0 km/h from E');
      assert.equal(reading.scalarValue, '18.0 km/h');
    }
    assert.deepEqual(navaraReading, { ...cesiumReading });
    assert.equal(windColor(navaraReading.speed), windColor(5));
  }
  // The seam is one place, not two.
  const east = sampleWind({ ...grid, ...snapshot }, 180, 0);
  const west = sampleWind({ ...grid, ...snapshot }, -180, 0);
  assert.deepEqual(east, west);
  assert.equal(windSpeed(east.u, east.v), 5);
});

test('edge:wind: an empty or unavailable field is not reported as calm, a real 0 m/s field is', () => {
  const point = at(10, 20);
  const calm = viaPosition(field(0, 0), point);
  assert.equal(calm.speed, 0);
  assert.equal(calm.from, 'Calm');
  assert.equal(calm.wind, '0.0 km/h · calm');

  const empty = [
    null,
    { unavailable: true, reason: 'Wind upstream unavailable' },
    { grid, u: null, v: null },
    // A field whose arrays hold no cells at all.
    { grid, u: new Float32Array(0), v: new Float32Array(0) },
  ];
  for (const snapshot of empty) {
    for (const reading of [
      viaEngine(snapshot, point),
      viaPosition(snapshot, point),
    ]) {
      assert.equal(reading.speed, undefined, 'no speed is invented');
      assert.equal(reading.from, undefined, 'no direction is invented');
      assert.equal(reading.coordinates, 'No surface reading');
      assert.doesNotMatch(windLine(reading), /calm|NaN|undefined/i);
    }
  }
  assert.equal(windStats(null).count, 0);
  assert.equal(windStats({ unavailable: true }).error, 'Wind unavailable');
});
