import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORT_KEYS,
  planeDimensions,
  planeSupportPoints,
  poseHash,
  projectPoint,
  requiredPlaneLift,
} from './cctvFootprint.js';

const pose = {
  lat: 30.2672,
  lon: -97.7431,
  headingDeg: 90,
  pitchDeg: -24,
  fovDeg: 56,
  rangeM: 210,
  mountHeightM: 12,
};

test('support points form a 3×3 grid across the pitched far cap', () => {
  const { mount, capCenter, supports } = planeSupportPoints(pose);
  assert.deepEqual(mount, { lat: pose.lat, lon: pose.lon });
  assert.deepEqual(Object.keys(supports).sort(), [...SUPPORT_KEYS].sort());
  const dims = planeDimensions(pose);
  // Cap center sits R·cos(pitch) east of the mount (heading 90).
  const east = projectPoint(pose.lat, pose.lon, 90, dims.horiz);
  assert.ok(
    Math.abs(capCenter.lat - east.lat) < 1e-9 &&
      Math.abs(capCenter.lon - east.lon) < 1e-9,
  );
  // Middle-center is the cap center; left/right columns straddle it across the heading.
  assert.ok(Math.abs(supports.mc.lat - capCenter.lat) < 1e-9);
  assert.ok(
    supports.ml.lat > capCenter.lat && supports.mr.lat < capCenter.lat,
    'left is north of centre when looking east',
  );
  // A downward pitch tilts the top row forward (further along the heading).
  assert.ok(
    supports.tm.lon > supports.mc.lon && supports.bm.lon < supports.mc.lon,
  );
});

test('the rigid lift is the largest clearance deficit over the supports', () => {
  const dims = planeDimensions(pose);
  const ground = 149;
  const capAlt = ground + pose.mountHeightM + dims.vert; // far below ground for -24°
  const flat = requiredPlaneLift(capAlt, dims, null, ground, 2);
  assert.ok(
    Math.abs(flat.liftM - (ground + 2 - (capAlt - dims.upVert))) < 1e-9,
  );
  assert.equal(flat.limitingKey[0], 'b');
  const bump = requiredPlaneLift(capAlt, dims, { tr: ground + 200 }, ground, 2);
  assert.equal(bump.limitingKey, 'tr');
  assert.ok(bump.liftM > flat.liftM);
  // Already-clear planes need no lift at all.
  assert.deepEqual(requiredPlaneLift(ground + 500, dims, null, ground, 2), {
    liftM: 0,
    limitingKey: null,
  });
  // Unusable measurements fall back to the mount ground rather than zero.
  assert.equal(
    requiredPlaneLift(capAlt, dims, { bl: null, br: 'x' }, ground, 2).liftM,
    flat.liftM,
  );
});

test('poseHash is stable for the same pose and changes with any pose field', () => {
  const h = poseHash(pose);
  assert.equal(poseHash({ ...pose }), h);
  assert.match(h, /^p1-[0-9a-z]+$/);
  for (const [key, delta] of [
    ['lat', 0.00001],
    ['headingDeg', 0.1],
    ['pitchDeg', 0.1],
    ['fovDeg', 0.1],
    ['rangeM', 1],
    ['mountHeightM', 0.1],
  ]) {
    assert.notEqual(poseHash({ ...pose, [key]: pose[key] + delta }), h, key);
  }
});
