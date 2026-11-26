import assert from 'node:assert/strict';
import test from 'node:test';
import { readFieldManifest } from './field.js';

const SCALE = {
  pm25: 20,
  pm10: 10,
  o3: 50,
  no2: 50,
  so2: 20,
  co: 500,
  aqi: 10,
};
const manifest = (global) =>
  readFieldManifest({
    run: '2026-11-20T00:00:00Z',
    scale: SCALE,
    global: { steps: [0], ...global },
  });

test('a wrapping region must be one whole row of the globe', () => {
  // 100 columns of 0.001°: 0.1° of longitude marked as wrapping.
  assert.throws(
    () =>
      manifest({
        width: 100,
        height: 100,
        lon0: 0,
        lat0: 10,
        step: 0.001,
        wrap: true,
      }),
    /Malformed air-quality field/,
  );
  // 180 columns of 1°: half the globe repeated twice.
  assert.throws(
    () =>
      manifest({
        width: 180,
        height: 90,
        lon0: 0,
        lat0: 45,
        step: 1,
        wrap: true,
      }),
    /Malformed air-quality field/,
  );
  // A whole 1° row still passes.
  manifest({ width: 360, height: 181, lon0: 0, lat0: 90, step: 1, wrap: true });
});
