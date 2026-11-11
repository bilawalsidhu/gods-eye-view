import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../geo/index.js';
import { pickWorldFromScreen } from './annotationResolver.js';

// Camera 30 m above 4000 m terrain, looking straight down: the depth pick
// hits the ground 30 m away; the ellipsoid lies 4030 m away.
test('a depth pick on high terrain close to the camera is kept', () => {
  const camera = geo.cartesian3.fromDegrees(86.9, 27.9, 4030);
  const ground = geo.cartesian3.fromDegrees(86.9, 27.9, 4000);
  const seaLevel = geo.cartesian3.fromDegrees(86.9, 27.9, 0);
  const engine = createFakeEngine({ width: 100, height: 100 });
  engine.fake.setPose({ position: camera });
  engine.fake.script('pickPosition', () => geo.cartesian3.clone(ground));
  engine.fake.script('pickGlobe', () => geo.cartesian3.clone(ground));
  engine.fake.script('pickEllipsoid', () => geo.cartesian3.clone(seaLevel));
  const picked = pickWorldFromScreen(engine, 0.5, 0.5);
  assert.ok(
    Math.abs(picked.height - 4000) < 1,
    `picked height ${picked.height}`,
  );
});

test('a near-camera depth artifact falls back to terrain before sea level', () => {
  const engine = createFakeEngine({ width: 100, height: 100 });
  engine.fake.setPose({
    position: geo.cartesian3.fromDegrees(86.9, 27.9, 4030),
  });
  engine.fake.script('pickPosition', () =>
    geo.cartesian3.fromDegrees(86.9, 27.9, 4029),
  );
  engine.fake.script('pickGlobe', () =>
    geo.cartesian3.fromDegrees(86.9, 27.9, 4000),
  );
  engine.fake.script('pickEllipsoid', () =>
    geo.cartesian3.fromDegrees(86.9, 27.9, 0),
  );
  assert.ok(Math.abs(pickWorldFromScreen(engine, 0.5, 0.5).height - 4000) < 1);
});

test('a far camera still treats a near-plane depth hit as a miss', () => {
  // 100 km up: a preview drawn at the near plane reads back 50 m away.
  const camera = geo.cartesian3.fromDegrees(86.9, 27.9, 100_000);
  const engine = createFakeEngine({ width: 100, height: 100 });
  engine.fake.setPose({ position: camera });
  engine.fake.script('pickPosition', () =>
    geo.cartesian3.fromDegrees(86.9, 27.9, 99_950),
  );
  engine.fake.script('pickGlobe', () =>
    geo.cartesian3.fromDegrees(86.9, 27.9, 4000),
  );
  engine.fake.script('pickEllipsoid', () =>
    geo.cartesian3.fromDegrees(86.9, 27.9, 0),
  );
  assert.ok(Math.abs(pickWorldFromScreen(engine, 0.5, 0.5).height - 4000) < 1);
});
