// src/cockpitSubjects.test.mjs — the vessel camera profile and dead
// reckoning of AIS fixes between feed refreshes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VESSEL_BRIDGE_MIN_CLEARANCE_M,
  VESSEL_BRIDGE_PITCH_DEG,
  VESSEL_DEAD_RECKON_MAX_S,
  VESSEL_DEFAULT_EYE_HEIGHT_M,
  VESSEL_WATERLINE_PROBE_RADIUS_M,
  deadReckonVesselFix,
  vesselFixAgeSec,
  vesselCameraProfile,
  vesselWaterlineM,
  waterlineProbePoints,
} from './cockpitSubjects.js';

const EARTH_M_PER_DEG_LAT = 111_195;

test('the vessel camera profile puts the eye at the bridge, looking at the horizon', () => {
  assert.deepEqual(vesselCameraProfile({ eyeHeightM: 30 }), {
    forwardM: 0,
    upM: 30,
    pitchDeg: VESSEL_BRIDGE_PITCH_DEG,
    minClearanceM: VESSEL_BRIDGE_MIN_CLEARANCE_M,
  });
});

test('a vessel with no known eye height uses the default', () => {
  for (const info of [{}, { eyeHeightM: null }, null]) {
    assert.equal(vesselCameraProfile(info).upM, VESSEL_DEFAULT_EYE_HEIGHT_M);
  }
});

test('a fix advances along course over ground for its age', () => {
  const fixEpochMs = 1_000_000;
  const advanced = deadReckonVesselFix(
    {
      latitude: 0,
      longitude: 0,
      courseDeg: 0,
      speedMps: 10,
      fixEpochMs,
    },
    fixEpochMs + 60_000,
  );
  assert.equal(advanced.ageSec, 60);
  // Sixty seconds north at 10 m/s.
  assert.ok(
    Math.abs(advanced.latitude * EARTH_M_PER_DEG_LAT - 600) < 2,
    `expected ~600 m north, got ${advanced.latitude * EARTH_M_PER_DEG_LAT}`,
  );
  assert.ok(Math.abs(advanced.longitude) < 1e-9);
});

test('projection stops at the dead-reckoning limit', () => {
  const fixEpochMs = 0;
  const at = (ageSec) =>
    deadReckonVesselFix(
      { latitude: 0, longitude: 0, courseDeg: 90, speedMps: 5, fixEpochMs },
      fixEpochMs + ageSec * 1000,
    );
  const limit = at(VESSEL_DEAD_RECKON_MAX_S);
  const later = at(VESSEL_DEAD_RECKON_MAX_S * 4);
  assert.equal(later.longitude, limit.longitude);
  assert.equal(later.ageSec, VESSEL_DEAD_RECKON_MAX_S * 4);
});

test('a fix without time, course or speed stays where it was reported', () => {
  const fix = {
    latitude: 54.3,
    longitude: 10.1,
    courseDeg: null,
    speedMps: 6,
    fixEpochMs: 0,
  };
  assert.deepEqual(deadReckonVesselFix(fix, 30_000), {
    latitude: 54.3,
    longitude: 10.1,
    ageSec: 30,
  });
  assert.deepEqual(
    deadReckonVesselFix({ ...fix, courseDeg: 90, fixEpochMs: null }, 30_000),
    { latitude: 54.3, longitude: 10.1, ageSec: null },
  );
});

test('waterline probes ring the ship at the probe radius', () => {
  const points = waterlineProbePoints(48.859, 2.293);
  assert.equal(points.length, 9);
  assert.deepEqual(points[0], { lat: 48.859, lon: 2.293 });
  for (const point of points.slice(1)) {
    const northM = (point.lat - 48.859) * 111_320;
    const eastM =
      (point.lon - 2.293) * 111_320 * Math.cos((48.859 * Math.PI) / 180);
    assert.ok(
      Math.abs(Math.hypot(northM, eastM) - VESSEL_WATERLINE_PROBE_RADIUS_M) <
        0.01,
    );
  }
  assert.deepEqual(waterlineProbePoints(Number.NaN, 2), []);
});

test('the waterline is the lowest probe when it stands clear of the sea', () => {
  // The Seine at the Eiffel Tower: geoid 44.6 m, water about 71 m.
  assert.equal(vesselWaterlineM(44.6, [80, 71.2, 75, null, 90]), 71.2);
  // Swell and tile noise are the sea itself.
  assert.equal(vesselWaterlineM(44.6, [45.5, 46]), 44.6);
  // Under the sea surface (a dock, a bad tile) never sinks the ship.
  assert.equal(vesselWaterlineM(44.6, [30, 71]), 44.6);
  // Nothing sampled, or implausibly high.
  assert.equal(vesselWaterlineM(44.6, [undefined, Number.NaN]), 44.6);
  assert.equal(vesselWaterlineM(44.6, [9000]), 44.6);
});

test("a fix's age is read on each clock, so a fast client clock adds none", () => {
  const fixEpochMs = 1_800_000_000_000;
  // The refresh's newest fix is 10 s newer than this one; the client, its
  // clock five minutes fast, received the refresh 5 s ago.
  const receivedAtMs = fixEpochMs + 12_000 + 300_000;
  const fix = {
    latitude: 0,
    longitude: 0,
    courseDeg: 90,
    speedMps: 5,
    fixEpochMs,
    receivedAtMs,
    feedEpochMs: fixEpochMs + 10_000,
  };
  assert.equal(vesselFixAgeSec(fix, receivedAtMs + 5000), 15);
  assert.equal(deadReckonVesselFix(fix, receivedAtMs + 5000).ageSec, 15);
  // Without receive data the clocks are compared, never below zero.
  const bare = { fixEpochMs };
  assert.equal(vesselFixAgeSec(bare, fixEpochMs + 60_000), 60);
  assert.equal(vesselFixAgeSec(bare, fixEpochMs - 60_000), 0);
  assert.equal(vesselFixAgeSec({ fixEpochMs: null }, fixEpochMs), null);
});
