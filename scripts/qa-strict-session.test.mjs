import test from 'node:test';
import assert from 'node:assert/strict';
import { quantile, slope } from './qa-strict-session.mjs';
import { strictArguments, waitForCameraAtRest } from './qa-strict-harness.mjs';

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

test('the camera is at rest once a flight has landed and it stays still', async () => {
  // A selection's flight holds the inputs off; once they are on, the camera
  // still moves one more sample before it stays put.
  const poses = [0, 400, 900, 900, 1250, 1250, 1250];
  const inputs = [false, false, false, false, true, true, true];
  let frame = 0;
  const engine = {
    camera: { pose: () => ({ position: { x: poses[frame], y: 0, z: 6.4e6 } }) },
    input: { cameraInputsEnabled: () => inputs[frame] },
  };
  const previous = globalThis.window;
  globalThis.window = { __godsEyeView: { engine } };
  const page = {
    evaluate: async (fn) => fn(),
    async waitForFunction(fn) {
      for (; frame < poses.length; frame++) if (fn()) return;
      throw new Error('timed out');
    },
  };
  try {
    await waitForCameraAtRest(page);
    // Not while the flight holds the inputs (sample 3 repeats a pose), nor
    // while the camera moves (sample 4).
    assert.equal(frame, 5);
  } finally {
    globalThis.window = previous;
  }
});
