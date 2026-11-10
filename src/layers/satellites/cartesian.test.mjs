import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { twoline2satrec } from 'satellite.js';
import { createOrbits } from './orbits.js';

const line1 =
  '1 25544U 98067A   26314.50000000  .00016717  00000-0  10270-3 0  9004';
const cases = [
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49814310 12345',
  '2 25544  89.9000  15.4627 0006703 130.5360 325.0288 14.49814310 12345',
  '2 25544   0.1000 247.4627 0001000 130.5360 325.0288  1.00270000 12345',
  '2 25544  63.4000 247.4627 7000000 130.5360 325.0288  2.00600000 12345',
];

test('dot ECEF agrees with rich geodetic answers to a millimetre for LEO, polar, GEO and eccentric orbits', () => {
  const orbits = createOrbits({ state: {}, parts: {}, services: {} });
  const result = new C.Cartesian3();
  let maxError = 0;
  for (const line2 of cases) {
    const a = twoline2satrec(line1, line2),
      b = twoline2satrec(line1, line2);
    for (const offset of [-86400000, 0, 3600000, 86400000, 259200000]) {
      const now = new Date(Date.UTC(2026, 10, 10, 12) + offset);
      const rich = orbits.propagatePosition(a, now);
      assert.ok(rich);
      const fast = orbits.propagateCartesian(b, now, result);
      assert.equal(fast, result, 'caller owns reusable output');
      maxError = Math.max(
        maxError,
        C.Cartesian3.distance(
          fast,
          C.Cartesian3.fromDegrees(
            rich.longitude,
            rich.latitude,
            rich.altitude,
          ),
        ),
      );
    }
  }
  assert.ok(maxError < 0.001, `maximum displacement ${maxError} metres`);
});

test('same-time batches reuse rotation and mutated/reversed dates invalidate it', () => {
  const orbits = createOrbits({ state: {}, parts: {}, services: {} });
  const sat = twoline2satrec(line1, cases[0]);
  const now = new Date(Date.UTC(2026, 10, 10, 12));
  const out = new C.Cartesian3();
  const first = C.Cartesian3.clone(orbits.propagateCartesian(sat, now, out));
  assert.deepEqual(orbits.propagateCartesian(sat, new Date(+now), out), first);
  now.setTime(+now + 3600000);
  assert.notDeepEqual(orbits.propagateCartesian(sat, now, out), first);
  now.setTime(+now - 3600000);
  assert.ok(
    C.Cartesian3.distance(orbits.propagateCartesian(sat, now, out), first) <
      0.001,
  );
  assert.equal(orbits.propagateCartesian(null, now, out), null);
  assert.equal(orbits.propagateCartesian(sat, new Date(NaN), out), null);
});
