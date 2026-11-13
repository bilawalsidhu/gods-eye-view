import assert from 'node:assert/strict';
import test from 'node:test';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';
import { PointerReticle, RETICLE_LINGER_MS, RETICLE_MAX_MS } from './pointerReticle.js';

const css = readStylesheet(new URL('../../style.css', import.meta.url));

function fakeStore() {
  return {
    reticles: new Map(),
    publishes: 0,
    get reticle() {
      return [...this.reticles.values()].at(-1) ?? null;
    },
    publish(owner, view) {
      if (view) this.reticles.set(owner, view);
      else this.reticles.delete(owner);
      this.publishes += 1;
    },
  };
}

function harness() {
  const store = fakeStore();
  const timers = new Map();
  let next = 1;
  const reticle = new PointerReticle({
    store,
    rectOf: () => ({ left: 10, top: 20 }),
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const fire = () => {
    const [[id, timer]] = [...timers];
    timers.delete(id);
    timer.fn();
  };
  return { store, timers, reticle, fire };
}

const pointer = { kind: 'this', label: 'UPS793', screenPx: { x: 600, y: 200 } };

test('reticle: shows at the pointed pixel and caps its lifetime', () => {
  const { store, timers, reticle, fire } = harness();
  assert.equal(store.reticle, null);
  reticle.handle({ type: 'pointer', pointer });
  assert.deepEqual(store.reticle, { visible: true, left: 610, top: 220, target: 'entity' });
  assert.equal([...timers.values()][0].ms, RETICLE_MAX_MS);
  fire();
  assert.deepEqual(store.reticle, { visible: false, left: 610, top: 220, target: 'entity' });
});

test('reticle: leaves when a tool moves the camera, lingers after a reply', () => {
  const { store, timers, reticle, fire } = harness();
  reticle.handle({ type: 'pointer', pointer: { ...pointer, kind: 'here' } });
  const hidden = () => !store.reticle.visible;
  assert.equal(store.reticle.target, 'ground');
  reticle.handle({ type: 'action-call', name: 'analyst_query', callId: 'c1' });
  reticle.handle({ type: 'action-call', name: 'analyst_query', callId: 'c2' });
  reticle.handle({ type: 'action-result', name: 'analyst_query', callId: 'c1' });
  reticle.handle({ type: 'completion' });
  assert.equal([...timers.values()][0].ms, RETICLE_MAX_MS, 'a sibling call still running keeps it');
  reticle.handle({ type: 'action-result', name: 'analyst_query', callId: 'c2' });
  reticle.handle({ type: 'completion' });
  assert.equal([...timers.values()][0].ms, RETICLE_LINGER_MS);
  fire();
  assert.equal(hidden(), true);
  reticle.handle({ type: 'pointer', pointer });
  reticle.handle({ type: 'action-call', name: 'track_entity' });
  assert.equal(hidden(), true, 'camera tools hide it at once');
  reticle.handle({ type: 'pointer', pointer });
  reticle.handle({ type: 'state', state: 'idle' });
  assert.equal(hidden(), true, 'session end hides it');
  assert.equal(timers.size, 0);
  reticle.destroy();
  reticle.destroy();
  assert.equal(store.reticle, null, 'destroy withdraws the reticle');
  const publishes = store.publishes;
  reticle.handle({ type: 'pointer', pointer });
  assert.equal(store.publishes, publishes, 'destroyed reticle ignores events');
});

test('reticle: each reticle keeps its own point', () => {
  const store = fakeStore();
  const rectOf = () => ({ left: 0, top: 0 });
  const older = new PointerReticle({ store, rectOf, setTimer: () => 1, clearTimer() {} });
  const newer = new PointerReticle({ store, rectOf, setTimer: () => 2, clearTimer() {} });
  older.handle({ type: 'pointer', pointer });
  newer.handle({ type: 'pointer', pointer: { ...pointer, screenPx: { x: 5, y: 6 } } });
  newer.handle({ type: 'state', state: 'idle' });
  assert.equal(store.reticles.get(older).visible, true, 'hiding the newer one leaves the older one');
  newer.destroy();
  assert.deepEqual([...store.reticles.keys()], [older]);
  assert.notEqual(older.key, newer.key);
  older.destroy();
  assert.equal(store.reticles.size, 0);
});

test('reticle css: overlay is inert and hidden in Clean-UI and recording', () => {
  assert.match(css, /\.gev-pointer-reticle\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /body\.ui-clean-view \.gev-pointer-reticle/);
  assert.match(css, /body\.recording-mode \.gev-pointer-reticle/);
  assert.match(css, /\.gev-pointer-reticle\[hidden\]/);
});
