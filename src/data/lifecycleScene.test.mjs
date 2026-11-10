import { createFakeEngine } from '../globe/testing/fakeEngine.js';
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
      module.attachRenderer(context);
      return true;
    },
    attachRenderer(context) {
      calls.push(['attach', context.engine]);
      return hooks.attach?.(context.engine?.name === 'second' ? secondViewer : firstViewer, context);
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

const engine = (name) => Object.assign(createFakeEngine({ kind: 'test' }), { name });
const firstViewer = { name: 'first viewer' };
const secondViewer = { name: 'second viewer' };

function bindCatalog(manager, engine, catalog, options) {
  manager.viewer = engine?.name === 'second' ? secondViewer : firstViewer;
  return manager.bindCatalog(engine, catalog, options);
}

async function boundManager(...layers) {
  const options = layers.at(-1)?.module ? {} : layers.pop();
  const manager = new LayerLifecycle(firstViewer, {
    engine: engine('first'),
    ...options,
  });
  const modules = layers.map(({ module }) => module);
  await bindCatalog(manager, engine('first'), catalog(...modules));
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
  const second = engine('second');
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
  await bindCatalog(
    manager,
    second,
    catalog(...modules),
  );
  assert.equal(manager.viewer, secondViewer);
  assert.deepEqual(attaches(broken.calls).at(-1), ['attach', second]);
  assert.deepEqual(attaches(after.calls).at(-1), ['attach', second]);
  assert.equal(manager.isEnabled('broken'), true);
});

test('bindCatalog after a failed detach retries the release before attaching', async () => {
  const second = engine('second');
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

  await bindCatalog(
    manager,
    second,
    catalog(...modules),
  );
  assert.deepEqual(broken.calls.slice(-3), [
    ['detach', firstViewer],
    ['detach', firstViewer],
    ['attach', second],
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

  const bound = bindCatalog(
    manager,
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

  await bindCatalog(
    manager,
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
  await bindCatalog(
    manager,
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
  await bindCatalog(
    manager,
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
  await bindCatalog(
    manager,
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

const updatesOf = (calls) => calls.filter((call) => call[0] === 'update');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a detach does not wait forever for an attachment that never settles', async () => {
  let attachSignal;
  const stuck = sceneLayer('stuck', {
    attach(viewer, { signal }) {
      if (viewer !== secondViewer) return undefined;
      attachSignal = signal;
      return new Promise(() => {});
    },
  });
  const { manager, modules } = await boundManager(stuck, {
    attachSettleTimeoutMs: 20,
  });
  await manager.detachScene();
  const bound = quietly(() =>
    bindCatalog(manager, engine('second'), catalog(...modules)),
  );
  await bound;
  assert.equal(manager.viewer, secondViewer, 'the bind went on without it');
  await quietly(() => manager.detachScene());
  assert.equal(attachSignal.aborted, true, 'the late attachment was told');
  assert.deepEqual(detaches(stuck.calls).at(-1), ['detach', secondViewer]);
});

test('a refresh due while attachments run is deferred once, not run twice', async () => {
  let finishAttach;
  const feed = sceneLayer('feed', {
    attach(viewer) {
      if (viewer !== secondViewer) return undefined;
      return new Promise((resolve) => {
        finishAttach = resolve;
      });
    },
  });
  const { manager, modules } = await boundManager(feed);
  const entry = manager.layers.get('feed');
  const before = updatesOf(feed.calls).length;
  await manager.detachScene();
  const bound = bindCatalog(
    manager,
    engine('second'),
    catalog(...modules),
  );
  // An interval tick while the next scene is still attaching.
  assert.equal(await manager._runPeriodicUpdate('feed', entry), false);
  assert.equal(updatesOf(feed.calls).length, before);
  finishAttach();
  await bound;
  await tick();
  assert.equal(updatesOf(feed.calls).length, before + 1);
  assert.equal(entry.refreshDeferred, false);
});

test('a normal refresh clears a deferred one', async () => {
  const feed = sceneLayer('feed');
  const { manager, modules } = await boundManager(feed);
  const entry = manager.layers.get('feed');
  await manager.detachScene();
  await manager._runPeriodicUpdate('feed', entry);
  assert.equal(entry.refreshDeferred, true);
  manager._sceneDetached = false;
  await manager._runPeriodicUpdate('feed', entry);
  assert.equal(entry.refreshDeferred, false);
  manager._sceneDetached = true;
  const before = updatesOf(feed.calls).length;
  await bindCatalog(
    manager,
    engine('second'),
    catalog(...modules),
  );
  await tick();
  assert.equal(updatesOf(feed.calls).length, before);
});

test('an explicit refresh between scenes waits for the next one and runs once', async () => {
  const feed = sceneLayer('feed');
  const { manager, modules } = await boundManager(feed);
  const entry = manager.layers.get('feed');
  await manager.detachScene();
  await manager._runPeriodicUpdate('feed', entry); // a deferred interval tick
  const before = updatesOf(feed.calls).length;
  const refreshed = manager.refreshLayer('feed');
  await tick();
  assert.equal(updatesOf(feed.calls).length, before);
  await bindCatalog(
    manager,
    engine('second'),
    catalog(...modules),
  );
  assert.equal(await refreshed, true);
  await tick();
  assert.deepEqual(updatesOf(feed.calls).slice(before), [
    ['update', secondViewer],
  ]);
});

test('an explicit refresh between scenes ends false when its caller aborts', async () => {
  const feed = sceneLayer('feed');
  const { manager } = await boundManager(feed);
  await manager.detachScene();
  const caller = new AbortController();
  const refreshed = manager.refreshLayer('feed', { signal: caller.signal });
  caller.abort();
  assert.equal(await refreshed, false);
});

test('a layer enabled between scenes initializes on the next scene', async () => {
  const second = engine('second');
  const late = sceneLayer('late');
  const present = sceneLayer('present');
  const { manager, modules } = await boundManager(present);
  const all = [...modules, late.module];
  // Registered with the first catalog, never enabled there.
  await manager.detachScene();
  manager.register(late.module);
  const enabled = manager.setEnabled('late', true, { origin: 'user' });
  await tick();
  assert.deepEqual(late.calls, [], 'no init against a missing scene');
  await bindCatalog(manager, second, catalog(...all));
  assert.equal(await enabled, true);
  assert.deepEqual(late.calls.slice(0, 2), ['init', ['attach', second]]);
});

test('a detach does not deadlock on an enable parked for the next scene', async () => {
  let finishAttach;
  const slow = sceneLayer('slow', {
    attach(viewer) {
      if (viewer !== secondViewer) return undefined;
      return new Promise((resolve) => {
        finishAttach = resolve;
      });
    },
  });
  const other = sceneLayer('other');
  const manager = new LayerLifecycle(firstViewer, { engine: engine('first') });
  const modules = [slow.module, other.module];
  await bindCatalog(manager, engine('first'), catalog(...modules));
  await manager.setEnabled('slow', true, { origin: 'user' });
  await manager.detachScene();
  void bindCatalog(manager, engine('second'), catalog(...modules));
  // Enabled while the second scene is still attaching: parked.
  const enabled = manager.setEnabled('other', true, { origin: 'user' });
  await tick();
  const detached = manager.detachScene();
  finishAttach();
  await detached;
  assert.equal(manager.viewer, null);
  // Destroying the parked layer ends its enable instead of hanging.
  assert.equal(await manager.destroyLayer('other'), true);
  assert.equal(await enabled, false);
});

test('the binding applies visibility and pick declarations and cancels a detached resume', async () => {
  const { createFakeEngine } = await import('../globe/testing/fakeEngine.js');
  const { sceneServicesFor } = await import('./sceneServices.js');
  const globe = createFakeEngine();
  const services = sceneServicesFor(globe);
  const calls = [];
  let restore;
  const viewRestored = new Promise((resolve) => { restore = resolve; });
  const layer = sceneLayer('declared').module;
  layer.show = (enabled) => calls.push(['show', enabled]);
  layer.picks = { owner: 'declared', predicate: (id) => id === 'marker' };
  layer.cameraOwner = { suspend() {}, resume: () => calls.push('resume') };
  const manager = new LayerLifecycle(null);
  manager.register(layer);
  const entry = manager.layers.get(layer.id);
  entry.initialized = true;
  await manager.bindCatalog(globe, catalog(layer), { viewRestored, services });
  assert.deepEqual(calls, [['show', false]]);
  assert.equal(services.picking.findPickOwner('marker'), null);
  entry.enabled = true;
  assert.equal(services.picking.findPickOwner('marker'), 'declared');
  await manager.detachScene();
  restore();
  await manager.resumeScene();
  assert.deepEqual(calls, [['show', false]]);
  assert.equal(services.picking.owners().includes('declared'), false);
  await manager.destroyAll();
  services.destroy();
  globe.destroy();
});
