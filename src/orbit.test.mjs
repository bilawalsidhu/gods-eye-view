import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from './geo/index.js';
import { createFakeEngine } from './globe/testing/fakeEngine.js';
import { OrbitController } from './orbit.js';
import { getRenderGovernorDiagnostics } from './renderGovernor.js';

test('orbit locks onto the target every frame from the current heading, and stop releases it', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const engine = createFakeEngine();
  engine.fake.setPose({
    position: geo.cartesian3.fromDegrees(-97.74, 30.26, 2000),
    heading: 0.4,
    pitch: -0.5,
    roll: 0,
  });
  const target = geo.cartesian3.fromDegrees(-97.74, 30.27, 30);
  const orbit = new OrbitController(engine);
  assert.equal(
    orbit.toggle(target, { radius: 800, pitch: -20, speed: 10 }),
    true,
  );
  assert.ok(
    getRenderGovernorDiagnostics(engine).holds.includes('camera-orbit'),
  );
  t.mock.timers.tick(500);
  engine.fake.frame();
  const [first] = engine.fake.callsOf('camera.lookAt');
  assert.deepEqual(first.args[0], target);
  assert.ok(
    Math.abs(first.args[1].heading - (0.4 + geo.math.toRadians(5))) < 1e-9,
  );
  assert.equal(first.args[1].pitch, geo.math.toRadians(-20));
  assert.equal(first.args[1].range, 800);
  assert.equal(orbit.toggle(), false);
  assert.equal(engine.fake.callsOf('camera.release').length, 1);
  assert.ok(
    !getRenderGovernorDiagnostics(engine).holds.includes('camera-orbit'),
  );
  engine.fake.frame();
  assert.equal(
    engine.fake.callsOf('camera.lookAt').length,
    1,
    'no frames after stop',
  );
});

test('orbit needs a target', () => {
  const engine = createFakeEngine();
  const orbit = new OrbitController(engine);
  assert.equal(orbit.toggle(null), false);
  assert.equal(engine.frames.preRender.numberOfListeners, 0);
});
