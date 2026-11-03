import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENGINE_KINDS,
  GLOBE_ENGINE_MEMBERS,
  INPUT_TYPES,
  MODIFIERS,
  BLOOM_INITIAL,
  ENGINE_CAPABILITIES,
  OPTIONAL_ENGINE_MEMBERS,
  SHARPEN_INITIAL,
  assertGlobeEngine,
  createEngineEvent,
  engineCapabilities,
  isEngineEvent,
  mergeBloom,
  mergeSharpen,
  mergeStyle,
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

test('a listener removed during dispatch is not called in that dispatch', () => {
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

test('adding the same listener twice registers it once; every remover handle is idempotent', () => {
  const event = createEngineEvent();
  let count = 0;
  const listener = () => count++;
  const first = event.addEventListener(listener);
  const second = event.addEventListener(listener);
  assert.equal(event.numberOfListeners, 1);
  event.raiseEvent();
  assert.equal(count, 1);
  second();
  second();
  first();
  event.raiseEvent();
  assert.equal(count, 1);
  assert.equal(event.numberOfListeners, 0);
  const again = event.addEventListener(listener);
  first();
  event.raiseEvent();
  assert.equal(count, 2, 'a stale handle removed a newer registration');
  again();
  assert.equal(event.numberOfListeners, 0);
});

test('removing and re-adding a listener during dispatch leaves it registered', () => {
  const event = createEngineEvent();
  const seen = [];
  const later = () => seen.push('later');
  event.addEventListener(() => {
    seen.push('first');
    if (seen.length > 1) return;
    event.removeEventListener(later);
    event.addEventListener(later);
  });
  event.addEventListener(later);
  event.raiseEvent();
  assert.equal(event.numberOfListeners, 2);
  event.raiseEvent();
  assert.deepEqual(seen, ['first', 'first', 'later']);
});

test('engine events are branded so a raw Cesium.Event fails the shape check', () => {
  assert.equal(isEngineEvent(createEngineEvent()), true);
  const raw = { addEventListener() {}, removeEventListener() {} };
  assert.equal(isEngineEvent(raw), false);
  const engine = createFakeEngine();
  assert.throws(
    () =>
      assertGlobeEngine({
        ...engine,
        frames: { ...engine.frames, preRender: raw },
      }),
    /frames\.preRender/,
  );
  assert.deepEqual(MODIFIERS, ['ctrl', 'shift', 'alt']);
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

test('the contract carries what the shell infrastructure needs', () => {
  for (const member of [
    'camera.livePosition',
    'camera.height',
    'maps.releasePhotorealTiles',
    'maps.current',
  ])
    assert.ok(GLOBE_ENGINE_MEMBERS.includes(member), member);
  const engine = createFakeEngine();
  const broken = {
    ...engine,
    camera: { ...engine.camera, livePosition: undefined, height: 1 },
    maps: { ...engine.maps, releasePhotorealTiles: undefined },
  };
  assert.throws(
    () => assertGlobeEngine(broken),
    /camera\.livePosition.*camera\.height.*maps\.releasePhotorealTiles/,
  );
});

test('the contract carries what shell navigation needs', () => {
  for (const member of ['camera.commanded', 'picker.pickGlobe', 'isDestroyed'])
    assert.ok(GLOBE_ENGINE_MEMBERS.includes(member), member);
  const engine = createFakeEngine();
  const broken = {
    ...engine,
    camera: { ...engine.camera, commanded: {} },
    picker: { ...engine.picker, pickGlobe: undefined },
    isDestroyed: false,
  };
  assert.throws(
    () => assertGlobeEngine(broken),
    /camera\.commanded.*picker\.pickGlobe.*isDestroyed/,
  );
});

test('the fake engine passes the engine contract suite', async (t) => {
  const engine = createFakeEngine();
  const checks = createContractSuite(engine, {
    waitFrames: async (count) => engine.fake.frames(count),
    // The fake's input, as a real pointer would drive it.
    pointer: {
      click: async (x, y) => engine.fake.input('click', { position: { x, y } }),
      move: async (x, y) =>
        engine.fake.input('move', {
          startPosition: { x: x - 1, y },
          endPosition: { x, y },
        }),
    },
    mapSources: {
      imagery: [{ kind: 'osm' }, { kind: 'esri-imagery' }],
      photoreal: { kind: 'photoreal' },
    },
  });
  assert.ok(checks.length >= 15);
  assert.ok(checks.some(({ name }) => name.startsWith('maps:')));
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

test('the contract suite rejects a raw Cesium-style event that double-registers', async () => {
  const engine = createFakeEngine();
  // Cesium.Event pushes a listener again when it is added twice.
  const listeners = [];
  const raw = {
    addEventListener(listener) {
      listeners.push(listener);
      return () => raw.removeEventListener(listener);
    },
    removeEventListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
      return index >= 0;
    },
  };
  engine.frames.postRender.addEventListener((time) => {
    for (const listener of [...listeners]) listener(time);
  });
  const wrapped = { ...engine, frames: { ...engine.frames, postRender: raw } };
  const results = await runContractSuite(wrapped, {
    waitFrames: async (count) => engine.fake.frames(count),
  });
  const failed = results.filter((result) => !result.ok).map((r) => r.name);
  assert.ok(
    failed.some((name) => /twice/.test(name)),
    failed.join('\n'),
  );
});

test('raiseValue raises exactly one argument with the event semantics', () => {
  const event = createEngineEvent();
  const seen = [];
  const second = (...values) => seen.push(['second', values]);
  event.addEventListener((...values) => {
    seen.push(['first', values]);
    event.removeEventListener(second);
  });
  event.addEventListener(second);
  event.raiseValue(42);
  assert.deepEqual(seen, [['first', [42]]]);
  assert.equal(event.numberOfListeners, 1);
});

test('the contract carries the sharpening and checks its values', () => {
  for (const member of ['render.setSharpen', 'render.sharpen'])
    assert.ok(GLOBE_ENGINE_MEMBERS.includes(member), member);
  assert.deepEqual(SHARPEN_INITIAL, { enabled: false, amount: 1 });
  const on = mergeSharpen(SHARPEN_INITIAL, { enabled: true });
  assert.deepEqual(on, { enabled: true, amount: 1 });
  assert.deepEqual(mergeSharpen(on, { amount: 0 }), {
    enabled: true,
    amount: 0,
  });
  assert.deepEqual(mergeSharpen(on), on);
  for (const bad of [
    { enabled: 1 },
    { amount: -1 },
    { amount: Infinity },
    { amount: null },
  ])
    assert.throws(() => mergeSharpen(on, bad), TypeError);
});

test('the contract carries the app clock', () => {
  for (const member of ['clock.now', 'clock.frameTime', 'clock.ticked'])
    assert.ok(GLOBE_ENGINE_MEMBERS.includes(member), member);
  const engine = createFakeEngine();
  assert.equal(assertGlobeEngine(engine), engine);
  const broken = {
    ...engine,
    clock: { ...engine.clock, frameTime: 1, ticked: {} },
  };
  assert.throws(
    () => assertGlobeEngine(broken),
    /clock\.frameTime.*clock\.ticked/,
  );
  const missing = { ...engine };
  delete missing.clock;
  assert.throws(() => assertGlobeEngine(missing), /\bclock\b/);
});

test('the contract carries instanced movers', () => {
  for (const member of ['movers.createSet', 'movers.list'])
    assert.ok(GLOBE_ENGINE_MEMBERS.includes(member), member);
  const engine = createFakeEngine();
  const broken = { ...engine, movers: { createSet: 1 } };
  assert.throws(
    () => assertGlobeEngine(broken),
    /movers\.createSet.*movers\.list/,
  );
});

test('the contract carries dynamic lines', () => {
  for (const member of ['lines.createLine', 'lines.list'])
    assert.ok(GLOBE_ENGINE_MEMBERS.includes(member), member);
  const engine = createFakeEngine();
  assert.equal(assertGlobeEngine(engine), engine);
  const broken = { ...engine, lines: {} };
  assert.throws(
    () => assertGlobeEngine(broken),
    /lines\.createLine.*lines\.list/,
  );
});

test('the contract carries the follow camera', () => {
  for (const member of [
    'camera.follow',
    'camera.following',
    'camera.followChanged',
  ])
    assert.ok(GLOBE_ENGINE_MEMBERS.includes(member), member);
  const engine = createFakeEngine();
  const broken = { ...engine, camera: { ...engine.camera, followChanged: {} } };
  assert.throws(() => assertGlobeEngine(broken), /camera\.followChanged/);
});

test('engineCapabilities names the optional capabilities an engine has whole', () => {
  assert.ok(ENGINE_CAPABILITIES.includes('visualStyles'));
  assert.deepEqual(OPTIONAL_ENGINE_MEMBERS.visualStyles, [
    'render.visualStyles',
    'render.setStyle',
    'render.style',
  ]);
  const plain = createFakeEngine();
  for (const flag of ENGINE_CAPABILITIES)
    assert.equal(engineCapabilities(plain)[flag], false, flag);
  const styled = createFakeEngine({
    visualStyles: { thermal: ['palette', 'time'] },
  });
  assert.equal(engineCapabilities(styled).visualStyles, true);
  assert.equal(assertGlobeEngine(styled), styled);
  assert.equal(engineCapabilities(null).visualStyles, false);
});

test('assertGlobeEngine refuses half an optional capability', () => {
  const engine = createFakeEngine({ visualStyles: { noir: ['grainAmt'] } });
  const half = { ...engine, render: { ...engine.render, style: undefined } };
  assert.throws(() => assertGlobeEngine(half), /render\.style\b/);
  const badList = {
    ...engine,
    render: { ...engine.render, visualStyles: [] },
  };
  assert.throws(() => assertGlobeEngine(badList), /render\.visualStyles/);
});

test('mergeStyle keeps omitted fields, copies uniforms and rejects bad values', () => {
  const current = { intensity: 0, uniforms: { palette: 0, time: 0 } };
  const names = ['palette', 'time'];
  const next = mergeStyle(current, { intensity: 0.4 }, names);
  assert.deepEqual(next, { intensity: 0.4, uniforms: { palette: 0, time: 0 } });
  assert.notEqual(next.uniforms, current.uniforms);
  assert.deepEqual(mergeStyle(next, { uniforms: { palette: 1 } }, names), {
    intensity: 0.4,
    uniforms: { palette: 1, time: 0 },
  });
  for (const bad of [
    { intensity: 1.01 },
    { intensity: -1 },
    { intensity: Number.NaN },
    { intensity: '1' },
    { uniforms: null },
    { uniforms: { other: 1 } },
    { uniforms: { palette: Number.POSITIVE_INFINITY } },
  ])
    assert.throws(() => mergeStyle(current, bad, names), TypeError);
});

test('a fake engine with visual styles passes the optional style check', async (t) => {
  const engine = createFakeEngine({
    visualStyles: { retro: ['pixelation', 'time'], noir: ['grainAmt'] },
  });
  const checks = createContractSuite(engine, {
    waitFrames: async (count) => engine.fake.frames(count),
  });
  const style = checks.filter(({ name }) => /visualStyles/.test(name));
  assert.equal(style.length, 1);
  for (const check of style) await t.test(check.name, () => check.run());
  assert.equal(engine.render.style('retro').intensity, 0);
  // Without the capability the check is not in the suite.
  const plain = createContractSuite(createFakeEngine(), {
    waitFrames: async () => {},
  });
  assert.ok(!plain.some(({ name }) => /visualStyles/.test(name)));
});

test('the bloom capability: whole or absent, merged and checked', async (t) => {
  assert.ok(ENGINE_CAPABILITIES.includes('bloom'));
  assert.deepEqual(OPTIONAL_ENGINE_MEMBERS.bloom, [
    'render.setBloom',
    'render.bloom',
  ]);
  const engine = createFakeEngine({ bloom: true });
  assert.equal(engineCapabilities(engine).bloom, true);
  assert.equal(engineCapabilities(engine).visualStyles, false);
  assert.deepEqual(engine.render.bloom(), BLOOM_INITIAL);
  const half = { ...engine, render: { ...engine.render, bloom: undefined } };
  assert.throws(() => assertGlobeEngine(half), /render\.bloom\b/);
  assert.deepEqual(mergeBloom(BLOOM_INITIAL, { strength: 0.5 }), {
    enabled: false,
    strength: 0.5,
  });
  for (const bad of [{ enabled: 'on' }, { strength: 2 }, { strength: -1 }])
    assert.throws(() => mergeBloom(BLOOM_INITIAL, bad), TypeError);
  const checks = createContractSuite(engine, {
    waitFrames: async (count) => engine.fake.frames(count),
  }).filter(({ name }) => /\(bloom\)/.test(name));
  assert.equal(checks.length, 1);
  for (const check of checks) await t.test(check.name, () => check.run());
});
