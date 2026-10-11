import test from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import { lookAnglesAt } from './satellitePass.js';
const satrec = () =>
  twoline2satrec(
    '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
  );
test('invalid observer evidence cannot yield plausible or nonfinite look angles', () => {
  const time = Date.UTC(2008, 8, 20, 12, 30);
  for (const [lat, lon] of [
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
    [NaN, 0],
    [null, 0],
    ['30', 0],
  ])
    assert.equal(lookAnglesAt(satrec(), time, lat, lon), null);
  for (const ms of [NaN, Infinity, null, 1e30])
    assert.equal(lookAnglesAt(satrec(), ms, 30, -97), null);
  for (const [lat, lon] of [
    [0, 0],
    [90, 180],
    [-90, -180],
  ]) {
    const result = lookAnglesAt(satrec(), time, lat, lon);
    assert.ok(
      result &&
        Number.isFinite(result.elevDeg) &&
        Number.isFinite(result.azDeg),
    );
  }
});
