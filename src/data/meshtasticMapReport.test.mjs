import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESHTASTIC_NODE_EVICT_MS,
  MESHTASTIC_NODE_STALE_MS,
  formatMeshtasticNodeId,
  meshtasticNodeFreshness,
  positionUncertaintyRadiusM,
} from './meshtasticMapReport.js';

test('formatMeshtasticNodeId: zero-pads to 8 hex digits with a leading !', () => {
  assert.equal(formatMeshtasticNodeId(0xdad88120), '!dad88120');
  assert.equal(formatMeshtasticNodeId(1), '!00000001');
});

test('positionUncertaintyRadiusM: matches Meshtastic\'s published reference points', () => {
  // Meshtastic's own docs describe bits=11 as "~11km" and bits=16 as "~350m".
  const r11 = positionUncertaintyRadiusM(11);
  const r16 = positionUncertaintyRadiusM(16);
  assert.ok(Math.abs(r11 - 11_000) / 11_000 < 0.1, `bits=11 -> ${r11}m, expected ~11km`);
  assert.ok(Math.abs(r16 - 350) / 350 < 0.1, `bits=16 -> ${r16}m, expected ~350m`);
  assert.ok(r11 > r16, 'fewer retained bits must mean coarser (larger) uncertainty');
});

test('positionUncertaintyRadiusM: no uncertainty reported reads as exact (0)', () => {
  assert.equal(positionUncertaintyRadiusM(0), 0);
  assert.equal(positionUncertaintyRadiusM(32), 0);
  assert.equal(positionUncertaintyRadiusM(null), 0);
  assert.equal(positionUncertaintyRadiusM(undefined), 0);
  assert.equal(positionUncertaintyRadiusM(NaN), 0);
});

test('meshtasticNodeFreshness: buckets by age against the shared thresholds', () => {
  const now = 1_000_000_000_000;
  assert.equal(meshtasticNodeFreshness(now, now), 'live');
  assert.equal(meshtasticNodeFreshness(now - MESHTASTIC_NODE_STALE_MS, now), 'live');
  assert.equal(meshtasticNodeFreshness(now - MESHTASTIC_NODE_STALE_MS - 1, now), 'stale');
  assert.equal(meshtasticNodeFreshness(now - MESHTASTIC_NODE_EVICT_MS, now), 'stale');
  assert.equal(meshtasticNodeFreshness(now - MESHTASTIC_NODE_EVICT_MS - 1, now), 'expired');
  assert.equal(meshtasticNodeFreshness(null, now), 'expired');
});
