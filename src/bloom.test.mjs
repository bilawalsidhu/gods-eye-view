// bloom.js — the persisted bloom scale. Share links and saved scene projects
// carry either the legacy inverted 0-100 scale or the current 0-200 one, so
// every ingestion path funnels through decodeBloomIntensity.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOOM_INTENSITY_DEFAULT,
  BLOOM_INTENSITY_MAX,
  BLOOM_SCALE_VERSION,
  bloomStrengthFromIntensity,
  clampBloomIntensity,
  decodeBloomIntensity,
  legacyBloomToV2,
} from './bloom.js';

test('clamping rejects junk to the default and bounds the v2 range', () => {
  assert.equal(clampBloomIntensity('84'), 84, 'persisted values arrive as strings');
  assert.equal(clampBloomIntensity(84.6), 85, 'fractional slider output rounds');
  assert.equal(clampBloomIntensity(1e6), BLOOM_INTENSITY_MAX);
  assert.equal(clampBloomIntensity(-20), 0);
  assert.equal(clampBloomIntensity(Number.NaN), BLOOM_INTENSITY_DEFAULT);
  assert.equal(clampBloomIntensity('nonsense'), BLOOM_INTENSITY_DEFAULT);
});

test('legacy v1 values are inverted as well as rescaled', () => {
  // v1 ran 100 = no bloom, 0 = max bloom.
  assert.equal(legacyBloomToV2(100), 0);
  assert.equal(legacyBloomToV2(0), BLOOM_INTENSITY_MAX);
  assert.equal(legacyBloomToV2(84), 32);
  assert.equal(legacyBloomToV2(120), 0, 'out-of-range legacy values clamp first');
});

test('unversioned values above the legacy maximum already use the v2 scale', () => {
  // A link saved after the rescale but before the version field existed must
  // NOT be inverted: 150 on the old scale would mean "more than max bloom".
  assert.equal(decodeBloomIntensity(150), 150);
  assert.equal(decodeBloomIntensity(200), BLOOM_INTENSITY_MAX);
  assert.equal(decodeBloomIntensity(101), 101, 'the first value past the legacy ceiling opts out');
  assert.equal(decodeBloomIntensity(100), 0,
    'exactly the legacy ceiling is still a v1 value, so it migrates');
  // An explicit current version opts out of migration entirely.
  assert.equal(decodeBloomIntensity(84, BLOOM_SCALE_VERSION), 84);
  assert.equal(decodeBloomIntensity('84', '2'), 84);
  assert.equal(decodeBloomIntensity(Number.NaN, 2), BLOOM_INTENSITY_DEFAULT);
});

test('intensity maps onto the post-process strength as a 0-200 fraction', () => {
  assert.equal(bloomStrengthFromIntensity(0), 0);
  assert.equal(bloomStrengthFromIntensity(BLOOM_INTENSITY_MAX), 1);
  assert.equal(bloomStrengthFromIntensity(84), 0.42);
  // The Cesium bloom stage has no tolerance for out-of-range strengths.
  assert.equal(bloomStrengthFromIntensity(1e6), 1, 'ceiling clamps');
  assert.equal(bloomStrengthFromIntensity(-5), 0, 'floor clamps');
  assert.equal(bloomStrengthFromIntensity(Number.NaN), 0, 'junk collapses to off');
});
