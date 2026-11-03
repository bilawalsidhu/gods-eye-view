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
