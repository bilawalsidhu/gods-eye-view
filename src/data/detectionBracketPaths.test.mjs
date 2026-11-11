import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionBracketPaths } from './detectionBracketPaths.js';
import { appendCornerBracket } from './detectionDraw.js';

const path = () => ({
  calls: [],
  moveTo(x, y) {
    this.calls.push(['M', x, y]);
  },
  lineTo(x, y) {
    this.calls.push(['L', x, y]);
  },
});
function frame(cache, rows) {
  cache.begin();
  for (const row of rows) cache.add(...row);
  return cache.finish();
}

test('unchanged brackets reuse their exact geometry while opacity keeps the existing bands', () => {
  const cache = new DetectionBracketPaths(4, path);
  const rows = [
    ['cyan', 1, 10.123456789, 20, 9, 7],
    ['cyan', 0.4, 30, 40, 11, 8],
  ];
  const first = frame(cache, rows);
  const expected = path();
  appendCornerBracket(expected, ...rows[0].slice(2));
  assert.deepEqual(first.get('cyan')[4].path.calls, expected.calls);
  assert.equal(frame(cache, rows), first);
  assert.equal(
    frame(cache, [rows[0], ['cyan', 0.49, 30, 40, 11, 8]]),
    first,
    'alpha changes within a shipped band do not alter pixels',
  );
  const changed = frame(cache, [['cyan', 1, 10.123456788, 20, 9, 7], rows[1]]);
  assert.notEqual(
    changed,
    first,
    'even a subpixel position change invalidates the path',
  );
});

test('membership, dimensions, tint and opacity changes invalidate retained paths; clear releases them', () => {
  const cache = new DetectionBracketPaths(4, path);
  const row = ['cyan', 1, 10, 20, 9, 7];
  let previous = frame(cache, [row]);
  for (const rows of [
    [row, row],
    [['red', 1, 10, 20, 9, 7]],
    [['red', 0.5, 10, 20, 9, 7]],
    [['red', 0.5, 10, 20, 10, 7]],
  ]) {
    const next = frame(cache, rows);
    assert.notEqual(next, previous);
    previous = next;
  }
  assert.equal(frame(cache, []).size, 0);
  assert.equal(cache.positions.length, 0);
  assert.equal(cache.colors.length, 0);
});
