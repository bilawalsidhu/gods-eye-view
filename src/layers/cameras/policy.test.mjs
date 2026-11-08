import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_DEFAULTS,
  DEFAULT_TARGET_SIZE_M,
  FOV_LIMITS_DEG,
  autoFovRad,
  chaseOffsetEnu,
  normalizeCamera,
  normalizeCameraList,
  orbitOffsetEnu,
  placedGroundCamera,
  smoothingAlpha,
} from './policy.js';

const DEG = Math.PI / 180;

test('normalizeCamera fills per-type defaults and keeps authored values', () => {
  const ground = normalizeCamera({ id: 'g', lat: 37.8, lon: -122.4, target: 'a1' });
  assert.equal(ground.type, 'ground');
  assert.equal(ground.heightM, CAMERA_DEFAULTS.ground.heightM);
  assert.equal(ground.altitudeReference, 'ground');
  assert.equal(ground.fovDeg, null, 'tripods zoom automatically by default');
  assert.equal(ground.title, 'g');
  const chase = normalizeCamera({ id: 'c', type: 'chase', distanceM: 100 });
  assert.equal(chase.distanceM, 100);
  assert.equal(chase.heightOffsetM, CAMERA_DEFAULTS.chase.heightOffsetM);
  assert.equal(chase.fovDeg, CAMERA_DEFAULTS.chase.fovDeg);
  assert.equal(chase.target, null);
  const orbit = normalizeCamera({ id: 'o', type: 'orbit', periodS: 10, phaseDeg: 90 });
  assert.equal(orbit.periodS, 10);
  assert.equal(orbit.phaseDeg, 90);
});

test('normalizeCamera refuses bad descriptors', () => {
  assert.throws(() => normalizeCamera({ id: 'Bad' }), /id/);
  assert.throws(() => normalizeCamera({ id: 'x', type: 'drone' }), /type/);
  assert.throws(() => normalizeCamera({ id: 'x' }), /lat\/lon/);
  assert.throws(
    () => normalizeCamera({ id: 'x', lat: 0, lon: 0, altitudeReference: 'msl' }),
    /altitudeReference/,
  );
  assert.throws(() => normalizeCamera({ id: 'x', lat: 0, lon: 0, fovDeg: 500 }), /fovDeg/);
  assert.throws(() => normalizeCamera({ id: 'x', type: 'chase', distanceM: 1 }), /distanceM/);
});

test('normalizeCameraList checks ids and targets against the aircraft', () => {
  assert.deepEqual(normalizeCameraList(undefined), []);
  assert.throws(() => normalizeCameraList({}), /array/);
  const ok = normalizeCameraList(
    [{ id: 'a', lat: 0, lon: 0, target: 'jet' }],
    ['jet'],
  );
  assert.equal(ok.length, 1);
  assert.throws(
    () => normalizeCameraList([{ id: 'a', lat: 0, lon: 0, target: 'ghost' }], ['jet']),
    /not an aircraft/,
  );
  assert.throws(
    () => normalizeCameraList([{ id: 'a', lat: 0, lon: 0 }, { id: 'a', lat: 0, lon: 0 }]),
    /repeats/,
  );
});

test('autoFovRad keeps the target at the frame fraction and respects limits', () => {
  // A 40 m target filling 20% of the frame at 1 km: frame height 200 m.
  const fov = autoFovRad({ distanceM: 1000, targetSizeM: 40, frameFraction: 0.2 });
  const frameHeight = 2 * 1000 * Math.tan(fov / 2);
  assert.ok(Math.abs(frameHeight - 200) < 1e-6);
  assert.equal(autoFovRad({ distanceM: 1e9 }), FOV_LIMITS_DEG[0] * DEG);
  assert.equal(autoFovRad({ distanceM: 1 }), FOV_LIMITS_DEG[1] * DEG);
  assert.equal(autoFovRad({ distanceM: 0 }), FOV_LIMITS_DEG[1] * DEG);
  assert.equal(autoFovRad({ distanceM: 1000, fixedFovDeg: 30 }), 30 * DEG);
  const defaultSize = autoFovRad({ distanceM: 1000, frameFraction: 0.2 });
  const explicit = autoFovRad({ distanceM: 1000, targetSizeM: DEFAULT_TARGET_SIZE_M, frameFraction: 0.2 });
  assert.equal(defaultSize, explicit);
});

test('smoothingAlpha is 0 for no time, 1 for no smoothing, and grows with dt', () => {
  assert.equal(smoothingAlpha(0, 1), 0);
  assert.equal(smoothingAlpha(0.1, 0), 1);
  const a = smoothingAlpha(0.1, 0.5);
  const b = smoothingAlpha(0.5, 0.5);
  assert.ok(a > 0 && a < b && b < 1);
  assert.ok(Math.abs(b - (1 - Math.exp(-1))) < 1e-12);
});

test('chase sits behind the track and orbit circles with the clock', () => {
  const north = chaseOffsetEnu({ headingDeg: 0, distanceM: 100, heightOffsetM: 10 });
  assert.ok(Math.abs(north.east) < 1e-9 && Math.abs(north.north + 100) < 1e-9);
  assert.equal(north.up, 10);
  const east = chaseOffsetEnu({ headingDeg: 90, distanceM: 100, lateralM: 20 });
  assert.ok(Math.abs(east.east + 100) < 1e-9, 'behind an eastbound target is west');
  assert.ok(Math.abs(east.north + 20) < 1e-9, 'right of an eastbound track is south');
  const start = orbitOffsetEnu({ timeS: 0, periodS: 40, radiusM: 50, heightOffsetM: 5 });
  assert.ok(Math.abs(start.east) < 1e-9 && Math.abs(start.north - 50) < 1e-9);
  const quarter = orbitOffsetEnu({ timeS: 10, periodS: 40, radiusM: 50 });
  assert.ok(Math.abs(quarter.east - 50) < 1e-9 && Math.abs(quarter.north) < 1e-9);
  const phased = orbitOffsetEnu({ timeS: 0, periodS: 40, radiusM: 50, phaseDeg: 180 });
  assert.ok(Math.abs(phased.north + 50) < 1e-9);
});

test('placedGroundCamera is an ellipsoid-height tripod with a session id', () => {
  const camera = placedGroundCamera(
    { lat: 37.8, lon: -122.4, heightM: 25 },
    'a1',
    3,
    'Camera 3',
  );
  assert.equal(camera.id, 'session-3');
  assert.equal(camera.title, 'Camera 3');
  assert.equal(placedGroundCamera({ lat: 0, lon: 0, heightM: 1 }, null, 4).title, 'session-4');
  assert.equal(camera.altitudeReference, 'ellipsoid');
  assert.equal(camera.heightM, 25);
  assert.equal(camera.target, 'a1');
});
