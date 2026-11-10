import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRendererCache } from './rendererCache.js';
import { createSceneHost } from '../app/sceneHost.js';

function installDocument(t) {
  const host = {
    prepend: (el) => {
      el.isConnected = true;
    },
  };
  const saved = globalThis.document;
  globalThis.document = {
    getElementById: () => host,
    createElement: () => ({
      remove() {
        this.isConnected = false;
      },
    }),
  };
  t.after(() => {
    globalThis.document = saved;
  });
}

/** A renderer build that counts its releases in `released.count`. */
function fakeBuild(released) {
  return ({ container, defer }) => {
    defer(() => {
      released.count += 1;
    });
    const canvas = new EventTarget();
    const context = {
      lost: false,
      isContextLost: () => context.lost,
      getExtension: (name) =>
        name === 'WEBGL_lose_context'
          ? {
              loseContext() {
                context.lost = true;
              },
            }
          : null,
    };
    canvas.getContext = (type) => (type === 'webgl2' ? context : null);
    return {
      context,
      suspend() {
        this.running = false;
      },
      resume() {
        this.running = true;
      },
      engine: createFakeEngine({ container, canvas }),
    };
  };
}

test('a parked renderer is reused, but a lost context is disposed before rebuilding', async (t) => {
  installDocument(t);
  const cache = createRendererCache();
  const released = { count: 0 };
  let release;
  const build = fakeBuild(released);
  const open = () =>
    cache.acquire('navara', build, (stop) => {
      release = stop;
    });
  const first = await open();
  cache.retain('navara');
  release();
  assert.equal(first.running, false);
  assert.equal(first.engine.host.container.isConnected, false);
  // A parked renderer whose canvas no longer hands out contexts is still
  // reused when its own context is alive.
  first.engine.host.canvas.getContext = () => {
    throw new Error('getContext called during a switch');
  };
  assert.equal(await open(), first);
  assert.equal(first.running, true);
  assert.equal(first.engine.host.container.isConnected, true);
  cache.retain('navara');
  release();
  // The WebGL context is already lost, but its DOM event has not fired.
  // The switch reads the context the globe was built with and never asks
  // the canvas again (a QA or driver failure of getContext must not decide).
  first.context.lost = true;
  first.engine.host.canvas.getContext = () => {
    throw new Error('getContext called during a switch');
  };
  const second = await open();
  assert.notEqual(second, first);
  assert.equal(released.count, 1);
  cache.retain('navara');
  release();
  second.resume = () => {
    throw new Error('resume failed');
  };
  await assert.rejects(open(), /resume failed/);
  assert.equal(second.engine.host.container.isConnected, false);
  assert.equal(released.count, 2);
  const eventLost = await open();
  cache.retain('navara');
  release();
  eventLost.engine.host.canvas.dispatchEvent(new Event('webglcontextlost'));
  const third = await open();
  assert.notEqual(third, eventLost);
  assert.equal(released.count, 3);
  third.suspend = () => {
    throw new Error('suspend failed');
  };
  cache.retain('navara');
  assert.throws(release, /suspend failed/);
  assert.equal(third.engine.host.container.isConnected, false);
  cache.clear();
  assert.equal(released.count, 4);
});

test('a parked renderer is released after a while, unless the page switches back first', async (t) => {
  installDocument(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  const cache = createRendererCache({
    parkedMs: 1000,
    onReleaseError: (error) => errors.push(error),
  });
  const released = { count: 0 };
  let release;
  const open = (build = fakeBuild(released)) =>
    cache.acquire('navara', build, (stop) => {
      release = stop;
    });
  const park = () => {
    cache.retain('navara');
    release();
  };

  const first = await open();
  park();
  t.mock.timers.tick(999);
  assert.equal(await open(), first, 'a switch back in time is warm');
  assert.equal(first.context.lost, false);
  park();
  // The timer of the earlier parking was cancelled: this one starts afresh.
  t.mock.timers.tick(999);
  assert.equal(released.count, 0);
  t.mock.timers.tick(1);
  assert.equal(released.count, 1, 'released once the delay runs out');
  assert.equal(first.context.lost, true, 'its GPU memory goes with it');
  const cold = await open();
  assert.notEqual(cold, first, 'a switch back after the release builds anew');

  // A release that fails is reported, and the entry is gone either way.
  const failingCache = createRendererCache({
    parkedMs: 1000,
    onReleaseError: (error) => errors.push(error),
  });
  let releaseBroken;
  const brokenBuild = (options) => {
    options.defer(() => {
      throw new Error('dispose failed');
    });
    return fakeBuild({ count: 0 })(options);
  };
  const openBroken = () =>
    failingCache.acquire('navara', brokenBuild, (stop) => {
      releaseBroken = stop;
    });
  const broken = await openBroken();
  failingCache.retain('navara');
  releaseBroken();
  t.mock.timers.tick(1000);
  assert.equal(errors.length, 1);
  assert.match(errors[0].errors[0].message, /dispose failed/);
  assert.notEqual(await openBroken(), broken);

  // clear() disposes what is parked and leaves no timer behind.
  park();
  const before = released.count;
  cache.clear();
  t.mock.timers.tick(1000);
  assert.equal(released.count, before + 1);
});

test('acquiring one kind of an engine releases the other parked kind of it first', async (t) => {
  installDocument(t);
  const cache = createRendererCache({
    engineOf: (kind) => (kind === 'cesium' ? 'cesium' : 'navara'),
  });
  const released = { count: 0 };
  const build = fakeBuild(released);
  let release;
  const open = (kind) =>
    cache.acquire(kind, build, (stop) => {
      release = stop;
    });
  const park = (kind) => {
    cache.retain(kind);
    release();
  };
  const navara = await open('navara');
  park('navara');
  const cesium = await open('cesium');
  park('cesium');
  let builtWhileParked = null;
  const hd = await cache.acquire(
    'navara-hd',
    (options) => {
      builtWhileParked = released.count;
      return build(options);
    },
    (stop) => {
      release = stop;
    },
  );
  assert.equal(builtWhileParked, 1, 'Navara went before Navara HD was built');
  assert.equal(navara.context.lost, true);
  park('navara-hd');
  assert.equal(await open('cesium'), cesium, 'Cesium stays parked, warm');
  park('cesium');
  assert.notEqual(await open('navara'), navara);
  assert.equal(hd.context.lost, true);
  cache.clear();
});

test('parked expiry during a host transition makes the queued return cold', async (t) => {
  installDocument(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = createSceneHost();
  const cache = createRendererCache({ parkedMs: 1000 });
  t.after(() => cache.clear());
  const released = { count: 0 };
  const releases = new Map();
  const build = fakeBuild(released);
  const open = (kind, builder = build) => cache.acquire(kind, builder, (stop) => {
    releases.set(kind, stop);
  });
  const first = await host.run(() => open('cesium'));
  let finishBuild;
  let entered;
  const building = new Promise((resolve) => { entered = resolve; });
  const away = host.run(async () => {
    cache.retain('cesium');
    releases.get('cesium')();
    return open('navara', async (options) => {
      entered();
      await new Promise((resolve) => { finishBuild = resolve; });
      return build(options);
    });
  });
  await building;
  const returning = host.run(async () => {
    cache.retain('navara');
    releases.get('navara')();
    return open('cesium');
  });
  t.mock.timers.tick(1000);
  assert.equal(released.count, 1);
  assert.equal(first.context.lost, true);
  finishBuild();
  await away;
  const next = await returning;
  assert.notEqual(next, first);
  assert.equal(next.context.lost, false);
  releases.get('cesium')();
  cache.clear();
  t.mock.timers.tick(1000);
  assert.equal(released.count, 3, 'each renderer is released once');
});
