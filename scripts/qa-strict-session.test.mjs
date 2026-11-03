import test from 'node:test';
import assert from 'node:assert/strict';
import { quantile, slope } from './qa-strict-session.mjs';
import { strictArguments } from './qa-strict-harness.mjs';

test('slope is the least-squares growth per step', () => {
  assert.equal(slope([[0, 5]]), 0);
  assert.equal(
    slope([
      [20, 100],
      [50, 103],
      [100, 108],
    ]).toFixed(3),
    '0.100',
  );
  assert.equal(
    slope([
      [1, 7],
      [2, 7],
      [3, 7],
    ]),
    0,
  );
});

test('quantile takes the nearest rank', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(
    quantile(
      [...Array(100)].map((_, i) => i + 1),
      0.95,
    ),
    95,
  );
});

test('the runner hands each scenario its layers and its manifest path', () => {
  assert.deepEqual(
    strictArguments(['node', 'x', '--layers=a,b', '--evidence=/tmp/e.json']),
    { layers: ['a', 'b'], evidence: '/tmp/e.json' },
  );
  assert.deepEqual(strictArguments(['node', 'x', '--layers=']), {
    layers: null,
    evidence: process.env.QA_STRICT_EVIDENCE ?? null,
  });
});
