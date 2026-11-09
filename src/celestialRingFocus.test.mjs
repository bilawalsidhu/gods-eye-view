import test from 'node:test';
import assert from 'node:assert/strict';
import { CelestialRing } from './celestialRing.js';

test('full globe focus uses the engine without a Cesium global', () => {
  let flight;
  const engine = {
    camera: {
      flyTo: (options) => {
        flight = options;
      },
    },
  };
  const ring = Object.assign(Object.create(CelestialRing.prototype), {
    _engine: engine,
    viewer: {
      scene: {
        canvas: { clientWidth: 1200, clientHeight: 800 },
        requestRender() {},
      },
      camera: {
        positionCartographic: { longitude: 0, latitude: 0 },
        heading: 0,
        frustum: { fovy: Math.PI / 3 },
      },
    },
  });
  assert.equal(globalThis.Cesium, undefined);
  assert.equal(ring.focusFullGlobe(), true);
  assert.equal(flight.easing, 'cubicInOut');
  assert.equal(ring._focusInProgress, true);
  flight.complete();
  assert.equal(ring._focusInProgress, false);
});
