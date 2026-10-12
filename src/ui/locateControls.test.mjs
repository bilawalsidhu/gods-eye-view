import test from 'node:test';
import assert from 'node:assert/strict';
import { LocateControls } from './locateControls.js';

function fixture(t, options = {}) {
  const button = new EventTarget(),
    attributes = new Map();
  button.dataset = {};
  button.setAttribute = (key, value) => attributes.set(key, value);
  const status = { dataset: {}, textContent: '', hidden: true };
  const requests = [],
    flights = [];
  let generation = 0,
    handoff;
  const lifecycleTarget = new EventTarget();
  const gestureTarget = new EventTarget();
  const controls = new LocateControls({
    button,
    status,
    secure: true,
    geolocation: { getCurrentPosition: (...args) => requests.push(args) },
    begin: () => ++generation,
    isCurrent: (value) => value === generation,
    center: (...args) => flights.push(args),
    subscribeAuthority: (callback) => {
      handoff = callback;
      return () => (handoff = null);
    },
    lifecycleTarget,
    gestureTarget,
    ...options,
  });
  t.after(() => controls.destroy());
  return {
    button,
    status,
    attributes,
    requests,
    flights,
    controls,
    lifecycleTarget,
    gestureTarget,
    supersede: () => {
      generation++;
      handoff?.();
    },
  };
}
const fix = { coords: { latitude: 33.909, longitude: -84.825, accuracy: 12 } };
test('map gestures invalidate pending fixes and destruction removes gesture listeners', (t) => {
  for (const type of ['pointerdown', 'wheel']) {
    const f = fixture(t);
    f.controls.locate();
    f.gestureTarget.dispatchEvent(new Event(type));
    assert.equal(f.controls.pending, false);
    assert.match(f.status.textContent, /map gesture/);
    f.requests[0][0](fix);
    assert.equal(f.flights.length, 0);
    f.controls.destroy();
    const epoch = f.controls.epoch;
    f.gestureTarget.dispatchEvent(new Event(type));
    assert.equal(f.controls.epoch, epoch);
  }
});
test('construction is inert; click requests exactly one current viewing-device fix, success centers without storing coordinates', (t) => {
  const f = fixture(t);
  assert.equal(f.requests.length, 0);
  f.button.dispatchEvent(new Event('click'));
  for (let i = 0; i < 8; i++) f.button.dispatchEvent(new Event('click'));
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0][2], {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15000,
  });
  assert.equal(f.attributes.get('aria-busy'), 'true');
  assert.equal(f.status.dataset.state, 'loading');
  f.requests[0][0](fix);
  assert.equal(f.flights.length, 1);
  assert.deepEqual(f.flights[0].slice(0, 3), [33.909, -84.825, 12]);
  assert.equal(f.attributes.get('aria-busy'), 'false');
  assert.equal(f.status.dataset.state, 'ready');
  assert.equal(Object.values(f.controls).includes(fix), false);
  f.requests[0][0](fix);
  assert.equal(f.flights.length, 1);
});
test('denial, unavailable, timeout and thrown browser errors have safe retryable feedback and never navigate', (t) => {
  for (const [code, expected] of [
    [1, /permission denied/],
    [2, /unavailable/],
    [3, /too long/],
  ]) {
    const f = fixture(t);
    f.controls.locate();
    f.requests[0][1]({ code, message: 'private diagnostic must not render' });
    assert.match(f.status.textContent, expected);
    assert.equal(f.status.textContent.includes('private diagnostic'), false);
    assert.equal(f.flights.length, 0);
    assert.equal(f.controls.pending, false);
    f.controls.locate();
    assert.equal(f.requests.length, 2);
    f.requests[0][0](fix);
    assert.equal(f.flights.length, 0);
    f.requests[1][0](fix);
    assert.equal(f.flights.length, 1);
  }
  const f = fixture(t, {
    geolocation: {
      getCurrentPosition() {
        throw new Error('blocked');
      },
    },
  });
  f.controls.locate();
  assert.match(f.status.textContent, /unavailable/);
});
test('insecure, unsupported and cockpit cases do not request location or move the map', (t) => {
  for (const options of [
    { secure: false },
    { geolocation: null },
    { begin: () => false },
  ]) {
    const f = fixture(t, options);
    f.controls.locate();
    assert.equal(f.requests.length, 0);
    assert.equal(f.flights.length, 0);
    assert.equal(f.status.dataset.state, 'error');
  }
});
test('invalid coordinates are rejected without logging, storing or navigating', (t) => {
  for (const [latitude, longitude] of [
    [NaN, 0],
    [91, 0],
    [0, 181],
    [undefined, undefined],
  ]) {
    const f = fixture(t);
    f.controls.locate();
    f.requests[0][0]({ coords: { latitude, longitude } });
    assert.equal(f.flights.length, 0);
    assert.equal(f.status.dataset.state, 'error');
  }
});
test('a newer navigation, page hide or destroy invalidates callbacks and releases listeners', (t) => {
  for (const action of ['supersede', 'hide', 'destroy']) {
    const f = fixture(t);
    f.controls.locate();
    if (action === 'supersede') f.supersede();
    else if (action === 'hide')
      f.lifecycleTarget.dispatchEvent(new Event('pagehide'));
    else f.controls.destroy();
    f.requests[0][0](fix);
    f.requests[0][1]({ code: 1 });
    assert.equal(f.flights.length, 0);
    assert.equal(f.controls.pending, false);
    if (action === 'destroy') {
      f.button.dispatchEvent(new Event('click'));
      assert.equal(f.requests.length, 1);
      assert.equal(f.status.hidden, true);
    }
  }
});
test('the browser timeout feedback timer is cleared on disposal and a canceled center has honest feedback', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { center: () => false });
  f.controls.locate();
  f.requests[0][0](fix);
  assert.equal(f.status.dataset.state, 'error');
  f.controls.destroy();
  t.mock.timers.tick(20000);
  assert.equal(f.status.hidden, true);
});
