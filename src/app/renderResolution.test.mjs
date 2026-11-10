import test from 'node:test';
import assert from 'node:assert/strict';
import { configureRenderResolution } from './renderResolution.js';

test('display changes update only managed normal resolution and keep low mode bounded', () => {
  let dpr = 2,
    tick;
  const viewer = {
    scene: {
      preUpdate: {
        addEventListener(fn) {
          tick = fn;
          return () => {};
        },
      },
    },
  };
  configureRenderResolution(viewer, { getDpr: () => dpr });
  assert.equal(viewer.resolutionScale, 1);
  dpr = 1;
  tick();
  assert.equal(viewer.resolutionScale, 1);
  viewer.gevLowResource = true;
  viewer.resolutionScale = 0.6;
  dpr = 3;
  tick();
  assert.equal(viewer.resolutionScale, 0.6);
  assert.equal(viewer.gevStandardResolutionScale, 1);
  viewer.gevLowResource = false;
  viewer.resolutionScale = 1.25;
  dpr = 1;
  tick();
  assert.equal(
    viewer.resolutionScale,
    1.25,
    'explicit custom scales are preserved',
  );
});

test('starting in low mode records the sharp normal baseline without allocating it', () => {
  const viewer = { scene: { preUpdate: { addEventListener() {} } } };
  configureRenderResolution(viewer, { lowResource: true, getDpr: () => 2 });
  assert.equal(viewer.resolutionScale, 0.6);
  assert.equal(viewer.gevStandardResolutionScale, 1);
});
