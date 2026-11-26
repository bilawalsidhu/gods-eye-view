import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECEDE_DEFAULTS,
  limbDistanceM,
  recedeFactors,
  recedeFrame,
  recedeParams,
  recededAlpha,
} from './recession.js';

const near = (a, b, what) =>
  assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);

test('a set that does not recede has no parameters; an empty one takes the defaults', () => {
  assert.equal(recedeParams(undefined), null);
  assert.equal(recedeParams(null), null);
  assert.deepEqual(recedeParams({}), { ...RECEDE_DEFAULTS });
  assert.deepEqual(RECEDE_DEFAULTS, {
    startLimbRatio: 0.5,
    scaleFloor: 0.45,
    alphaFloor: 0.35,
    combinedAlphaFloor: 0.2,
    globeViewBlendStartM: 3_500_000,
    globeViewBlendEndM: 4_500_000,
    earthRadiusM: 6_378_137,
  });
});

test('parameters are clamped to what draws, and the blend band kept in order', () => {
  const p = recedeParams({
    startLimbRatio: 2,
    scaleFloor: 0,
    alphaFloor: 3,
    combinedAlphaFloor: -1,
    globeViewBlendStartM: 5_000_000,
    globeViewBlendEndM: 10,
    earthRadiusM: -4,
  });
  assert.equal(p.startLimbRatio, 0.99);
  assert.equal(p.scaleFloor, 0.05);
  assert.equal(p.alphaFloor, 1);
  assert.equal(p.combinedAlphaFloor, 0.05);
  assert.equal(p.globeViewBlendStartM, 5_000_000);
  assert.equal(p.globeViewBlendEndM, 5_000_001);
  assert.equal(p.earthRadiusM, 1);
  // Not numbers: the base's.
  assert.deepEqual(recedeParams({ scaleFloor: 'x', alphaFloor: NaN }), {
    ...RECEDE_DEFAULTS,
  });
  // Over another base.
  assert.equal(
    recedeParams({}, { ...RECEDE_DEFAULTS, scaleFloor: 0.7 }).scaleFloor,
    0.7,
  );
});

test('the frame: the limb distance and the strength the blend band leaves', () => {
  const p = recedeParams({});
  const low = recedeFrame(1_000_000, p);
  assert.equal(low.active, true);
  near(low.limbM, Math.sqrt(1_000_000 * (2 * 6_378_137 + 1_000_000)), 'limb');
  assert.equal(low.strength, 1);
  const mid = recedeFrame(4_000_000, p);
  near(mid.strength, 0.5, 'halfway through the band');
  for (const height of [4_500_000, 9_000_000, 0, -1, NaN])
    assert.equal(recedeFrame(height, p).active, false, `${height}`);
  near(limbDistanceM(1_000_000), low.limbM, 'limbDistanceM');
  assert.ok(Number.isNaN(limbDistanceM(0)));
});

test('the factors: identity inside the start ratio, the floors at the limb', () => {
  const p = recedeParams({});
  const frame = recedeFrame(1_000_000, p);
  assert.deepEqual(recedeFactors(frame.limbM * 0.5, frame, p), {
    scale: 1,
    alpha: 1,
    limbRatio: 0.5,
  });
  const at = recedeFactors(frame.limbM, frame, p);
  near(at.scale, 0.45, 'scale floor');
  near(at.alpha, 0.35, 'alpha floor');
  const beyond = recedeFactors(frame.limbM * 1.2, frame, p);
  near(beyond.scale, 0.45, 'beyond the limb');
  const off = recedeFactors(1e9, recedeFrame(9_000_000, p), p);
  assert.deepEqual(off, { scale: 1, alpha: 1, limbRatio: null });
});

test('the alpha a receding item draws with: focus times haze, never under the combined floor', () => {
  const p = recedeParams({});
  assert.equal(recededAlpha(0.25, 0.35, p), 0.2);
  near(recededAlpha(1, 0.35, p), 0.35, 'haze alone');
  assert.equal(recededAlpha(0.5, 1, p), 0.5);
  assert.equal(recededAlpha(2, 1, p), 1);
});
