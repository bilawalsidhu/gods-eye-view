import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from './policy.js';
import * as records from './records.js';
import { dropLinesVisible } from './policy.js';
test('all six states define readable symbols and colours with dark contrast outlines', () => {
  const symbols = policy.RADIOSONDE_SYMBOLS;
  assert.equal(symbols.landed.alpha, 0.55);
  assert.equal(policy.RADIOSONDE_COLOR, '#ff8fb1');
  assert.deepEqual(Object.keys(symbols), [
    'ascending',
    'descending',
    'unknown',
    'landed',
    'landed-inferred',
    'signal-lost',
  ]);
  assert.deepEqual(
    Object.values(symbols).map(({ shape }) => shape),
    ['balloon', 'parachute', 'balloon', 'ground', 'ground', 'lost-balloon'],
  );
  assert.equal(Object.isFrozen(symbols), true);
  for (const symbol of Object.values(symbols)) {
    assert.equal(Object.isFrozen(symbol), true);
    const rgb = symbol.color
      .slice(1)
      .match(/../g)
      .map((v) => parseInt(v, 16) / 255);
    const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
    assert.ok(luma >= 0.5, `symbol contrast for ${symbol.color}`);
  }
  assert.equal(symbols.ascending.color, policy.RADIOSONDE_COLOR);
  assert.equal(symbols.descending.color, policy.RADIOSONDE_COLOR);
  assert.ok(symbols.unknown.alpha < symbols.ascending.alpha);
  assert.ok(symbols.unknown.alpha > symbols.landed.alpha);
  assert.equal(policy.RADIOSONDE_OUTLINE, 'rgba(4,12,16,0.9)');
});
test('flight sprite scale and viewport-sized label budget have named bounds', () => {
  assert.equal(policy.RADIOSONDE_SPRITE_PX, 20);
  assert.deepEqual(policy.RADIOSONDE_SCALE_BY_DISTANCE, [1000, 3, 8e6, 0.5]);
  assert.equal(policy.MAX_SONDES_RENDERED, 2000);
  assert.equal(policy.RADIOSONDE_LABEL_CANDIDATE_CAP, 150);
  assert.equal(policy.RADIOSONDE_TERMINAL_LABEL_MAX_HEIGHT_M, 1_500_000);
  assert.equal(policy.RADIOSONDE_DATA_BATCH_MS, 500);
  assert.equal(policy.RADIOSONDE_TRAIL_READY_MAX_CHECKS, 120);
  for (const retired of [
    'RADIOSONDE_LANDED_HIDE_MS',
    'RADIOSONDE_LABEL_MIN_ALT_M',
    'LABEL_MIN_SEP_PX',
  ])
    assert.equal(retired in policy, false, retired);
});
test('silence and directional noise thresholds have explicit units and values', () => {
  assert.equal(records.RADIOSONDE_SILENT_MS, 10 * 60000);
  assert.equal(records.RADIOSONDE_VERTICAL_NOISE_MPS, 0.5);
  assert.equal(records.RADIOSONDE_TRACK_NOISE_M, 100);
  assert.equal(records.RADIOSONDE_INFERRED_LANDING_MAX_ALT_M, 2000);
});
test('drop line height uses a ten percent hysteresis band', () => {
  assert.equal(dropLinesVisible(3_300_000, true), true);
  assert.equal(dropLinesVisible(3_300_001, true), false);
  assert.equal(dropLinesVisible(2_700_001, false), false);
  assert.equal(dropLinesVisible(2_700_000, false), true);
});
