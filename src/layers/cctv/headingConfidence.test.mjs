// src/layers/cctv/headingConfidence.test.mjs
// Bearing-provenance consumers (#639): a pack's headingConfidence:'low'
// (a hashed synthetic bearing) must present as estimated — unless a human
// vouched for the pose via manual calibration or a curated catalog entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHeadingEstimated, headingHudToken } from './headingConfidence.js';

test('low confidence marks the bearing estimated', () => {
  assert.equal(isHeadingEstimated({ headingConfidence: 'low' }), true);
});

test('confidence matching is trimmed and case-insensitive', () => {
  assert.equal(isHeadingEstimated({ headingConfidence: ' LOW ' }), true);
  assert.equal(isHeadingEstimated({ headingConfidence: 'Low' }), true);
});

test('medium, high, missing, and absent cameras are not estimated', () => {
  assert.equal(isHeadingEstimated({ headingConfidence: 'medium' }), false);
  assert.equal(isHeadingEstimated({ headingConfidence: 'high' }), false);
  assert.equal(isHeadingEstimated({}), false);
  assert.equal(isHeadingEstimated(null), false);
  assert.equal(isHeadingEstimated(undefined), false);
});

test('a manually saved calibration overrides a low pack flag', () => {
  assert.equal(
    isHeadingEstimated({ headingConfidence: 'low', calSource: 'manual' }),
    false,
  );
});

test('a curated catalog entry overrides a low pack flag', () => {
  assert.equal(
    isHeadingEstimated({ headingConfidence: 'low', poseSource: 'curated' }),
    false,
  );
});

test('HUD token tags a synthetic bearing and rounds the degrees', () => {
  assert.equal(
    headingHudToken({ headingDeg: 194.4, headingConfidence: 'low' }),
    'HDG 194° (ESTIMATED)',
  );
});

test('HUD token stays untagged for surveyed and calibrated bearings', () => {
  assert.equal(
    headingHudToken({ headingDeg: 67.5, headingConfidence: 'high' }),
    'HDG 68°',
  );
  assert.equal(
    headingHudToken({
      headingDeg: 225,
      headingConfidence: 'low',
      calSource: 'manual',
    }),
    'HDG 225°',
  );
});
