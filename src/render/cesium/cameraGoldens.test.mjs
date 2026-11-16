import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordCameraGoldens } from './cameraGoldens.js';
import { near } from '../conformance/expect.js';

// The recorder is deterministic, but platforms can differ in the last bits
// of trigonometric arithmetic. Keep structure and discrete values exact.
function compareTrace(actual, expected, path = []) {
  const label = path.join('.');
  if (typeof expected === 'number') {
    const key = path.at(-1);
    if (['step', 'frames', 'count'].includes(key) || path[0] === 'viewport') {
      assert.equal(actual, expected, label);
      return;
    }
    const metres =
      path.at(-2) === 'position' ||
      key === 'height' ||
      (path.at(-2) === 'view' && Number(key) >= 12 && Number(key) <= 14);
    near(actual, expected, metres ? 1e-8 : 1e-14, label);
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', label);
    assert.equal(Array.isArray(actual), Array.isArray(expected), label);
    assert.deepEqual(Object.keys(actual), Object.keys(expected), label);
    if (Array.isArray(expected))
      assert.equal(actual.length, expected.length, label);
    for (const key of Object.keys(expected))
      compareTrace(actual[key], expected[key], [...path, key]);
    return;
  }
  assert.equal(actual, expected, label);
}

test('the committed camera traces are what the installed Cesium records', async () => {
  const committed = JSON.parse(
    readFileSync(
      new URL('../conformance/goldens/camera.json', import.meta.url),
      'utf8',
    ),
  );
  compareTrace(await recordCameraGoldens(), committed);
});

test('trace comparison tolerates only numeric roundoff, preserving structure and counters', () => {
  const expected = {
    position: { x: 1000 },
    pitch: 0.3,
    frames: 2,
    values: [1],
    label: 'pose',
  };
  compareTrace(
    { ...expected, position: { x: 1000 + 2e-9 }, pitch: 0.3 + 1e-16 },
    expected,
  );
  for (const actual of [
    { ...expected, extra: true },
    { ...expected, values: [] },
    { ...expected, position: { x: 1000 + 2e-8 } },
    { ...expected, pitch: 0.3 + 2e-14 },
    { ...expected, frames: 2 + 1e-15 },
    { ...expected, pitch: NaN },
    { ...expected, pitch: null },
    { ...expected, pitch: '0.3' },
    { ...expected, label: 'other' },
  ])
    assert.throws(() => compareTrace(actual, expected));
  const { label, ...missing } = expected;
  assert.throws(() => compareTrace(missing, expected));
});
