import { test } from 'node:test';
import assert from 'node:assert/strict';
import cctvLayer, { _setCctvCoverageStateForTest } from './cctv.js';
import { isHeadingEstimated } from '../layers/cctv/headingConfidence.js';

test('a hash-derived bearing reaches the card qualified as estimated, or not at all', (t) => {
  t.after(() => _setCctvCoverageStateForTest({ enabled: false }));
  const camera = { id: 'tw-1', name: 'Taipei 1', provider: 'Taiwan', feedType: 'image', headingDeg: 194, headingConfidence: 'low', fovDeg: 60, rangeM: 300, frameRefreshMs: 15_000 };
  _setCctvCoverageStateForTest({ records: [{ camera }] });
  assert.equal(isHeadingEstimated(camera), true, 'the HUD and wireframe treat it as estimated');
  const details = cctvLayer.cameraDetails('tw-1');
  assert.ok(details.headingDeg === null || details.headingEstimated === true, 'the card must not get an unqualified bearing');
});

test('a provider-supplied bearing stays a known facing', (t) => {
  t.after(() => _setCctvCoverageStateForTest({ enabled: false }));
  _setCctvCoverageStateForTest({ records: [{ camera: { id: 'atx-1', name: 'Lamar', headingDeg: 194, headingConfidence: 'high' } }] });
  const details = cctvLayer.cameraDetails('atx-1');
  assert.equal(details.headingDeg, 194);
  assert.notEqual(details.headingEstimated, true);
});
