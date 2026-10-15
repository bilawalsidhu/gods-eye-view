import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENGINE_KINDS,
  INPUT_TYPES,
  assertGlobeEngine,
  createEngineEvent,
} from './contract.js';
import { createFakeEngine } from './testing/fakeEngine.js';
import {
  createContractSuite,
  runContractSuite,
} from './testing/contractSuite.mjs';

test('engine event adds, raises and removes listeners in registration order', () => {
  const event = createEngineEvent();
  const seen = [];
  const a = (value) => seen.push(['a', value]);
  const b = (value) => seen.push(['b', value]);
  const removeA = event.addEventListener(a);
  event.addEventListener(b);
  assert.equal(typeof removeA, 'function');
  assert.equal(event.numberOfListeners, 2);
  event.raiseEvent(1);
  removeA();
  event.raiseEvent(2);
  assert.equal(event.removeEventListener(b), true);
  assert.equal(event.removeEventListener(b), false);
  event.raiseEvent(3);
  assert.deepEqual(seen, [
    ['a', 1],
    ['b', 1],
    ['b', 2],
  ]);
  assert.equal(event.numberOfListeners, 0);
});

test('engine event passes every argument and rejects non-functions', () => {
  const event = createEngineEvent();
  let args;
  event.addEventListener((...values) => (args = values));
  event.raiseEvent(1, 'two', null);
  assert.deepEqual(args, [1, 'two', null]);
  assert.throws(() => event.addEventListener(null), TypeError);
});

test('removing listeners during dispatch is safe, as with Cesium.Event', () => {
  const event = createEngineEvent();
  const seen = [];
  let removeLater;
  const removeSelf = event.addEventListener(() => {
    seen.push('self');
    removeSelf();
  });
  event.addEventListener(() => {
    seen.push('remover');
    removeLater();
  });
  removeLater = event.addEventListener(() => seen.push('later'));
  event.addEventListener(() => seen.push('last'));
  event.raiseEvent();
  event.raiseEvent();
  assert.deepEqual(seen, ['self', 'remover', 'last', 'remover', 'last']);
  assert.equal(event.numberOfListeners, 2);
});

test('listeners added during dispatch run from the next raise', () => {
  const event = createEngineEvent();
  const seen = [];
  event.addEventListener(() => {
    seen.push('first');
    if (seen.length === 1) event.addEventListener(() => seen.push('added'));
  });
  event.raiseEvent();
  event.raiseEvent();
  assert.deepEqual(seen, ['first', 'first', 'added']);
});

test('a listener can be added again after removal, and each handle removes its own entry', () => {
  const event = createEngineEvent();
  let count = 0;
  const listener = () => count++;
  const first = event.addEventListener(listener);
  first();
  first();
  const second = event.addEventListener(listener);
  const third = event.addEventListener(listener);
  event.raiseEvent();
  assert.equal(count, 2);
  second();
  event.raiseEvent();
  assert.equal(count, 3);
  third();
  event.raiseEvent();
  assert.equal(count, 3);
});

test('a throwing listener does not leave the event stuck in dispatch', () => {
  const event = createEngineEvent();
  const remove = event.addEventListener(() => {
    throw new Error('boom');
  });
  assert.throws(() => event.raiseEvent(), /boom/);
  remove();
  assert.equal(event.numberOfListeners, 0);
  let called = false;
  event.addEventListener(() => (called = true));
  event.raiseEvent();
  assert.equal(called, true);
});

test('assertGlobeEngine accepts a complete engine and names every missing capability', () => {
  const engine = createFakeEngine();
  assert.equal(assertGlobeEngine(engine), engine);
  assert.deepEqual(ENGINE_KINDS, ['cesium', 'navara']);
  assert.deepEqual(INPUT_TYPES, ['click', 'doubleClick', 'move', 'down', 'up']);

  const broken = {
    ...engine,
    kind: 'webgl',
    camera: { ...engine.camera, flyTo: undefined, moveEnd: {} },
    frames: undefined,
    surface: { ...engine.surface, supported: 'yes' },
  };
  delete broken.maps;
  assert.throws(
    () => assertGlobeEngine(broken),
    (error) => {
      assert.ok(error instanceof TypeError);
      for (const path of [
        'kind',
        'camera.flyTo',
        'camera.moveEnd',
        'frames',
        'surface.supported',
        'maps',
      ])
        assert.match(
          error.message,
          new RegExp(`\\b${path.replace('.', '\\.')}\\b`),
        );
      assert.doesNotMatch(error.message, /camera\.setView/);
      return true;
    },
  );
  assert.throws(() => assertGlobeEngine(null), TypeError);
});

test('the fake engine passes the engine contract suite', async (t) => {
  const engine = createFakeEngine();
  const checks = createContractSuite(engine, {
    waitFrames: async (count) => engine.fake.frames(count),
  });
  assert.ok(checks.length >= 15);
  assert.equal(new Set(checks.map((check) => check.name)).size, checks.length);
  for (const check of checks) await t.test(check.name, () => check.run());
});

test('the contract suite reports failures of a misbehaving engine', async () => {
  const engine = createFakeEngine();
  // An engine whose projection ignores the camera must fail the projector checks.
  engine.fake.script('worldToWindow', () => ({ x: 0, y: 0 }));
  const results = await runContractSuite(engine, {
    waitFrames: async (count) => engine.fake.frames(count),
  });
  const failed = results.filter((result) => !result.ok);
  assert.ok(failed.some((result) => /worldToWindow/.test(result.name)));
  assert.ok(failed.every((result) => result.error instanceof Error));
  assert.ok(results.some((result) => result.ok));
});
