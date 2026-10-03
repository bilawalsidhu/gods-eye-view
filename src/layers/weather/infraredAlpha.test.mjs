import test from 'node:test';
import assert from 'node:assert/strict';
import {
  infraredAlpha,
  INFRARED_ALPHA_T0,
  INFRARED_ALPHA_T1,
} from './infraredAlpha.js';

test('filtered infrared preserves RGB and input bytes, scales existing alpha, and matches the old linear threshold', () => {
  assert.equal(INFRARED_ALPHA_T0, 0.4);
  assert.equal(INFRARED_ALPHA_T1, 0.7);
  const bytes = new Uint8ClampedArray([
    0, 0, 0, 255, 168, 12, 50, 255, 12, 194, 50, 200, 12, 50, 217, 128, 255,
    255, 255, 0,
  ]);
  const original = bytes.slice();
  const result = infraredAlpha(bytes);
  assert.deepEqual(bytes, original);
  for (let i = 0; i < bytes.length; i += 4)
    assert.deepEqual(result.slice(i, i + 3), bytes.slice(i, i + 3));
  assert.deepEqual(
    [result[3], result[7], result[11], result[15], result[19]],
    [0, 0, 98, 128, 0],
  );
  // Cesium's old 0.55 hard cut falls between byte values 194 and 195.
  assert.ok((194 / 255) ** 2.2 < 0.55);
  assert.ok((195 / 255) ** 2.2 > 0.55);
  const ramp = [];
  for (let value = 0; value < 256; value++) {
    ramp.push(infraredAlpha([value, value, value, 255])[3]);
  }
  assert.ok(ramp[194] < 127.5 && ramp[195] > 127.5);
  assert.ok(ramp.every((value, i) => !i || value >= ramp[i - 1]));
  assert.ok(Math.max(...ramp.slice(1).map((v, i) => v - ramp[i])) <= 8);
  assert.ok(
    Math.abs(
      (0.55 - INFRARED_ALPHA_T0) / (INFRARED_ALPHA_T1 - INFRARED_ALPHA_T0) -
        0.5,
    ) < 1e-12,
  );
});

test('full infrared preserves every channel including partial and zero alpha', () => {
  const pixels = new Uint8ClampedArray([
    12, 50, 194, 80, 0, 0, 0, 255, 255, 200, 0, 0,
  ]);
  assert.deepEqual(infraredAlpha(pixels, 'full'), pixels);
});
