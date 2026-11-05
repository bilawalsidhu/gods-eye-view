import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import {
  capacityToPixelSize,
  resolveCapacity,
  statusToColor,
} from './presentation.js';
import {
  COLOR_GREEN,
  COLOR_YELLOW,
  COLOR_RED,
  COLOR_NEUTRAL,
  COLOR_MUTED,
} from './policy.js';

const model = createModel({});
const online = { isInstalled: true, isRenting: true, isReturning: true };

test('availability boundaries and all disabled flags retain the native palette', () => {
  for (const [bikes, color] of [
    [0, COLOR_RED],
    [2, COLOR_RED],
    [3, COLOR_YELLOW],
    [6, COLOR_YELLOW],
    [7, COLOR_GREEN],
  ]) {
    assert.equal(
      statusToColor(model, { ...online, bikesAvailable: bikes }, 10),
      color,
    );
  }
  assert.equal(statusToColor(model, null, 10), COLOR_NEUTRAL);
  assert.equal(statusToColor(model, online, 10), COLOR_NEUTRAL);
  for (const flag of Object.keys(online))
    assert.equal(
      statusToColor(model, { ...online, bikesAvailable: 8, [flag]: false }, 10),
      COLOR_MUTED,
    );
});

test('capacity prioritizes station metadata, then total docks, then the native fallback', () => {
  assert.equal(
    resolveCapacity(model, 20, { bikesAvailable: 4, docksAvailable: 9 }),
    20,
  );
  assert.equal(
    resolveCapacity(model, null, { bikesAvailable: 4, docksAvailable: 9 }),
    13,
  );
  assert.equal(resolveCapacity(model, null, null), 15);
  for (const capacity of [1, 13, 15, 80, 120]) {
    const expected = 4 + Math.sqrt(Math.min(80, capacity) / 80) * 8;
    assert.ok(Math.abs(capacityToPixelSize(capacity) - expected) < 1e-12);
  }
});
