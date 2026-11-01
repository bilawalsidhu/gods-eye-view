'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeState, DEFAULT_SIZE, MIN_SIZE } = require('./windowState.cjs');

const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];

test('a valid on-screen state is kept', () => {
  const saved = { x: 100, y: 50, width: 1200, height: 800, maximized: true };
  assert.deepEqual(sanitizeState(saved, displays), saved);
});

test('garbage and off-screen states fall back to defaults', () => {
  const fallback = { ...DEFAULT_SIZE, maximized: false };
  assert.deepEqual(sanitizeState(null, displays), fallback);
  assert.deepEqual(sanitizeState({ x: 'a' }, displays), fallback);
  assert.deepEqual(
    sanitizeState({ x: 5000, y: 5000, width: 1200, height: 800 }, displays),
    fallback,
  );
});

test('undersized windows are raised to the minimum size', () => {
  const state = sanitizeState(
    { x: 10, y: 10, width: 100, height: 100 },
    displays,
  );
  assert.equal(state.width, MIN_SIZE.width);
  assert.equal(state.height, MIN_SIZE.height);
});
