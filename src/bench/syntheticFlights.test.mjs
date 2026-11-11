// src/bench/syntheticFlights.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticFlights } from './syntheticFlights.js';

const EARTH_RADIUS_M = 6_371_000;
const toDegrees = (radians) => (radians * 180) / Math.PI;

test('the same seed gives the same fleet, another seed a different one', () => {
  const a = createSyntheticFlights({ count: 100, seed: 3 });
  const b = createSyntheticFlights({ count: 100, seed: 3 });
  const c = createSyntheticFlights({ count: 100, seed: 4 });
  assert.deepEqual(a.lat, b.lat);
  assert.deepEqual(a.lon, b.lon);
  assert.notDeepEqual(a.lat, c.lat);
});

test('positions, altitudes and speeds stay in plausible ranges', () => {
  const fleet = createSyntheticFlights({ count: 1000, seed: 1 });
  for (let i = 0; i < fleet.count; i++) {
    assert.ok(fleet.lat[i] >= -90 && fleet.lat[i] <= 90);
    assert.ok(fleet.lon[i] >= -180 && fleet.lon[i] < 180);
    assert.ok(fleet.alt[i] >= 1_000 && fleet.alt[i] <= 12_000);
    assert.ok(fleet.speed[i] >= 120 && fleet.speed[i] <= 250);
    assert.ok(fleet.heading[i] >= 0 && fleet.heading[i] < 360);
  }
});

test('rejects a negative or fractional count', () => {
  assert.throws(() => createSyntheticFlights({ count: -1 }), RangeError);
  assert.throws(() => createSyntheticFlights({ count: 1.5 }), RangeError);
});

test('an eastbound aircraft on the equator moves east by speed × time', () => {
  const fleet = createSyntheticFlights({ count: 1 });
  fleet.lat[0] = 0;
  fleet.lon[0] = 0;
  fleet.heading[0] = 90;
  fleet.speed[0] = 100;
  fleet.advance(10);
  assert.ok(Math.abs(fleet.lat[0]) < 1e-12);
  assert.ok(Math.abs(fleet.lon[0] - toDegrees(1_000 / EARTH_RADIUS_M)) < 1e-9);
});

test('a northbound aircraft on the equator moves north', () => {
  const fleet = createSyntheticFlights({ count: 1 });
  fleet.lat[0] = 0;
  fleet.lon[0] = 0;
  fleet.heading[0] = 0;
  fleet.speed[0] = 100;
  fleet.advance(10);
  assert.ok(Math.abs(fleet.lat[0] - toDegrees(1_000 / EARTH_RADIUS_M)) < 1e-9);
  assert.ok(Math.abs(fleet.lon[0]) < 1e-12);
});

test('longitude wraps across the antimeridian', () => {
  const fleet = createSyntheticFlights({ count: 1 });
  fleet.lat[0] = 0;
  fleet.lon[0] = 179.995;
  fleet.heading[0] = 90;
  fleet.speed[0] = 250;
  fleet.advance(10);
  assert.ok(fleet.lon[0] < -179.9 && fleet.lon[0] >= -180);
});

const NEAR = Object.freeze({
  lat: 40.7069,
  lng: -74.0128,
  radiusM: 3_000,
  count: 50,
});

/** Great-circle distance in metres on the fleet's spherical Earth. */
function haversineM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

test('the first near.count aircraft start within radiusM of the near point', () => {
  const fleet = createSyntheticFlights({ count: 1_000, seed: 7, near: NEAR });
  let farthest = 0;
  for (let i = 0; i < NEAR.count; i++) {
    const d = haversineM(NEAR.lat, NEAR.lng, fleet.lat[i], fleet.lon[i]);
    farthest = Math.max(farthest, d);
    assert.ok(d <= NEAR.radiusM + 1e-6, `aircraft ${i} is ${d} m away`);
    assert.ok(
      fleet.alt[i] >= 300 && fleet.alt[i] <= 3_000,
      `alt ${fleet.alt[i]}`,
    );
    assert.ok(fleet.heading[i] >= 0 && fleet.heading[i] < 360);
  }
  // Uniform over the disc, not bunched at the centre.
  assert.ok(farthest > NEAR.radiusM * 0.8, `farthest ${farthest}`);
});

test('near aircraft are spread over the disc area', () => {
  const near = { ...NEAR, count: 2_000 };
  const fleet = createSyntheticFlights({ count: 2_000, seed: 2, near });
  let inner = 0;
  for (let i = 0; i < near.count; i++) {
    const d = haversineM(near.lat, near.lng, fleet.lat[i], fleet.lon[i]);
    if (d <= near.radiusM / Math.SQRT2) inner++;
  }
  // Half the area lies inside radius / sqrt(2).
  assert.ok(
    Math.abs(inner / near.count - 0.5) < 0.05,
    `inner share ${inner / near.count}`,
  );
});

test('the rest of a fleet with near aircraft keeps the global ranges', () => {
  const fleet = createSyntheticFlights({ count: 1_000, seed: 7, near: NEAR });
  let far = 0;
  for (let i = NEAR.count; i < fleet.count; i++) {
    assert.ok(fleet.alt[i] >= 1_000 && fleet.alt[i] <= 12_000);
    assert.ok(fleet.speed[i] >= 120 && fleet.speed[i] <= 250);
    if (haversineM(NEAR.lat, NEAR.lng, fleet.lat[i], fleet.lon[i]) > 100_000)
      far++;
  }
  assert.ok(far > 900, `only ${far} aircraft spread over the globe`);
});

test('a fleet with near aircraft is deterministic for its seed', () => {
  const a = createSyntheticFlights({ count: 200, seed: 5, near: NEAR });
  const b = createSyntheticFlights({ count: 200, seed: 5, near: NEAR });
  const c = createSyntheticFlights({ count: 200, seed: 6, near: NEAR });
  assert.deepEqual(a.lat, b.lat);
  assert.deepEqual(a.lon, b.lon);
  assert.deepEqual(a.alt, b.alt);
  assert.notDeepEqual(a.lat, c.lat);
});

test('near aircraft fly slowly enough to stay in a city view during a run', () => {
  const fleet = createSyntheticFlights({ count: 100, seed: 3, near: NEAR });
  for (let i = 0; i < NEAR.count; i++)
    assert.ok(
      fleet.speed[i] >= 10 && fleet.speed[i] <= 40,
      `speed ${fleet.speed[i]}`,
    );
});

test('a near block can override its altitude and speed bands', () => {
  const near = {
    ...NEAR,
    minAltM: 60,
    maxAltM: 190,
    minSpeedMps: 1,
    maxSpeedMps: 5,
  };
  const fleet = createSyntheticFlights({ count: 300, seed: 9, near });
  for (let i = 0; i < near.count; i++) {
    assert.ok(fleet.alt[i] >= 60 && fleet.alt[i] <= 190, `alt ${fleet.alt[i]}`);
    assert.ok(
      fleet.speed[i] >= 1 && fleet.speed[i] <= 5,
      `speed ${fleet.speed[i]}`,
    );
  }
  assert.throws(
    () =>
      createSyntheticFlights({
        count: 10,
        near: { ...NEAR, count: 1, minAltM: 5, maxAltM: 4 },
      }),
    RangeError,
  );
});

test('rejects a near block larger than the fleet or with a bad radius', () => {
  assert.throws(
    () => createSyntheticFlights({ count: 10, near: { ...NEAR, count: 11 } }),
    RangeError,
  );
  assert.throws(
    () => createSyntheticFlights({ count: 10, near: { ...NEAR, count: 1.5 } }),
    RangeError,
  );
  assert.throws(
    () =>
      createSyntheticFlights({
        count: 10,
        near: { ...NEAR, count: 5, radiusM: -1 },
      }),
    RangeError,
  );
});

test('a near block of zero aircraft changes nothing but the stream position', () => {
  const fleet = createSyntheticFlights({
    count: 0,
    near: { ...NEAR, count: 0 },
  });
  assert.equal(fleet.count, 0);
});
