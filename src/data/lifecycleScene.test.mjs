import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerLifecycle } from './lifecycle.js';

// A layer with a renderer lifetime: it outlives scenes through
// detachRenderer()/attachRenderer(). Hooks replace the default behaviour.
function sceneLayer(id, hooks = {}) {
  const calls = [];
  const module = {
    id,
    name: id,
    icon: '',
    source: 'test',
    init(viewer, context) {
      calls.push('init');
      module.attachRenderer(viewer, context);
      return true;
    },
    attachRenderer(viewer, context) {
      calls.push(['attach', viewer]);
      return hooks.attach?.(viewer, context);
    },
    detachRenderer(viewer) {
      calls.push(['detach', viewer]);
      return hooks.detach?.(viewer);
    },
    enable: () => true,
    update(viewer) {
      calls.push(['update', viewer]);
      return true;
    },
    disable: () => true,
    destroy: () => true,
  };
  return { module, calls };
}

function catalog(...modules) {
  return {
    layers: modules,
    metadata: modules.map(({ id }) => ({
      id,
      disposition: 'enabled-only',
      token: id,
    })),
  };
}

const engine = (name) => ({ kind: 'test', name });
const firstViewer = { name: 'first viewer' };
const secondViewer = { name: 'second viewer' };

async function boundManager(...layers) {
  const manager = new LayerLifecycle(firstViewer, {
    engine: engine('first'),
  });
  const modules = layers.map(({ module }) => module);
  await manager.bindCatalog(firstViewer, engine('first'), catalog(...modules));
  for (const { module } of layers)
    assert.equal(
      await manager.setEnabled(module.id, true, { origin: 'user' }),
      true,
    );
  return { manager, modules };
}

// Detach failures are also logged; keep the test output to the assertions.
async function quietly(run) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = warn;
  }
}

const detaches = (calls) => calls.filter((call) => call[0] === 'detach');
const attaches = (calls) => calls.filter((call) => call[0] === 'attach');

test('one failing detachRenderer leaves the others released and the manager unbound', async () => {
  let failures = 1;
  const broken = sceneLayer('broken', {
    detach() {
      if (failures-- > 0) throw new Error('release failed');
    },
  });
  const after = sceneLayer('after');
  const { manager, modules } = await boundManager(broken, after);

  await assert.rejects(
    quietly(() => manager.detachScene()),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map(({ message }) => message),
        ['release failed'],
      );
      return true;
    },
  );
  assert.deepEqual(detaches(after.calls), [['detach', firstViewer]]);
  assert.equal(manager.viewer, null);
  assert.equal(manager.engine, null);
  assert.equal(manager.registrationsFinalized, false);

  // A repeated detach retries only the failed release, on its own viewer.
  await manager.detachScene();
  assert.deepEqual(detaches(broken.calls), [
    ['detach', firstViewer],
    ['detach', firstViewer],
  ]);
  assert.equal(detaches(after.calls).length, 1);

  // The next scene binds and both retained layers attach to it.
  await manager.bindCatalog(
    secondViewer,
    engine('second'),
    catalog(...modules),
  );
  assert.equal(manager.viewer, secondViewer);
  assert.deepEqual(attaches(broken.calls).at(-1), ['attach', secondViewer]);
  assert.deepEqual(attaches(after.calls).at(-1), ['attach', secondViewer]);
  assert.equal(manager.isEnabled('broken'), true);
});

test('bindCatalog after a failed detach retries the release before attaching', async () => {
  let failures = 1;
  const broken = sceneLayer('broken', {
    detach() {
      if (failures-- > 0) throw new Error('release failed');
    },
  });
  const { manager, modules } = await boundManager(broken);
  await assert.rejects(
    quietly(() => manager.detachScene()),
    AggregateError,
  );

  await manager.bindCatalog(
    secondViewer,
    engine('second'),
    catalog(...modules),
  );
  assert.deepEqual(broken.calls.slice(-3), [
    ['detach', firstViewer],
    ['detach', firstViewer],
    ['attach', secondViewer],
  ]);
  // The scene is settled: the next detach releases the second viewer once.
  await manager.detachScene();
  assert.deepEqual(broken.calls.at(-1), ['detach', secondViewer]);
});

test('an asynchronous attach detached mid-flight stops before the release', async () => {
  let resume;
  let attachSignal;
  let attachFinished = false;
  let sawAbortBeforeFinishing = null;
  const slow = sceneLayer('slow', {
    async attach(viewer, { signal }) {
      if (viewer !== secondViewer) return;
      attachSignal = signal;
      await new Promise((resolve) => {
        resume = resolve;
      });
      sawAbortBeforeFinishing = signal.aborted;
      attachFinished = true;
    },
    detach() {
      assert.equal(
        attachFinished || attachSignal === undefined,
        true,
        'the release waits for the attachment to stop',
      );
    },
  });
  const { manager, modules } = await boundManager(slow);
  await manager.detachScene();

  const bound = manager.bindCatalog(
    secondViewer,
    engine('second'),
    catalog(...modules),
  );
  assert.ok(bound?.then, 'an asynchronous attachment is awaited');
  assert.equal(attachSignal.aborted, false);

  const detached = manager.detachScene();
  assert.equal(attachSignal.aborted, true);
  let released = false;
  void detached.then(() => {
    released = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, false, 'the detach waits for the attachment');
  assert.equal(detaches(slow.calls).length, 1);

  resume();
  await detached;
  await bound;
  assert.equal(sawAbortBeforeFinishing, true);
  assert.deepEqual(detaches(slow.calls).at(-1), ['detach', secondViewer]);
});

test('periodic refreshes due while no scene is bound run after the next bind', async () => {
  const layer = sceneLayer('feed');
  const { manager, modules } = await boundManager(layer);
  const entry = manager.layers.get('feed');
  const updates = () =>
    layer.calls.filter((call) => call[0] === 'update').length;
  const before = updates();

  await manager.detachScene();
  assert.equal(await manager._runPeriodicUpdate('feed', entry), false);
  assert.equal(updates(), before, 'no refresh against a detached scene');
  assert.equal(entry.refreshDeferred, true);

  await manager.bindCatalog(
    secondViewer,
    engine('second'),
    catalog(...modules),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates(), before + 1);
  assert.deepEqual(layer.calls.at(-1), ['update', secondViewer]);
  assert.equal(entry.refreshDeferred, false);
});

test('a legacy layer that cannot be destroyed is dropped so the next catalog binds', async () => {
  const legacy = {
    id: 'legacy',
    name: 'legacy',
    icon: '',
    source: 'test',
    init: () => true,
    enable: () => true,
    update: () => true,
    disable() {
      throw new Error('disable failed');
    },
    destroy: () => true,
  };
  const retained = sceneLayer('retained');
  const manager = new LayerLifecycle(firstViewer, { engine: engine('first') });
  await manager.bindCatalog(
    firstViewer,
    engine('first'),
    catalog(legacy, retained.module),
  );
  await manager.setEnabled('legacy', true, { origin: 'user' });
  await manager.setEnabled('retained', true, { origin: 'user' });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(manager.detachScene(), /could not detach/);
  } finally {
    console.warn = warn;
  }
  assert.equal(manager.layers.has('legacy'), false);
  assert.deepEqual(detaches(retained.calls), [['detach', firstViewer]]);

  const fresh = { ...legacy, disable: () => true };
  await manager.bindCatalog(
    secondViewer,
    engine('second'),
    catalog(fresh, retained.module),
  );
  assert.equal(manager.layers.get('legacy').module, fresh);
});

test('QA layers are reported when a scene switch drops them', async () => {
  const retained = sceneLayer('retained');
  const manager = new LayerLifecycle(firstViewer, {
    engine: engine('first'),
    allowQaRegistration: true,
  });
  await manager.bindCatalog(
    firstViewer,
    engine('first'),
    catalog(retained.module),
  );
  manager.registerForQa({
    id: 'qa-probe',
    name: 'QA',
    icon: '',
    source: 'test',
    init: () => true,
    enable: () => true,
    update: () => true,
    disable: () => true,
    destroy: () => true,
  });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await manager.detachScene();
  } finally {
    console.warn = warn;
  }
  assert.equal(manager.layers.has('qa-probe'), false);
  assert.ok(warnings.some((line) => line.includes('qa-probe')));
});
