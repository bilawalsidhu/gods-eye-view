import test from 'node:test';
import assert from 'node:assert/strict';
import { flyToAustin } from '../camera.js';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToAustin(
    bindFakeCesiumCamera({
      isDestroyed: () => false,
      camera: {
        setView() {},
        flyTo() {
          flights++;
        },
        cancelFlight() {
          cancelled++;
        },
      },
    }),
  );
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 0, 'no fly-in started, so none to cancel');
});

test('teardown cancels the fly-in, not a flight the user started since', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cancelled = [];
  let current = null;
  const viewer = bindFakeCesiumCamera({
    isDestroyed: () => false,
    camera: {
      get _currentFlight() {
        return current;
      },
      setView() {},
      flyTo(options) {
        current?.cancel();
        current = {
          name: options.duration === 4 ? 'fly-in' : 'user',
          ...options,
        };
      },
      cancelFlight() {
        cancelled.push(current?.name);
        const flight = current;
        current = null;
        flight?.cancel();
      },
    },
  });
  const stop = flyToAustin(viewer);
  t.mock.timers.tick(500);
  stop();
  assert.deepEqual(cancelled, ['fly-in']);

  // A user flight replaces the fly-in; teardown leaves it alone.
  const second = flyToAustin(viewer);
  t.mock.timers.tick(500);
  viewer.camera.flyTo({ duration: 2 });
  second();
  assert.deepEqual(cancelled, ['fly-in']);
  assert.equal(current.name, 'user');
});
