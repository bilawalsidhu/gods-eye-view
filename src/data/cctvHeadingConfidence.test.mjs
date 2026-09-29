// Bearing-provenance consumers (ported from upstream 5f27f6e, #639): a pack's
// headingConfidence:'low' (a hashed synthetic bearing) must present as
// estimated — unless a human vouched for the pose via manual calibration or a
// curated catalog entry. HUD token formatting, public-state passthrough, and
// the dashed wireframe are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { headingHudToken, isHeadingEstimated } from './cctvHeadingConfidence.js';
import { readSource } from '../testSupport/readSource.js';

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

test('HUD token honors a precomputed headingEstimated bit verbatim', () => {
  // The layer's public camera state computes the bit against the RAW record
  // (where calSource lives); the panel consumes that state, which carries no
  // calSource — so the formatter must NOT re-derive from the pack flag there.
  assert.equal(
    headingHudToken({ headingDeg: 12, headingConfidence: 'low', headingEstimated: false }),
    'HDG 12°',
    'public state says not estimated (manually calibrated) — no tag despite the pack flag',
  );
  assert.equal(
    headingHudToken({ headingDeg: 12, headingConfidence: 'high', headingEstimated: true }),
    'HDG 12° (ESTIMATED)',
  );
});

test('both HUD sites use the token; public state carries the provenance pair', () => {
  const layer = readSource('./cctv.js', import.meta.url);
  const panel = readSource('../ui/cctvPanel.js', import.meta.url);
  assert.match(layer, /headingHudToken\(active\.camera\)/, 'the layer HUD row tags estimated bearings');
  assert.match(panel, /headingHudToken\(activeCamera\)/, 'the panel meta line tags estimated bearings');
  assert.match(layer, /headingConfidence: camera\.headingConfidence \|\| null/);
  assert.match(layer, /headingEstimated: isHeadingEstimated\(camera\)/);
  // The dash is the wireframe's only signal: materials flow through the
  // dash-aware helper at creation AND in the active/idle emphasis loop.
  assert.match(layer, /material: coverageLineMaterial\(record, IDLE_COVERAGE_COLOR\)/);
  assert.match(layer, /coverageLineMaterial\(record, hue/, 'the emphasis loop keeps the dash through scheme swaps');
  assert.doesNotMatch(layer, /`HDG \$\{Math\.round/, 'no raw HDG formatting may bypass the token');
  assert.doesNotMatch(panel, /`HDG \$\{Math\.round/);
});
