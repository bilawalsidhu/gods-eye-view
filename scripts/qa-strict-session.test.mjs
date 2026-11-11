import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { createFakeEngine } from '../src/globe/testing/fakeEngine.js';
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

// Each render request draws the next scripted camera sample through the fake engine.
function cameraPage(t, positions, inputs, globals = {}) {
  let frame = -1;
  const engine = createFakeEngine();
  engine.input.cameraInputsEnabled = () => inputs[Math.max(0, frame)];
  engine.camera.flightActive = () => !inputs[Math.max(0, frame)];
  engine.render.request = () =>
    setImmediate(() => {
      if (frame + 1 >= positions.length) return;
      frame++;
      engine.fake.setPose({
        position: { x: positions[frame], y: 0, z: 6.4e6 },
      });
      engine.fake.frame();
    });
  const previous = globalThis.window;
  globalThis.window = {
    __godsEyeView: {
      engine,
      styleManager: { initialRestorePromise: Promise.resolve() },
    },
    ...globals,
  };
  t.after(() => {
    globalThis.window = previous;
  });
  const page = {
    evaluate: async (fn) =>
      typeof fn === 'string' ? runInThisContext(fn) : fn(),
    async waitForFunction(fn) {
      assert.ok(fn());
    },
  };
  return { page, polls: () => frame };
}

test('the camera is at rest once a flight has landed and it stays still', async (t) => {
  // A selection's flight holds the inputs off; once they are on, the camera
  // still moves one more sample before it stays put.
  const { page, polls } = cameraPage(
    t,
    [0, 400, 900, 900, 1250, 1250, 1250, 1250],
    [false, false, false, false, true, true, true, true],
  );
  await waitForCameraAtRest(page);
  // Not while the flight holds the inputs (sample 3 repeats a pose), nor
  // while the camera moves (sample 4).
  assert.equal(polls(), 7);
});

test('qa-wildlife-switch waits for the focus flight even when the camera was already still', async (t) => {
  // A rest the scenario recorded before the click is no rest of the flight.
  const { page, polls } = cameraPage(
    t,
    [0, 0, 100, 500, 500, 500, 500],
    [false, false, false, true, true, true, true],
    {
      __qaWildPose: { key: '0.0,0.0,6400000.0', at: performance.now() - 5000 },
    },
  );
  const source = readFileSync(
    new URL('./qa-wildlife-switch.mjs', import.meta.url),
    'utf8',
  );
  const still = new Function(
    'p',
    'waitForCameraAtRest',
    `${source.slice(
      source.indexOf('  const still ='),
      source.indexOf('  // What the engine draws'),
    )}\nreturn still;`,
  )(page, waitForCameraAtRest);
  await still();
  assert.equal(polls(), 6);
});
