import test from 'node:test';
import assert from 'node:assert/strict';
import { isOverBudget, normalizeBudget, utcDayKey } from './tileBudget.js';
import * as tomtom from './tomtomTiles.js';

test('tile budget helpers live in one module and TomTom re-exports them', () => {
  assert.equal(tomtom.utcDayKey, utcDayKey);
  assert.equal(tomtom.normalizeBudget, normalizeBudget);
  assert.equal(tomtom.isOverBudget, isOverBudget);
});

test('normalizeBudget keeps a valid state and resets another period', () => {
  const state = { date: '2026-09-24', count: 3 };
  assert.equal(normalizeBudget(state, '2026-09-24'), state);
  assert.deepEqual(normalizeBudget(state, '2026-09-25'), {
    date: '2026-09-25',
    count: 0,
  });
  assert.deepEqual(
    normalizeBudget({ date: '2026-09-24', count: -1 }, '2026-09-24'),
    {
      date: '2026-09-24',
      count: 0,
    },
  );
});
