import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCockpitWindDirection } from './cockpitPresentation.js';

test('wind just west of north reads 0°, not 360°', () => {
  assert.equal(formatCockpitWindDirection(90), 'E · 90°');
  assert.equal(formatCockpitWindDirection(0), 'N · 0°');
  assert.equal(formatCockpitWindDirection(359.4), 'N · 359°');
  assert.equal(formatCockpitWindDirection(359.6), 'N · 0°');
});
