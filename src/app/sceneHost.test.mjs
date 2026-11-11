import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneHost, SceneSwitchingError } from './sceneHost.js';

function recordingPart(name, log, { failAttach = false } = {}) {
  const part = {
    name,
    signals: [],
    async attachScene(scene, { signal, defer }) {
      log.push(`attach ${name} ${scene.kind}`);
      part.signals.push(signal);
      defer(() => log.push(`cleanup ${name}`));
      if (failAttach) throw new Error(`${name} failed`);
    },
    detachScene(options) {
      log.push(`detach ${name}${options?.handoff ? ' handoff' : ''}`);
    },
  };
  return part;
}

test('parts attach in order and detach in reverse, cleanups first', async () => {
  const log = [];
  const host = createSceneHost();
  const a = recordingPart('a', log);
  const b = recordingPart('b', log);
  host.register(a);
  host.register(b);
  const scene = { kind: 'cesium' };
  assert.equal(await host.attach(scene), scene);
  assert.equal(host.current(), scene);
  assert.equal(host.state(), 'attached');
  await host.detach({ handoff: true });
  assert.deepEqual(log, [
    'attach a cesium',
    'attach b cesium',
    'cleanup b',
    'detach b handoff',
    'cleanup a',
    'detach a handoff',
  ]);
  assert.equal(host.current(), null);
  assert.ok(a.signals[0].aborted, 'the attachment signal aborts on detach');
});

test('a failed part detaches the parts already attached and aborts only that attachment', async () => {
  const log = [];
  const host = createSceneHost();
  const a = recordingPart('a', log);
  const b = recordingPart('b', log, { failAttach: true });
  const c = recordingPart('c', log);
  for (const part of [a, b, c]) host.register(part);
  await assert.rejects(host.attach({ kind: 'navara' }), /b failed/);
  assert.deepEqual(log, [
    'attach a navara',
    'attach b navara',
    'cleanup b',
    'detach b',
    'cleanup a',
    'detach a',
  ]);
  assert.equal(host.state(), 'detached');
  assert.ok(a.signals[0].aborted);
  // The working engine attaches again on the same parts.
  b.attachScene = async (scene, { defer }) => {
    log.push(`attach b ${scene.kind}`);
    defer(() => log.push('cleanup b'));
  };
  log.length = 0;
  await host.attach({ kind: 'cesium' });
  assert.deepEqual(log, [
    'attach a cesium',
    'attach b cesium',
    'attach c cesium',
  ]);
  assert.equal(a.signals.length, 2);
  assert.equal(a.signals[1].aborted, false);
});

test('detach is idempotent and a failing part does not stop the others', async () => {
  const log = [];
  const host = createSceneHost();
  host.register(recordingPart('a', log));
  host.register({
    name: 'bad',
    attachScene() {},
    detachScene() {
      throw new Error('bad detach');
    },
  });
  await host.detach();
  assert.deepEqual(log, []);
  await host.attach({ kind: 'cesium' });
  await assert.rejects(host.detach(), AggregateError);
  assert.ok(log.includes('detach a'));
  assert.equal(host.state(), 'detached');
  await host.detach();
  assert.equal(log.filter((line) => line === 'detach a').length, 1);
});

test('a part registered while attached attaches at once and detaches with the rest', async () => {
  const log = [];
  const host = createSceneHost();
  host.register(recordingPart('a', log));
  await host.attach({ kind: 'cesium' });
  await host.register(recordingPart('late', log));
  assert.deepEqual(log, ['attach a cesium', 'attach late cesium']);
  await host.detach();
  assert.deepEqual(log.slice(2), [
    'cleanup late',
    'detach late',
    'cleanup a',
    'detach a',
  ]);
  assert.deepEqual(host.parts(), ['a', 'late']);
});

test('attach refuses while a scene is attached', async () => {
  const host = createSceneHost();
  await host.attach({ kind: 'cesium' });
  await assert.rejects(host.attach({ kind: 'navara' }), /while attached/);
});

test('whenAttached resolves on the next attachment and rejects on abort or timeout', async () => {
  const host = createSceneHost();
  const waiting = host.whenAttached();
  const scene = { kind: 'navara' };
  await host.attach(scene);
  assert.equal(await waiting, scene);
  assert.equal(await host.whenAttached(), scene);
  await host.detach();
  const controller = new AbortController();
  const aborted = host.whenAttached({ signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, (error) => {
    assert.ok(error instanceof SceneSwitchingError);
    assert.equal(error.code, 'ENGINE_SWITCHING');
    return true;
  });
  await assert.rejects(
    host.whenAttached({ timeoutMs: 5 }),
    (error) => error.code === 'ENGINE_SWITCHING',
  );
});

test('subscribers see every state of a switch', async () => {
  const host = createSceneHost();
  const states = [];
  const off = host.subscribe(({ state }) => states.push(state));
  await host.attach({ kind: 'cesium' });
  await host.detach();
  off();
  await host.attach({ kind: 'navara' });
  assert.deepEqual(states, ['attaching', 'attached', 'detaching', 'detached']);
});

test('a detach requested during an attach waits for it', async () => {
  const log = [];
  const host = createSceneHost();
  let release;
  host.register({
    name: 'slow',
    async attachScene() {
      log.push('attach start');
      await new Promise((resolve) => (release = resolve));
      log.push('attach end');
    },
    detachScene() {
      log.push('detach');
    },
  });
  const attaching = host.attach({ kind: 'cesium' });
  const detaching = host.detach();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await attaching;
  await detaching;
  assert.deepEqual(log, ['attach start', 'attach end', 'detach']);
  assert.equal(host.state(), 'detached');
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a transaction keeps outside work behind nested attachment and release', async () => {
  const host = createSceneHost();
  const gate = deferred();
  const entered = deferred();
  const log = [];
  await host.register({
    name: 'nested',
    async attachScene(_scene, { transaction }) {
      await host.run(() => log.push('nested attach'), transaction);
      entered.resolve();
      await gate.promise;
    },
    detachScene(_options, transaction) {
      return host.run(() => log.push('nested detach'), transaction);
    },
  });
  const switching = host.run(async (transaction) => {
    await host.attach({}, transaction);
    await host.detach({}, transaction);
    log.push('released');
  });
  await entered.promise;
  const outside = host.run(() => log.push('outside'));
  await Promise.resolve();
  assert.deepEqual(log, ['nested attach']);
  gate.resolve();
  await Promise.all([switching, outside]);
  assert.deepEqual(log, ['nested attach', 'nested detach', 'released', 'outside']);
});

test('late registration settles before a concurrent detach releases the part', async () => {
  const host = createSceneHost();
  await host.attach({});
  const gate = deferred();
  const entered = deferred();
  const log = [];
  const registering = host.register({
    name: 'late',
    async attachScene(_scene, { defer }) {
      entered.resolve();
      await gate.promise;
      defer(() => log.push('cleanup'));
      log.push('attached');
    },
    detachScene() { log.push('detached'); },
  });
  await entered.promise;
  const leaving = host.detach();
  gate.resolve();
  await Promise.all([registering, leaving]);
  assert.deepEqual(log, ['attached', 'cleanup', 'detached']);
});

test('replacement application parts use the same transition owner', async () => {
  const owner = createSceneHost();
  const gate = deferred();
  const entered = deferred();
  const log = [];
  let replacement;
  let expired;
  const switching = owner.run(async (transaction) => {
    expired = transaction;
    replacement = createSceneHost({ transitionHost: transaction.host });
    await replacement.register({
      name: 'replacement',
      attachScene() { log.push('attached'); },
      detachScene() { log.push('detached'); },
    }, transaction);
    await replacement.attach({}, transaction);
    entered.resolve();
    await gate.promise;
    log.push('restored');
  });
  await entered.promise;
  const leaving = replacement.detach();
  gate.resolve();
  await Promise.all([switching, leaving]);
  assert.deepEqual(log, ['attached', 'restored', 'detached']);
  const nextGate = deferred();
  const blocking = owner.run(() => nextGate.promise);
  const later = replacement.run(() => log.push('later'), expired);
  await Promise.resolve();
  assert.equal(log.includes('later'), false, 'an expired transaction cannot bypass the queue');
  nextGate.resolve();
  await Promise.all([blocking, later]);
  assert.equal(log.at(-1), 'later');
});

test('engine requests wait for the host and a newer pick can keep the current engine', async () => {
  const host = createSceneHost();
  const gate = deferred();
  const blocking = host.run(() => gate.promise);
  const calls = [];
  const switcher = host.createSwitcher({
    kind: 'cesium',
    requested: () => 'cesium',
    signal: new AbortController().signal,
    address: { select() {}, commit() {}, restore() {} },
    leave() { calls.push('leave'); },
    enter() { calls.push('enter'); },
  });
  const switching = switcher.select('navara');
  assert.equal(switcher.select('cesium'), switching);
  gate.resolve();
  await Promise.all([blocking, switching]);
  assert.deepEqual(calls, []);
  assert.equal(switcher.state().kind, 'cesium');
});

test('a request arriving in the next host operation starts a new switch', async () => {
  const host = createSceneHost();
  let address = 'cesium';
  const entered = [];
  const switcher = host.createSwitcher({
    kind: address,
    requested: () => address,
    signal: new AbortController().signal,
    address: {
      select() {},
      commit(_token, kind) { address = kind; },
      restore(kind) { address = kind; },
    },
    leave() {},
    enter(kind) { entered.push(kind); },
  });
  const first = switcher.select('navara');
  let next;
  const between = host.run(() => { next = switcher.select('cesium'); });
  await Promise.all([first, between]);
  await next;
  assert.deepEqual(entered, ['navara', 'cesium']);
  assert.equal(switcher.state().busy, false);
});
