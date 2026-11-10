import { createFakeEngine } from './globe/testing/fakeEngine.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CelestialRing } from './celestialRing.js';

test('full globe focus uses the engine without a Cesium global', () => {
  let flight;
  const engine = createFakeEngine({ canvas: { clientWidth: 1200, clientHeight: 800 }, fovy: Math.PI / 3 });
  engine.camera.flyTo = (options) => { flight = options; };
  const ring = Object.assign(Object.create(CelestialRing.prototype), {
    _engine: engine,
  });
  assert.equal(globalThis.Cesium, undefined);
  assert.equal(ring.focusFullGlobe(), true);
  assert.equal(flight.easing, 'cubicInOut');
  assert.equal(ring._focusInProgress, true);
  flight.complete();
  assert.equal(ring._focusInProgress, false);
});
