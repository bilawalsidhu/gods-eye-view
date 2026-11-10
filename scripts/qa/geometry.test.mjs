import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { evaluateWithGeo } from './geometry.mjs';

test('page geometry works without source routes or native engine constructors', async () => {
  const page = {
    evaluate: (callback, ...args) =>
      vm.runInNewContext(`(${callback})(...${JSON.stringify(args)})`),
  };
  const result = await evaluateWithGeo(
    page,
    (geo, lon, lat, height) => {
      const point = geo.cartesian3.fromDegrees(lon, lat, height);
      return geo.cartographic.fromCartesian(point);
    },
    23,
    -12,
    650,
  );
  assert.ok(Math.abs(result.longitude - (23 * Math.PI) / 180) < 1e-12);
  assert.ok(Math.abs(result.latitude + (12 * Math.PI) / 180) < 1e-12);
  assert.ok(Math.abs(result.height - 650) < 1e-6);
});
