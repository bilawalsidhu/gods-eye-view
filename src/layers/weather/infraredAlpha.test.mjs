import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyInfraredAlpha,
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

test('filter strength interpolates between the full infrared image and the cloud key', () => {
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 255, 194, 0, 0, 200, 12, 50, 217, 128,
  ]);
  assert.deepEqual([...infraredAlpha(pixels, 0)], [...pixels]);
  assert.deepEqual(
    infraredAlpha(pixels, 100),
    infraredAlpha(pixels, 'filtered'),
  );
  assert.deepEqual(
    [...infraredAlpha(pixels, 50)],
    [0, 0, 0, 128, 194, 0, 0, 149, 12, 50, 217, 128],
  );
});

test('full infrared preserves every channel including partial and zero alpha', () => {
  const pixels = new Uint8ClampedArray([
    12, 50, 194, 80, 0, 0, 0, 255, 255, 200, 0, 0,
  ]);
  assert.deepEqual(infraredAlpha(pixels, 'full'), pixels);
});

test('the lookup table gives the per-pixel curve byte for byte, in place', () => {
  // The transfer as it was written per pixel, before the table.
  const perPixel = (rgba, amount) => {
    const out = new Uint8ClampedArray(rgba);
    for (let i = 0; i < out.length; i += 4) {
      const linearMax =
        (Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) / 255) ** 2.2;
      const t = Math.max(
        0,
        Math.min(
          1,
          (linearMax - INFRARED_ALPHA_T0) /
            (INFRARED_ALPHA_T1 - INFRARED_ALPHA_T0),
        ),
      );
      out[i + 3] = rgba[i + 3] * (1 - amount + t * t * (3 - 2 * t) * amount);
    }
    return out;
  };
  // Every brightest-channel value in each channel, against a spread of alphas.
  const bytes = [];
  for (let value = 0; value < 256; value++)
    for (const alpha of [0, 1, 37, 128, 200, 254, 255]) {
      bytes.push(value, 0, 0, alpha);
      bytes.push(value >> 1, value, 0, alpha);
      bytes.push(0, value >> 2, value, alpha);
    }
  const source = new Uint8ClampedArray(bytes);
  for (const strength of [1, 33, 50, 99, 100, 'filtered', Number.NaN]) {
    const amount = Number.isFinite(strength) ? strength / 100 : 1;
    const pixels = source.slice();
    assert.equal(applyInfraredAlpha(pixels, strength), pixels);
    assert.deepEqual(pixels, perPixel(source, amount), `strength ${strength}`);
  }
  for (const strength of [0, 'full']) {
    const pixels = source.slice();
    assert.deepEqual(applyInfraredAlpha(pixels, strength), source);
  }
});
