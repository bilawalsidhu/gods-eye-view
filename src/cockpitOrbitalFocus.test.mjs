// src/cockpitOrbitalFocus.test.mjs — the geometry of a ground focus in the
// orbital view: the look that centres a target, its off-nadir angle, the
// reach, the easing onto and off a target, and the reach list.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  ORBITAL_FOCUS_EASE_TAU_MS,
  easeFocusRemainder,
  focusEaseDtMs,
  focusInReach,
  focusLook,
  pointsInReach,
} from './cockpitOrbitalFocus.js';
import {
  ORBITAL_EARTH_RADIUS_M,
  nadirOrientation,
  offNadirAngleDeg,
  offNadirOrientation,
} from './cockpitOrbital.js';
import { LOOK_EASE_TAU_MS } from './cockpitLook.js';

const near = (actual, expected, label, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} not within ${tolerance} of ${expected}`,
  );

const unit = (v) => {
  const n = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / n, y: v.y / n, z: v.z / n };
};
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const angleBetweenDeg = (a, b) => {
  const u = unit(a);
  const v = unit(b);
  const cosine = Math.min(1, Math.max(-1, u.x * v.x + u.y * v.y + u.z * v.z));
  return (Math.acos(cosine) * 180) / Math.PI;
};

/** A point on a sphere of radius `radiusM`, ECEF. */
const onSphere = (latDeg, lonDeg, radiusM) => {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return {
    x: radiusM * Math.cos(lat) * Math.cos(lon),
    y: radiusM * Math.cos(lat) * Math.sin(lon),
    z: radiusM * Math.sin(lat),
  };
};

/** A point on the WGS84 ellipsoid, as the globe draws it. */
const geodeticToEcef = (latDeg, lonDeg, heightM = 0) =>
  Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, heightM);

const ISS_ALT_M = 420_000;
const satelliteAt = (latDeg, lonDeg, altitudeM = ISS_ALT_M) =>
  geodeticToEcef(latDeg, lonDeg, altitudeM);

test('the focus look turns the nadir frame onto the target exactly', () => {
  const satellite = satelliteAt(30, -97);
  for (const heading of [null, 0, 51.6, 200]) {
    const nadir = nadirOrientation(satellite, { headingDeg: heading });
    for (const [lat, lon] of [
      [31.5, -96],
      [28.2, -99.4],
      [30, -97],
      [32.9, -97.1],
    ]) {
      const target = geodeticToEcef(lat, lon, 300);
      const look = focusLook(nadir, satellite, target);
      const view = offNadirOrientation(nadir, {
        northDeg: look.pitchDeg,
        eastDeg: look.yawDeg,
      });
      near(
        angleBetweenDeg(view.direction, sub(target, satellite)),
        0,
        `centred at ${lat},${lon} heading ${heading}`,
        1e-5,
      );
      // The single angle the readout gives is the tilt's total angle.
      near(
        look.offNadirDeg,
        offNadirAngleDeg({ northDeg: look.pitchDeg, eastDeg: look.yawDeg }),
        'one off-nadir angle',
        1e-9,
      );
      assert.equal(look.visible, true);
    }
  }
});

test('the off-nadir angle is the angle between nadir and the line of sight', () => {
  // On a sphere: a target `central` radians from the sub-satellite point is
  // seen atan(R sin γ / (R + h − R cos γ)) off nadir.
  const R = ORBITAL_EARTH_RADIUS_M;
  const satellite = onSphere(10, 20, R + ISS_ALT_M);
  const nadir = nadirOrientation(satellite);
  for (const centralDeg of [0, 0.5, 2, 5, 12]) {
    const target = onSphere(10 + centralDeg, 20, R);
    const γ = (centralDeg * Math.PI) / 180;
    const expected =
      (Math.atan2(R * Math.sin(γ), R + ISS_ALT_M - R * Math.cos(γ)) * 180) /
      Math.PI;
    const look = focusLook(nadir, satellite, target);
    near(look.offNadirDeg, expected, `${centralDeg}° away`, 1e-9);
  }
  // Straight below reads zero, a real angle and not a missing one.
  const below = focusLook(nadir, satellite, onSphere(10, 20, R));
  near(below.offNadirDeg, 0, 'straight below', 1e-9);
  near(below.yawDeg, 0, 'no east', 1e-9);
  near(below.pitchDeg, 0, 'no north', 1e-9);
  assert.equal(focusInReach(below), true);
});

test('the reach is the arrows’ ±45° on each axis, facing the satellite', () => {
  assert.equal(focusInReach({ yawDeg: 45, pitchDeg: -45, visible: true }), true);
  assert.equal(focusInReach({ yawDeg: 45.01, pitchDeg: 0, visible: true }), false);
  assert.equal(focusInReach({ yawDeg: 0, pitchDeg: -45.01, visible: true }), false);
  assert.equal(focusInReach({ yawDeg: 0, pitchDeg: 0, visible: false }), false);
  assert.equal(focusInReach(null), false);
  assert.equal(focusInReach({ yawDeg: Number.NaN, pitchDeg: 0 }), false);

  // From geostationary height the far side of the Earth lies within a few
  // degrees of nadir, but it faces away.
  const satellite = satelliteAt(0, 0, 35_786_000);
  const nadir = nadirOrientation(satellite);
  const farSide = geodeticToEcef(0, 100, 0);
  const look = focusLook(nadir, satellite, farSide);
  assert.ok(Math.abs(look.yawDeg) < 45 && Math.abs(look.pitchDeg) < 45);
  assert.equal(look.visible, false);
  assert.equal(focusInReach(look), false);
  // A point near the sub-satellite point faces it.
  assert.equal(focusInReach(focusLook(nadir, satellite, geodeticToEcef(5, 5))), true);
});

test('a target slides out of reach as the satellite passes it', () => {
  const target = geodeticToEcef(0, 10, 0);
  const inReach = [];
  for (let lon = 10; lon >= -5; lon -= 1) {
    const satellite = satelliteAt(0, lon);
    inReach.push(focusInReach(focusLook(nadirOrientation(satellite), satellite, target)));
  }
  assert.equal(inReach[0], true, 'overhead');
  assert.equal(inReach.at(-1), false, '15° of longitude behind');
  // Once out, it stays out: the reach ends once, not on and off.
  const firstOut = inReach.indexOf(false);
  assert.ok(firstOut > 0);
  assert.ok(inReach.slice(firstOut).every((value) => value === false));
});

test('the turn onto a target eases on the slower focus clock and lands', () => {
  assert.equal(
    focusEaseDtMs(ORBITAL_FOCUS_EASE_TAU_MS),
    LOOK_EASE_TAU_MS,
    'one focus time constant is one look time constant',
  );
  assert.equal(focusEaseDtMs(Number.NaN), 0);
  assert.equal(focusEaseDtMs(-5), 0);
  let remainder = { yawDeg: -30, pitchDeg: 20 };
  let previous = Math.hypot(remainder.yawDeg, remainder.pitchDeg);
  let frames = 0;
  while ((remainder.yawDeg || remainder.pitchDeg) && frames < 500) {
    const before = remainder;
    remainder = easeFocusRemainder(remainder, 16);
    const size = Math.hypot(remainder.yawDeg, remainder.pitchDeg);
    assert.ok(size < previous, 'always closer');
    // No axis moves more than a tenth of the way in a frame, but for the
    // last few hundredths of a degree it lands on: a turn, not a cut.
    for (const axis of ['yawDeg', 'pitchDeg']) {
      const step = Math.abs(before[axis] - remainder[axis]);
      assert.ok(
        step <= Math.max(Math.abs(before[axis]) * 0.1, 0.06),
        `frame ${frames} ${axis}`,
      );
    }
    previous = size;
    frames += 1;
  }
  assert.deepEqual(remainder, { yawDeg: 0, pitchDeg: 0 }, 'lands exactly');
  // About three time constants close 95%; landing takes a little longer.
  assert.ok(frames * 16 > 2 * ORBITAL_FOCUS_EASE_TAU_MS, `${frames} frames`);
  assert.ok(frames * 16 < 12 * ORBITAL_FOCUS_EASE_TAU_MS, `${frames} frames`);
  assert.deepEqual(
    easeFocusRemainder({ yawDeg: 10, pitchDeg: -4 }, 16, { immediate: true }),
    { yawDeg: 0, pitchDeg: 0 },
    'reduced motion cuts',
  );
});

test('the reach list keeps points in reach or in frame, nearest first, bounded', () => {
  const satellite = satelliteAt(0, 0);
  const nadir = nadirOrientation(satellite);
  const candidates = [];
  // A row of points eastward, 0.1° apart: those up to ~3.7° are within the
  // 45° tilt, the rest beyond it.
  for (let i = 0; i < 80; i += 1)
    candidates.push({ key: `east-${i}`, position: geodeticToEcef(0, i * 0.1) });
  candidates.push({ key: 'far-side', position: geodeticToEcef(0, 180) });
  const entries = pointsInReach(candidates, { nadir, satellite });
  assert.ok(entries.every((entry) => entry.key !== 'far-side'));
  const angles = entries.map((entry) => entry.offNadirDeg);
  assert.deepEqual(angles, [...angles].sort((a, b) => a - b), 'nearest first');
  assert.equal(entries[0].key, 'east-0');
  assert.equal(entries[0].offNadirDeg, 0);
  // Only those within the 45° tilt are listed.
  assert.ok(entries.length > 0 && entries.length < 80);
  for (const entry of entries) assert.ok(Math.abs(entry.look.yawDeg) <= 45);
  const beyond = focusLook(nadir, satellite, candidates[entries.length].position);
  assert.ok(Math.abs(beyond.yawDeg) > 45, 'the next one east is past the reach');
  assert.deepEqual(pointsInReach([], { nadir, satellite }), []);
});

test('the horizon is the ground’s own: the WGS84 surface normal, not the centre line', () => {
  const target = geodeticToEcef(45, 0);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(target);
  const satelliteAtElevation = (elevationDeg) => {
    const e = Cesium.Math.toRadians(elevationDeg);
    const local = new Cesium.Cartesian3(0, -Math.cos(e) * 4e7, Math.sin(e) * 4e7);
    return Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3());
  };
  const below = satelliteAtElevation(-0.1);
  assert.equal(focusLook(nadirOrientation(below), below, target).visible, false);
  const above = satelliteAtElevation(0.1);
  assert.equal(focusLook(nadirOrientation(above), above, target).visible, true);
});
