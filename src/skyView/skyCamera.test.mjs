import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees } from '../geo/ellipsoid.js';
import { distance } from '../geo/vector.js';
import { createObserver } from './observer.js';
import {
  applySkyCamera,
  applySkyScene,
  applySkyTime,
  COLLISION_CEILING_M,
  collisionRestoreLifts,
  holdSkyTime,
  readCameraAzEl,
  restoreCamera,
  restoreScene,
  skyFovy,
  snapshotCamera,
  skyTilesShown,
  snapshotScene,
  takeSkyControls,
  worldDirectionToAzEl,
} from './skyCamera.js';
import {
  EL_MAX_DEG,
  EL_MIN_DEG,
  fovAngles,
  makeView,
  normalizeAz,
} from './skyMath.js';
import { createSkyTestHost } from '../testSupport/skyTestHost.mjs';

const DEG = Math.PI / 180;
const HOUSTON = createObserver({
  latDeg: 29.7604,
  lonDeg: -95.3698,
  groundHeightM: 15,
  heightKnown: true,
});

const azDiff = (a, b) => {
  const d = Math.abs(normalizeAz(a) - normalizeAz(b));
  return d > 180 ? 360 - d : d;
};

test('az/el -> camera setView -> camera heading/pitch AND world direction round trip within 0.01 deg on a 1-degree grid', () => {
  const { camera } = createSkyTestHost();
  let worstEl = 0;
  let worstAz = 0;
  let checked = 0;
  for (let az = 0; az < 360; az += 1) {
    for (let el = EL_MIN_DEG; el <= EL_MAX_DEG; el += 1) {
      applySkyCamera(
        camera,
        HOUSTON,
        makeView({ azDeg: az, elDeg: el, fovDeg: 60 }),
      );
      const read = readCameraAzEl(camera);
      const pose = camera.pose();
      const world = worldDirectionToAzEl(pose.position, pose.direction);
      worstEl = Math.max(
        worstEl,
        Math.abs(read.elDeg - el),
        Math.abs(world.elDeg - el),
      );
      // The world look direction must match everywhere below the zenith.
      // The heading reading is unreliable within ~2 deg of the zenith (it
      // switches to the up vector there), so it is only compared below that
      // band.
      if (el < 90) worstAz = Math.max(worstAz, azDiff(world.azDeg, az));
      if (el < 88) worstAz = Math.max(worstAz, azDiff(read.azDeg, az));
      checked += 1;
    }
  }
  assert.equal(checked, 360 * 101);
  assert.ok(worstEl < 0.01, `worst el error ${worstEl}`);
  assert.ok(worstAz < 0.01, `worst az error ${worstAz}`);
});

test('worldDirectionToAzEl reads az/el in the east-north-up frame, independent of the camera', () => {
  const position = fromDegrees(-95.3698, 29.7604, 16.7);
  const north = { x: 0, y: 0, z: 1 };
  // At Houston the pole axis is up and to the north: tilting it onto the
  // horizontal plane gives due north.
  const up = fromDegrees(-95.3698, 29.7604, 1);
  const normal = {
    x: up.x - fromDegrees(-95.3698, 29.7604, 0).x,
    y: up.y - fromDegrees(-95.3698, 29.7604, 0).y,
    z: up.z - fromDegrees(-95.3698, 29.7604, 0).z,
  };
  const dot = north.z * normal.z;
  const horizontalNorth = {
    x: north.x - normal.x * dot,
    y: north.y - normal.y * dot,
    z: north.z - normal.z * dot,
  };
  const a = worldDirectionToAzEl(position, horizontalNorth);
  assert.ok(Math.abs(a.elDeg) < 1e-6, String(a.elDeg));
  assert.ok(azDiff(a.azDeg, 0) < 1e-6, String(a.azDeg));
  const zenith = worldDirectionToAzEl(position, normal);
  assert.ok(Math.abs(zenith.elDeg - 90) < 1e-6, String(zenith.elDeg));
});

test('applySkyCamera puts the eye at ground + 1.7 m and holds the fov', () => {
  const { camera } = createSkyTestHost();
  applySkyCamera(
    camera,
    HOUSTON,
    makeView({ azDeg: 10, elDeg: 30, fovDeg: 45 }),
  );
  const pose = camera.pose();
  assert.ok(Math.abs(pose.height - 16.7) < 1e-6, String(pose.height));
  assert.ok(Math.abs(pose.lat - 29.7604) < 1e-9);
  assert.ok(Math.abs(pose.lon + 95.3698) < 1e-9);
  // The stub's canvas is 1200 x 800: Sky's 45 deg spans the longer side.
  const vertical = skyFovy(45, { width: 1200, height: 800 });
  assert.ok(vertical < 45 * DEG);
  assert.ok(Math.abs(pose.fovy - vertical) < 1e-12);
});

test('the camera and the overlay agree on the field of view: the longer side spans fovDeg, landscape or portrait', () => {
  for (const [width, height] of [
    [1200, 800],
    [390, 844],
    [800, 800],
  ]) {
    const { camera } = createSkyTestHost({ width, height });
    const fovy = applySkyCamera(
      camera,
      HOUSTON,
      makeView({ azDeg: 0, elDeg: 30, fovDeg: 60 }),
      { width, height },
    );
    const pose = camera.pose();
    assert.ok(Math.abs(pose.fovy - fovy) < 1e-12, `${width}x${height}`);
    // What the overlay projects with (skyMath.fovAngles) is what is drawn.
    const overlay = fovAngles(60, width, height);
    assert.ok(
      Math.abs(pose.fovy / DEG - overlay.verticalDeg) < 1e-9,
      `vertical ${width}x${height}`,
    );
    const horizontalDeg =
      (2 * Math.atan(Math.tan(pose.fovy / 2) * (width / height))) / DEG;
    assert.ok(
      Math.abs(horizontalDeg - overlay.horizontalDeg) < 1e-9,
      `horizontal ${width}x${height}`,
    );
    assert.ok(
      Math.abs(Math.max(horizontalDeg, pose.fovy / DEG) - 60) < 1e-9,
      `the longer side spans 60 deg at ${width}x${height}`,
    );
  }
});

function poseDelta(camera, before) {
  const now = camera.pose();
  return Math.max(
    ...['position', 'direction', 'up'].map((key) =>
      distance(now[key], before[key]),
    ),
  );
}

test('exit restore: camera position/orientation back to 1e-6 and the field of view back to the renderer (orbit view)', () => {
  const { camera } = createSkyTestHost();
  camera.setView({
    destination: { lon: -97.7431, lat: 30.2672, height: 2500 },
    orientation: { heading: 0.7, pitch: -0.6, roll: 0.01 },
  });
  const before = snapshotCamera(camera);
  const { heading, pitch, roll, fovy } = camera.pose();
  assert.equal(before.frameIsIdentity, true);
  applySkyCamera(
    camera,
    HOUSTON,
    makeView({ azDeg: 200, elDeg: 70, fovDeg: 20 }),
  );
  assert.ok(poseDelta(camera, before) > 1);
  assert.ok(
    Math.abs(camera.pose().fovy - skyFovy(20, { width: 1200, height: 800 })) <
      1e-12,
  );
  restoreCamera(camera, before);
  assert.ok(
    poseDelta(camera, before) < 1e-6,
    `pose delta ${poseDelta(camera, before)}`,
  );
  const after = camera.pose();
  assert.ok(Math.abs(after.heading - heading) < 1e-6);
  assert.ok(Math.abs(after.pitch - pitch) < 1e-6);
  assert.ok(Math.abs(after.roll - roll) < 1e-6);
  assert.ok(
    Math.abs(after.fovy - fovy) < 1e-12,
    'the renderer has its fov back',
  );
});

test('a camera orbiting a lookAt target: Sky leaves the orbit for the world frame, and exit puts the world pose back', () => {
  const { camera } = createSkyTestHost();
  const target = fromDegrees(-97.7431, 30.2672, 0);
  camera.lookAt(target, { heading: 0.3, pitch: -0.5, range: 1500 });
  const before = snapshotCamera(camera);
  assert.equal(before.frameIsIdentity, false);
  const worldBefore = camera.pose().position;
  applySkyCamera(camera, HOUSTON, makeView({ azDeg: 0, elDeg: 45 }));
  assert.equal(camera.pose().frameIsIdentity, true);
  restoreCamera(camera, before);
  assert.ok(distance(camera.pose().position, worldBefore) < 1e-6);
  assert.ok(poseDelta(camera, before) < 1e-6);
});

test('scene snapshot/apply/restore: input held and collision off in sky, every setting back on exit', () => {
  const { host, camera, globe } = createSkyTestHost();
  camera.controls.collision = 'terrain';
  const before = {
    visible: globe.isGlobeVisible(),
    sky: { ...globe.sky.get() },
    inputs: camera.controls.enabled,
  };
  assert.equal(before.inputs, true);
  assert.equal(before.sky.lighting, false);
  const snap = snapshotScene(host);
  const releaseControls = takeSkyControls(host);
  assert.equal(camera.controls.enabled, false);
  assert.equal(camera.controls.collision, 'none');
  applySkyScene(host, snap, { flatHorizon: true, skyBox: false });
  assert.equal(globe.isGlobeVisible(), false);
  assert.equal(globe.sky.get().lighting, true);
  assert.equal(globe.sky.get().stars, false);
  applySkyScene(host, snap, { flatHorizon: false, skyBox: true });
  assert.equal(globe.isGlobeVisible(), true);
  assert.equal(globe.sky.get().stars, true);
  releaseControls();
  restoreScene(host, snap);
  assert.equal(camera.controls.enabled, before.inputs);
  assert.equal(camera.controls.collision, 'terrain');
  assert.equal(globe.isGlobeVisible(), before.visible);
  assert.deepEqual(globe.sky.get(), before.sky);
});

test('a globe hidden under photoreal stays hidden in sky and comes back hidden', () => {
  const { host, globe } = createSkyTestHost();
  globe.setGlobeVisible(false);
  const snap = snapshotScene(host);
  applySkyScene(host, snap, { flatHorizon: false, skyBox: false });
  assert.equal(globe.isGlobeVisible(), false, 'the real horizon keeps the map');
  applySkyScene(host, snap, { flatHorizon: true, skyBox: false });
  assert.equal(globe.isGlobeVisible(), false);
  restoreScene(host, snap);
  assert.equal(globe.isGlobeVisible(), false);
});

test('camera input holds are counted: Sky gives back only its own', () => {
  const { host, camera } = createSkyTestHost();
  const other = camera.controls.suspend('flight');
  const release = takeSkyControls(host);
  release();
  assert.equal(camera.controls.enabled, false, 'the flight still holds it');
  other();
  assert.equal(camera.controls.enabled, true);
});

test('applySkyTime sets scene time; holdSkyTime stamps Sky time after the application’s own listener and hands time back on off', () => {
  const { host, frame, renderer } = createSkyTestHost();
  applySkyTime(host, Date.parse('2026-10-12T03:30:00Z'));
  assert.equal(frame.time(), Date.parse('2026-10-12T03:30:00Z'));
  applySkyTime(host, Number.NaN);
  assert.equal(frame.time(), Date.parse('2026-10-12T03:30:00Z'), 'not finite');

  // The application's world-time listener (src/time/viewerClock.js) is
  // registered first, so Sky's runs after it every frame.
  const WORLD = Date.parse('2030-01-01T00:00:00Z');
  frame.on('preUpdate', () => frame.setTime(WORLD));
  let sky = Date.parse('2026-10-12T04:00:00Z');
  const off = holdSkyTime(host, () => sky);
  renderer.testing.tick();
  assert.equal(frame.time(), sky);
  sky += 60_000;
  renderer.testing.tick();
  assert.equal(frame.time(), sky, 'stamped every frame');
  off();
  renderer.testing.tick();
  assert.equal(frame.time(), WORLD, 'world time resumes by itself');
});

test('skyTilesShown: the ports cannot hide 3D tiles, so map tiles may stay on screen and attribution stays', () => {
  const snap = { globeVisible: true };
  assert.equal(skyTilesShown(snap), true, 'globe drawn');
  assert.equal(
    skyTilesShown(snap, { flatHorizon: true }),
    true,
    'flat horizon hides only the globe surface; tiles may remain',
  );
  assert.equal(skyTilesShown({ globeVisible: false }), true, 'photoreal tiles');
  assert.equal(skyTilesShown(null), true, 'no snapshot: cannot tell');
});

/** A camera standing `height` metres over Houston, in a fresh host. */
function hostAt(height, { ground, minDistance = 20, mode = 'terrain' } = {}) {
  const fixture = createSkyTestHost();
  fixture.camera.controls.minDistance = minDistance;
  fixture.camera.setView({
    destination: { lon: -95.3698, lat: 29.7604, height },
    orientation: { heading: 0, pitch: -0.2, roll: 0 },
  });
  if (ground !== undefined)
    fixture.renderer.testing.cacheHeight(
      { lon: -95.3698, lat: 29.7604 },
      ground,
      mode === 'terrain' ? 'terrain' : 'surface',
    );
  return fixture;
}

test('collisionRestoreLifts uses ground plus minimum distance, and unknown is not safe', () => {
  const floor = 138 + 20;
  assert.equal(
    collisionRestoreLifts(hostAt(floor - 5, { ground: 138 }).host, 'terrain'),
    true,
    'under the floor',
  );
  assert.equal(
    collisionRestoreLifts(hostAt(500, { ground: 138 }).host, 'terrain'),
    false,
    'above the terrain floor is safe even under 15 km',
  );
  assert.equal(
    collisionRestoreLifts(hostAt(50, { ground: 0 }).host, 'terrain'),
    false,
    'a known ellipsoid height of 0 is not an unknown surface',
  );
  assert.equal(
    collisionRestoreLifts(hostAt(500).host, 'terrain'),
    true,
    'an unknown surface must defer, not look safe',
  );
  assert.equal(
    collisionRestoreLifts(hostAt(COLLISION_CEILING_M + 10).host, 'terrain'),
    false,
    'above the ceiling never lifts, even if the surface is unknown',
  );
  assert.equal(
    collisionRestoreLifts(hostAt(16.7, { ground: 138 }).host, 'none'),
    false,
    'collision off never lifts',
  );
  assert.equal(collisionRestoreLifts(hostAt(16.7).host, undefined), false);
  // tiles and both ask the drawn surface, not the terrain alone
  assert.equal(
    collisionRestoreLifts(
      hostAt(floor - 5, { ground: 138, mode: 'tiles' }).host,
      'tiles',
    ),
    true,
  );
  assert.equal(
    collisionRestoreLifts(
      hostAt(500, { ground: 138, mode: 'both' }).host,
      'both',
    ),
    false,
  );
});

test('restoreScene writes the saved collision mode; deferCollision is the handoff opt-out', () => {
  const { host, camera } = createSkyTestHost();
  camera.controls.collision = 'terrain';
  const snap = snapshotScene(host);
  assert.equal(snap.collision, 'terrain');
  camera.controls.collision = 'none';
  restoreScene(host, snap);
  assert.equal(
    camera.controls.collision,
    'terrain',
    'a normal restore puts collision back even under the floor',
  );

  camera.controls.collision = 'none';
  restoreScene(host, snap, { deferCollision: true });
  assert.equal(
    camera.controls.collision,
    'none',
    'handoff may ask restoreScene to leave collision off',
  );

  const low = createSkyTestHost();
  low.camera.controls.collision = 'none';
  const lowSnap = snapshotScene(low.host);
  low.camera.controls.collision = 'terrain';
  restoreScene(low.host, lowSnap);
  assert.equal(
    low.camera.controls.collision,
    'none',
    'a saved off mode is written even at eye height',
  );
});
