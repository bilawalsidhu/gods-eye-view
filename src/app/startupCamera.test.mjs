import test from 'node:test';
import assert from 'node:assert/strict';
import { flyToAustin } from '../camera.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = createFakeEngine();
  const stop = flyToAustin(engine);
  stop();
  t.mock.timers.tick(1000);
  assert.equal(engine.fake.callsOf('camera.flyTo').length, 0);
  assert.equal(engine.fake.callsOf('camera.cancelFlight').length, 1);
});

test('the startup fly-in starts high over Austin, then flies in on the engine', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = createFakeEngine();
  flyToAustin(engine);
  const [view] = engine.fake.callsOf('camera.setView')[0].args;
  assert.deepEqual(view.orientation, {
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  t.mock.timers.tick(500);
  const [flight] = engine.fake.callsOf('camera.flyTo')[0].args;
  assert.equal(flight.duration, 4);
  assert.equal(flight.easing, 'cubicInOut');
});

test('a destroyed engine gets no late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = createFakeEngine();
  const stop = flyToAustin(engine);
  engine.destroy();
  t.mock.timers.tick(1000);
  stop();
  assert.equal(engine.fake.callsOf('camera.flyTo').length, 0);
  assert.equal(engine.fake.callsOf('camera.cancelFlight').length, 0);
});
