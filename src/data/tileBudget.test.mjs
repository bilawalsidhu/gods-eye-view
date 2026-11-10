import test from 'node:test';
import assert from 'node:assert/strict';
import { isOverBudget, normalizeBudget, utcDayKey } from './tileBudget.js';
import * as tomtom from './tomtomTiles.js';

test('tile budget helpers live in one module and TomTom re-exports them', () => {
  assert.equal(tomtom.utcDayKey, utcDayKey);
  assert.equal(tomtom.normalizeBudget, normalizeBudget);
  assert.equal(tomtom.isOverBudget, isOverBudget);
});
