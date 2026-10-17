import test from 'node:test';
import assert from 'node:assert/strict';
import { MapSourceController } from './controller.js';
import { createDefaultMapSources } from './defaultSources.js';

function event() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise(value = {}) {
      for (const fn of [...listeners]) fn(value);
    },
    get size() {
      return listeners.size;
    },
  };
}
function fixture(registry, options = {}) {
  const imagery = [],
    credits = new Set(),
    primitives = [],
    removed = [],
    changes = [];
  const viewer = {
    scene: {
      globe: { show: true },
      requestRender() {},
      frameState: {
        creditDisplay: {
          addStaticCredit(value) {
            credits.add(value);
          },
          removeStaticCredit(value) {
            credits.delete(value);
          },
        },
      },
      primitives: {
        add(value) {
          primitives.push(value);
        },
        remove(value) {
          primitives.splice(primitives.indexOf(value), 1);
          value.destroy?.();
        },
      },
    },
    imageryLayers: {
      add(value) {
        imagery.push(value);
      },
      remove(value, destroy) {
        imagery.splice(imagery.indexOf(value), 1);
        removed.push({ value, destroy });
      },
    },
  };
  const controller = new MapSourceController(viewer, {
    registry,
    createImageryLayer: (provider) => ({ provider }),
    onChange: (state) => changes.push(state),
    ...options,
  });
  return { viewer, controller, imagery, credits, primitives, removed, changes };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const descriptor = (id) => ({ id, label: id, kind: 'imagery' });
function publicFixture(options) {
  const tileset = { show: true };
  const registry = createDefaultMapSources({ googleTileset: tileset });
  const providers = new Map();
  for (const source of registry.sources) {
    if (!source.imagery) continue;
    const provider = { id: source.descriptor.id, errorEvent: event() };
    providers.set(source.descriptor.id, provider);
    source.imagery = async () => provider;
    source.terrain = {
      id: 'keyless',
      create: async () => ({ provider: { id: 'terrain' } }),
    };
  }
  return { ...fixture(registry, options), registry, providers, tileset };
}

test('an additional imagery source needs no controller branch and owns its cached resources', async () => {
  let reads = 0,
    destroys = 0,
    terrainReads = 0;
  const provider = {
    destroy() {
      destroys++;
    },
  };
  const terrain = {
    id: 'custom-floor',
    create: async () => {
      terrainReads++;
      return { provider: { id: 'terrain' } };
    },
  };
  const registry = {
    defaultId: 'custom',
    sources: [
      {
        descriptor: descriptor('custom'),
        imagery: async () => {
          reads++;
          return provider;
        },
        terrain,
      },
    ],
  };
  const env = fixture(registry);
  await env.controller.setStack('custom');
  await env.controller.setStack('custom');
  assert.equal(env.controller.getActiveId(), 'custom');
  assert.equal(env.viewer.terrainProvider.id, 'terrain');
  assert.equal(reads, 1);
  assert.equal(terrainReads, 1);
  assert.equal(env.imagery.length, 1);
  assert.equal(
    env.removed.length,
    0,
    'same provider keeps its loaded imagery layer',
  );
  env.controller.destroy();
  env.controller.destroy();
  await settle();
  assert.equal(env.imagery.length, 0);
  assert.equal(env.removed[0].destroy, true);
  assert.equal(destroys, 1);
});

test('repeated Esri shot handoffs retain imagery and keep tile fallback live', async () => {
  const env = publicFixture();
  await env.controller.setStack('esri-imagery');
  const layer = env.imagery[0];
  const generation = env.controller.getSwitchGeneration();
  const errors = env.providers.get('esri-imagery').errorEvent;
  for (let i = 0; i < 3; i++) await env.controller.setStack('esri-imagery');
  assert.equal(env.imagery[0], layer);
  assert.equal(env.removed.length, 0);
  assert.equal(errors.size, 1);
  assert.equal(env.controller.getSwitchGeneration(), generation + 3);
  errors.raise();
  errors.raise();
  await settle();
  assert.equal(env.controller.getActiveId(), 'osm');
  assert.equal(env.removed.length, 1);
  assert.equal(errors.size, 0);
  env.controller.destroy();
});

test('returning to the live provider supersedes a pending switch without rebuilding imagery', async () => {
  const env = publicFixture();
  await env.controller.setStack('esri-imagery');
  const layer = env.imagery[0];
  let resolve;
  env.registry.sources.find(
    (source) => source.descriptor.id === 'osm',
  ).imagery = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = env.controller.setStack('osm');
  await settle();
  await env.controller.setStack('esri-imagery');
  resolve(env.providers.get('osm'));
  await pending;
  assert.equal(env.controller.getActiveId(), 'esri-imagery');
  assert.equal(env.imagery[0], layer);
  assert.equal(env.removed.length, 0);
  await env.controller.setStack('photoreal');
  assert.equal(env.imagery.length, 0);
  assert.equal(env.tileset.show, true);
  await env.controller.setStack('esri-imagery');
  assert.notEqual(env.imagery[0], layer, 'a removed layer must be recreated');
  assert.equal(env.viewer.scene.globe.show, true);
  assert.equal(env.tileset.show, false);
  env.controller.destroy();
});

test('a destroyed controller aborts creation and disposes a late provider without touching the scene', async () => {
  let resolve,
    signal,
    destroyed = 0;
  const env = fixture({
    defaultId: 'slow',
    sources: [
      {
        descriptor: descriptor('slow'),
        imagery: (request) => {
          signal = request.signal;
          return new Promise((done) => {
            resolve = done;
          });
        },
      },
    ],
  });
  const loading = env.controller.setStack('slow');
  await settle();
  env.controller.destroy();
  assert.equal(signal.aborted, true);
  resolve({
    destroy() {
      destroyed++;
    },
  });
  await loading;
  await settle();
  assert.equal(destroyed, 1);
  assert.equal(env.imagery.length, 0);
  assert.deepEqual(
    env.changes.map((state) => state.status),
    ['switching'],
  );
});

test('slow terrain cannot overwrite a newer source and a 3D view never starts unused terrain', async () => {
  const env = publicFixture();
  let resolve,
    reads = 0;
  const osm = env.registry.sources.find(
    (source) => source.descriptor.id === 'osm',
  );
  osm.terrain = {
    id: 'slow-floor',
    create: () => {
      reads++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  await env.controller.setStack('photoreal');
  assert.equal(reads, 0);
  const loading = env.controller.setStack('osm');
  await settle();
  await env.controller.setStack('photoreal');
  resolve({ provider: { id: 'late-terrain' } });
  await loading;
  assert.equal(env.viewer.terrainProvider, undefined);
  assert.equal(env.viewer.scene.globe.show, false);
  assert.equal(env.tileset.show, true);
  assert.equal(env.controller.getActiveId(), 'photoreal');
  env.controller.destroy();
});

test('Esri construction fallback reports and attributes the source actually rendered', async () => {
  const env = publicFixture();
  env.registry.sources.find(
    (source) => source.descriptor.id === 'esri-imagery',
  ).imagery = async () => {
    throw new Error('unreachable');
  };
  await env.controller.setStack('esri-imagery');
  assert.equal(env.controller.getActiveId(), 'osm');
  assert.equal(
    env.controller.getState().lastError,
    'Esri Satellite is unavailable; using OSM',
  );
  assert.equal(env.imagery[0].provider, env.providers.get('osm'));
  assert.equal(env.credits.size, 0);
  env.controller.destroy();
});

test('one Esri tile failure stays put, two fall back, and stale errors cannot replace a selection', async () => {
  const env = publicFixture();
  await env.controller.setStack('esri-imagery');
  assert.equal(env.credits.size, 1);
  const errorEvent = env.providers.get('esri-imagery').errorEvent;
  errorEvent.raise();
  await settle();
  assert.equal(env.controller.getActiveId(), 'esri-imagery');
  errorEvent.raise();
  await settle();
  assert.equal(env.controller.getActiveId(), 'osm');
  assert.equal(env.credits.size, 0);
  assert.equal(
    env.controller.getState().lastError,
    'Esri Satellite tile requests failed; using OSM',
  );
  assert.equal(errorEvent.size, 0);
  await env.controller.setStack('photoreal');
  errorEvent.raise({ timesRetried: 9 });
  await settle();
  assert.equal(env.controller.getActiveId(), 'photoreal');
  env.controller.destroy();
});

test('tooltips and rejected selection share the registry reason, including retired map IDs', async () => {
  const errors = [],
    env = publicFixture();
  env.controller._onError = (message) => errors.push(message);
  const reason = env.controller
    .getStacks()
    .find((stack) => stack.id === 'bing-aerial').unavailableReason;
  await env.controller.setStack('bing-aerial');
  assert.deepEqual(errors, [reason]);
  assert.match(reason, /CESIUM_ION_TOKEN/);
  await env.controller.setStack('bing-road');
  assert.equal(env.controller.getActiveId(), 'photoreal');
  env.controller.destroy();
});

test('a factory-owned 3D tileset is released after late completion and supplied tilesets stay caller-owned', async () => {
  let resolve,
    destroyed = 0;
  const supplied = {
    show: true,
    destroy() {
      assert.fail('caller-owned tileset');
    },
  };
  const env = fixture({
    defaultId: 'three',
    sources: [
      {
        descriptor: { id: 'three' },
        createTileset: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
      { descriptor: { id: 'supplied' }, tileset: supplied },
    ],
  });
  const loading = env.controller.setStack('three');
  await settle();
  env.controller.destroy();
  resolve({
    destroy() {
      destroyed++;
    },
  });
  await loading;
  assert.equal(destroyed, 1);
  assert.equal(env.primitives.length, 0);
});

test('invalid source graphs fail before constructing or caching a provider', () => {
  const a = { descriptor: descriptor('a'), constructionFallback: { id: 'b' } };
  const b = { descriptor: descriptor('b'), constructionFallback: { id: 'a' } };
  assert.throws(() => fixture({ sources: [a, b] }), /fallback cycle/);
  assert.throws(() => fixture({ sources: [a, a] }), /unique/);
  assert.throws(() => fixture({ sources: [a] }), /Unknown map fallback/);
});

for (const reactivate of [false, true]) {
  test(`a superseded 3D load stays outside the scene and is released (reactivate: ${reactivate})`, async () => {
    let resolve,
      destroyed = 0,
      reads = 0;
    const tileset = {
      show: true,
      isDestroyed: () => destroyed > 0,
      destroy() {
        destroyed++;
      },
    };
    const supplied = { show: true };
    const env = fixture({
      defaultId: 'slow',
      sources: [
        {
          descriptor: { id: 'slow' },
          createTileset: () => {
            reads++;
            return new Promise((done) => {
              resolve = done;
            });
          },
        },
        { descriptor: { id: 'supplied' }, tileset: supplied },
      ],
    });
    const loading = env.controller.setStack('slow');
    await settle();
    await env.controller.setStack('supplied');
    resolve(tileset);
    await loading;
    assert.equal(env.primitives.length, 0);
    assert.equal(supplied.show, true);
    assert.equal(env.controller.getActiveId(), 'supplied');
    if (reactivate) {
      await env.controller.setStack('slow');
      await env.controller.setStack('slow');
      assert.deepEqual(env.primitives, [tileset]);
      assert.equal(reads, 1);
      assert.equal(tileset.show, true);
      assert.equal(supplied.show, false);
    }
    env.controller.destroy();
    await settle();
    assert.equal(env.primitives.length, 0);
    assert.equal(destroyed, 1);
  });
}

test('a failed recovery reports its error and leaves switching settled', async () => {
  const errors = [];
  const env = fixture(
    {
      defaultId: 'first',
      recoveryId: 'recovery',
      sources: [
        {
          descriptor: descriptor('first'),
          imagery: async () => {
            throw new Error('first offline');
          },
        },
        {
          descriptor: descriptor('recovery'),
          imagery: async () => {
            throw new Error('recovery offline');
          },
        },
      ],
    },
    { onError: (message) => errors.push(message) },
  );
  const result = await env.controller.setStack('first');
  assert.equal(result.status, 'ready');
  assert.equal(result.lastError, 'recovery offline');
  assert.deepEqual(errors, ['first offline', 'recovery offline']);
  assert.equal(env.changes.at(-1).status, 'error');
  assert.equal(env.imagery.length, 0);
  env.controller.destroy();
});

test('imagery host tileset follows supplied, owned and globe map sources', async () => {
  const supplied = { show: true };
  const owned = { show: false };
  const registry = {
    defaultId: 'supplied',
    sources: [
      { descriptor: descriptor('supplied'), tileset: supplied },
      { descriptor: descriptor('owned'), createTileset: async () => owned },
      { descriptor: descriptor('globe'), imagery: async () => ({}) },
    ],
  };
  const { controller } = fixture(registry);
  assert.equal(controller.getImageryHostTileset(), supplied);
  await controller.setStack('owned');
  assert.equal(controller.getImageryHostTileset(), owned);
  await controller.setStack('globe');
  assert.equal(controller.getImageryHostTileset(), null);
  await controller.setStack('supplied');
  assert.equal(controller.getImageryHostTileset(), supplied);
  controller.destroy();
  assert.equal(controller.getImageryHostTileset(), null);
});

function leaseFixture() {
  const env = publicFixture();
  const switches = [];
  const setStack = env.controller.setStack.bind(env.controller);
  env.controller.setStack = (id, options) => {
    switches.push(id);
    return setStack(id, options);
  };
  return { ...env, switches };
}

test('an imagery comparison lease rejects a second owner synchronously until released', async () => {
  const env = leaseFixture();
  const lease = env.controller.acquireImageryComparison({
    owner: 'nepal',
    switchPolicy: 'preserve',
  });
  assert.throws(
    () => env.controller.acquireImageryComparison({ owner: 'recent' }),
    /held by nepal/,
  );
  assert.deepEqual(await lease.ready, {
    status: 'ready',
    activeId: 'photoreal',
  });
  await lease.release();
  const next = env.controller.acquireImageryComparison({ owner: 'recent' });
  assert.deepEqual(await next.ready, {
    status: 'ready',
    activeId: 'photoreal',
  });
  await next.release();
  assert.deepEqual(env.switches, []);
  env.controller.destroy();
});

test("the 'esri' policy switches from any other stack and release restores it", async () => {
  for (const initial of ['photoreal', 'osm']) {
    const env = leaseFixture();
    if (initial !== env.controller.getActiveId())
      await env.controller.setStack(initial);
    env.switches.length = 0;
    const lease = env.controller.acquireImageryComparison({
      owner: 'nepal',
      switchPolicy: 'esri',
    });
    assert.deepEqual(await lease.ready, {
      status: 'ready',
      activeId: 'esri-imagery',
    });
    assert.equal(env.controller.getActiveId(), 'esri-imagery');
    await lease.release();
    assert.equal(env.controller.getActiveId(), initial);
    assert.deepEqual(env.switches, ['esri-imagery', initial]);
    env.controller.destroy();
  }
});

test("the 'esri-if-photoreal' policy leaves any 2D basemap alone", async () => {
  const photoreal = leaseFixture();
  const fromPhotoreal = photoreal.controller.acquireImageryComparison({
    owner: 'recent',
    switchPolicy: 'esri-if-photoreal',
  });
  assert.equal((await fromPhotoreal.ready).activeId, 'esri-imagery');
  await fromPhotoreal.release();
  assert.deepEqual(photoreal.switches, ['esri-imagery', 'photoreal']);
  photoreal.controller.destroy();

  const osm = leaseFixture();
  await osm.controller.setStack('osm');
  osm.switches.length = 0;
  const fromOsm = osm.controller.acquireImageryComparison({
    owner: 'recent',
    switchPolicy: 'esri-if-photoreal',
  });
  assert.deepEqual(await fromOsm.ready, { status: 'ready', activeId: 'osm' });
  await fromOsm.release();
  assert.equal(osm.controller.getActiveId(), 'osm');
  assert.deepEqual(osm.switches, []);
  osm.controller.destroy();
});

test("the 'preserve' policy never switches, whatever is active", async () => {
  for (const initial of ['photoreal', 'esri-imagery', 'osm']) {
    const env = leaseFixture();
    if (initial !== env.controller.getActiveId())
      await env.controller.setStack(initial);
    env.switches.length = 0;
    const lease = env.controller.acquireImageryComparison({
      owner: 'nepal',
    });
    assert.deepEqual(await lease.ready, { status: 'ready', activeId: initial });
    await lease.release();
    assert.equal(env.controller.getActiveId(), initial);
    assert.deepEqual(env.switches, []);
    env.controller.destroy();
  }
});

test('release keeps an operator choice made while the comparison was open', async () => {
  const env = leaseFixture();
  const lease = env.controller.acquireImageryComparison({
    owner: 'nepal',
    switchPolicy: 'esri',
  });
  await lease.ready;
  await env.controller.setStack('osm');
  await lease.release();
  assert.equal(env.controller.getActiveId(), 'osm');
  assert.deepEqual(env.switches, ['esri-imagery', 'osm']);
  env.controller.destroy();
});

test('release keeps a fallback that replaced the comparison stack', async () => {
  const env = leaseFixture();
  const lease = env.controller.acquireImageryComparison({
    owner: 'nepal',
    switchPolicy: 'esri',
  });
  await lease.ready;
  const errors = env.providers.get('esri-imagery').errorEvent;
  errors.raise();
  errors.raise();
  await settle();
  assert.equal(env.controller.getActiveId(), 'osm');
  await lease.release();
  assert.equal(env.controller.getActiveId(), 'osm');
  assert.deepEqual(env.switches, ['esri-imagery', 'osm']);
  env.controller.destroy();
});

test('release during acquisition lets no late activation survive', async () => {
  const env = leaseFixture();
  let resolve;
  env.registry.sources.find(
    (source) => source.descriptor.id === 'esri-imagery',
  ).imagery = () =>
    new Promise((done) => {
      resolve = done;
    });
  const lease = env.controller.acquireImageryComparison({
    owner: 'nepal',
    switchPolicy: 'esri',
  });
  await settle();
  const releasing = lease.release();
  resolve(env.providers.get('esri-imagery'));
  assert.deepEqual(await lease.ready, {
    status: 'superseded',
    activeId: 'photoreal',
  });
  await releasing;
  await settle();
  assert.equal(env.controller.getActiveId(), 'photoreal');
  assert.equal(env.viewer.scene.globe.show, false);
  assert.equal(env.imagery.length, 0);
  assert.equal(env.tileset.show, true);
  assert.deepEqual(env.switches, ['esri-imagery', 'photoreal']);
  env.controller.destroy();
});

test('release is idempotent and frees the lease for the next owner', async () => {
  const env = leaseFixture();
  const lease = env.controller.acquireImageryComparison({
    owner: 'nepal',
    switchPolicy: 'esri',
  });
  await lease.ready;
  const first = lease.release();
  assert.equal(lease.release(), first);
  await first;
  await lease.release();
  assert.deepEqual(env.switches, ['esri-imagery', 'photoreal']);
  const next = env.controller.acquireImageryComparison({
    owner: 'recent',
    switchPolicy: 'esri',
  });
  assert.equal((await next.ready).status, 'ready');
  await next.release();
  assert.deepEqual(env.switches, [
    'esri-imagery',
    'photoreal',
    'esri-imagery',
    'photoreal',
  ]);
  env.controller.destroy();
});

test('an unavailable comparison stack reports failure and release leaves the map alone', async () => {
  const env = leaseFixture();
  const errors = [];
  env.controller._onError = (message) => errors.push(message);
  const esri = env.controller._sources.get('esri-imagery');
  esri.available = false;
  esri.unavailableReason = 'Esri offline';
  const lease = env.controller.acquireImageryComparison({
    owner: 'nepal',
    switchPolicy: 'esri',
  });
  assert.deepEqual(await lease.ready, {
    status: 'failed',
    activeId: 'photoreal',
  });
  await lease.release();
  assert.deepEqual(env.switches, ['esri-imagery']);
  assert.deepEqual(errors, ['Esri offline']);
  assert.equal(env.controller.getActiveId(), 'photoreal');
  env.controller.destroy();
});

test('a lease stays owned until its restoration settles, so a rival cannot read the comparison stack as its own', async () => {
  const env = leaseFixture();
  const lease = env.controller.acquireImageryComparison({
    owner: 'recent',
    switchPolicy: 'esri-if-photoreal',
  });
  assert.equal((await lease.ready).activeId, 'esri-imagery');
  // Hold the restore switch open: the map is still on Esri while it runs.
  const setStack = env.controller.setStack;
  let finishRestore;
  env.controller.setStack = (id, options) =>
    new Promise((resolve) => {
      finishRestore = () => resolve(setStack(id, options));
    });
  const releasing = lease.release();
  assert.equal(typeof finishRestore, 'function', 'the restore was issued');
  assert.throws(
    () =>
      env.controller.acquireImageryComparison({
        owner: 'nepal',
        switchPolicy: 'esri',
      }),
    /held by recent/,
    'the pending restoration still owns the lease',
  );
  finishRestore();
  await releasing;
  assert.equal(env.controller.getActiveId(), 'photoreal');
  env.controller.setStack = setStack;
  const next = env.controller.acquireImageryComparison({
    owner: 'nepal',
    switchPolicy: 'esri',
  });
  assert.deepEqual(await next.ready, {
    status: 'ready',
    activeId: 'esri-imagery',
  });
  await next.release();
  assert.equal(env.controller.getActiveId(), 'photoreal');
  assert.deepEqual(env.switches, [
    'esri-imagery',
    'photoreal',
    'esri-imagery',
    'photoreal',
  ]);
  env.controller.destroy();
});

test('subscribe hears every settled activation — silent switches, fallbacks and recoveries — until unsubscribed or destroyed', async () => {
  const env = publicFixture();
  const heard = [];
  const off = env.controller.subscribe((state) =>
    heard.push([state.activeId, state.status]),
  );
  assert.equal(typeof off, 'function');
  assert.equal(typeof env.controller.subscribe(null), 'function');
  await env.controller.setStack('esri-imagery');
  assert.deepEqual(heard, [['esri-imagery', 'ready']]);
  // A silent switch mutes onChange but not the subscription.
  const changesBefore = env.changes.length;
  await env.controller.setStack('photoreal', { silent: true });
  assert.equal(env.changes.length, changesBefore, 'onChange stays silent');
  assert.deepEqual(heard.at(-1), ['photoreal', 'ready']);
  // A subscriber that throws does not stop the others.
  const noisy = env.controller.subscribe(() => {
    throw new Error('listener failed');
  });
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    await env.controller.setStack('esri-imagery');
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.deepEqual(heard.at(-1), ['esri-imagery', 'ready']);
  noisy();
  off();
  await env.controller.setStack('photoreal');
  assert.equal(heard.length, 3, 'unsubscribed listeners hear nothing');
  env.controller.destroy();

  // A failed activation that recovers still settles once, on the recovery.
  const recovering = fixture(
    {
      defaultId: 'first',
      recoveryId: 'recovery',
      sources: [
        {
          descriptor: descriptor('first'),
          imagery: async () => {
            throw new Error('first offline');
          },
        },
        { descriptor: descriptor('recovery'), imagery: async () => ({}) },
      ],
    },
    { onError: () => {} },
  );
  const recovered = [];
  recovering.controller.subscribe((state) => recovered.push(state.activeId));
  await recovering.controller.setStack('first');
  assert.deepEqual(recovered, ['recovery']);
  recovering.controller.destroy();
  await recovering.controller.setStack('first');
  assert.deepEqual(recovered, ['recovery'], 'a destroyed controller is mute');
});

test('each switch generation reports its origin: an outside setStack is manual, a fallback or recovery automatic', async () => {
  const env = publicFixture();
  const heard = [];
  env.controller.subscribe((state) =>
    heard.push([state.activeId, state.switchOrigin]),
  );
  await env.controller.setStack('esri-imagery');
  assert.equal(env.controller.getSwitchOrigin(), 'manual');
  const generation = env.controller.getSwitchGeneration();
  // Two tile failures: the controller falls back to OSM on its own.
  const errors = env.providers.get('esri-imagery').errorEvent;
  errors.raise();
  errors.raise();
  await settle();
  assert.equal(env.controller.getActiveId(), 'osm');
  assert.equal(env.controller.getSwitchGeneration(), generation + 1);
  assert.equal(env.controller.getSwitchOrigin(), 'automatic');
  assert.equal(env.controller.getState().switchOrigin, 'automatic');
  // A silent switch from outside is still the caller's choice.
  await env.controller.setStack('photoreal', { silent: true });
  assert.equal(env.controller.getSwitchOrigin(), 'manual');
  assert.deepEqual(heard, [
    ['esri-imagery', 'manual'],
    ['osm', 'automatic'],
    ['photoreal', 'manual'],
  ]);
  env.controller.destroy();

  // A failed activation that recovers settles as automatic.
  const recovering = fixture(
    {
      defaultId: 'first',
      recoveryId: 'recovery',
      sources: [
        {
          descriptor: descriptor('first'),
          imagery: async () => {
            throw new Error('first offline');
          },
        },
        { descriptor: descriptor('recovery'), imagery: async () => ({}) },
      ],
    },
    { onError: () => {} },
  );
  const recovered = [];
  recovering.controller.subscribe((state) =>
    recovered.push([state.activeId, state.switchOrigin]),
  );
  await recovering.controller.setStack('first');
  assert.equal(recovering.controller.getActiveId(), 'recovery');
  assert.equal(recovering.controller.getSwitchOrigin(), 'automatic');
  await recovering.controller.setStack('recovery');
  assert.equal(recovering.controller.getSwitchOrigin(), 'manual');
  assert.deepEqual(recovered, [
    ['recovery', 'automatic'],
    ['recovery', 'manual'],
  ]);
  recovering.controller.destroy();
});

function failingEsri(env) {
  const esri = { failing: true, attempts: 0, next: null };
  env.registry.sources.find(
    (source) => source.descriptor.id === 'esri-imagery',
  ).imagery = async () => {
    esri.attempts++;
    if (esri.next) await esri.next;
    if (esri.failing) throw new Error('Esri unreachable');
    return env.providers.get('esri-imagery');
  };
  return esri;
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

test('a failed Esri construction shows OSM at once, backs off while retries fail, and recovers in place', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = publicFixture();
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  assert.equal(env.controller.getActiveId(), 'osm');
  const osmLayer = env.imagery.at(-1);
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(esri.attempts, 2, 'one background retry');
  assert.equal(env.imagery.at(-1), osmLayer, 'a failed retry keeps the layer');
  await env.controller.setStack('osm');
  await env.controller.setStack('esri-imagery');
  assert.equal(esri.attempts, 2, 'a reselection does not retry at once');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(esri.attempts, 2, 'the second retry waits twice as long');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(esri.attempts, 3);
  esri.failing = false;
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(esri.attempts, 4);
  assert.equal(env.controller.getActiveId(), 'esri-imagery');
  assert.equal(env.controller.getSwitchOrigin(), 'automatic');
  assert.equal(env.controller.getState().lastError, null);
  assert.equal(env.imagery.at(-1).provider, env.providers.get('esri-imagery'));
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(esri.attempts, 4, 'the real provider ends the retries');
  env.controller.destroy();
});

test('retries of a fallback that keeps failing back off to a 10 minute cap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = publicFixture();
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  for (const delay of [30, 60, 120, 240, 480, 600, 600]) {
    t.mock.timers.tick(delay * 1000);
    await settle();
  }
  assert.equal(esri.attempts, 8);
  env.controller.destroy();
});

test('Esri is retried only while its fallback is shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = publicFixture();
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  await env.controller.setStack('osm');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(esri.attempts, 1, 'no retry while OSM was chosen');
  await env.controller.setStack('esri-imagery');
  assert.equal(esri.attempts, 1, 'the cached fallback shows at once');
  assert.equal(env.controller.getActiveId(), 'osm');
  esri.failing = false;
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(esri.attempts, 2);
  assert.equal(env.controller.getActiveId(), 'esri-imagery');
  env.controller.destroy();
});

test('an Esri recovery that lands mid-switch applies once the switch settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = publicFixture();
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  const retry = deferred();
  esri.next = retry.promise;
  esri.failing = false;
  t.mock.timers.tick(30_000);
  await settle();
  // The fallback activates OSM's terrain; make that switch slow.
  const slow = deferred();
  env.registry.sources.find(
    (source) => source.descriptor.id === 'osm',
  ).terrain = { id: 'slow', create: () => slow.promise };
  const switching = env.controller.setStack('esri-imagery');
  retry.resolve();
  await settle();
  assert.equal(env.controller.getActiveId(), 'osm', 'the switch is still open');
  slow.resolve({ provider: { id: 'slow' } });
  await switching;
  await settle();
  assert.equal(env.controller.getActiveId(), 'esri-imagery');
  assert.equal(env.imagery.at(-1).provider, env.providers.get('esri-imagery'));
  env.controller.destroy();
});

function terrainFixture(t, create) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let renders = 0;
  const env = publicFixture({ requestRender: () => renders++ });
  const installed = [];
  Object.defineProperty(env.viewer, 'terrainProvider', {
    get: () => installed.at(-1),
    set: (provider) => installed.push(provider),
  });
  const terrain = { id: 'keyless', calls: 0 };
  terrain.create = () => create(++terrain.calls);
  for (const source of env.registry.sources)
    if (source.imagery) source.terrain = terrain;
  return { env, installed, terrain, renders: () => renders };
}
const flatTerrain = (n) => ({ provider: { id: `flat-${n}` }, fallback: true });

test('flat fallback terrain stays installed while retries run, and real terrain replaces it live', async (t) => {
  const real = { id: 'real' };
  let working = false;
  const { env, installed, terrain, renders } = terrainFixture(t, async (n) =>
    working ? { provider: real } : flatTerrain(n),
  );
  await env.controller.setStack('esri-imagery');
  const [flat] = installed;
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(terrain.calls, 2, 'one background retry');
  await env.controller.setStack('osm');
  assert.deepEqual(installed, [flat], 'failed retries and switches keep it');
  working = true;
  const before = renders();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(terrain.calls, 3);
  assert.deepEqual(installed, [flat, real]);
  assert.equal(renders(), before + 1, 'the live swap requests a render');
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(terrain.calls, 3, 'the real terrain ends the retries');
  env.controller.destroy();
});

test('terrain is not retried or installed while a 3D tileset hides the globe', async (t) => {
  const real = { id: 'real' };
  let working = false;
  const { env, installed, terrain } = terrainFixture(t, async (n) =>
    working ? { provider: real } : flatTerrain(n),
  );
  await env.controller.setStack('esri-imagery');
  await env.controller.setStack('photoreal');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(terrain.calls, 1, 'no retry behind a hidden globe');
  await env.controller.setStack('esri-imagery');
  const hidden = deferred();
  terrain.create = async () => {
    terrain.calls++;
    await hidden.promise;
    return { provider: real };
  };
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(terrain.calls, 2, 'the globe activation re-arms the retry');
  await env.controller.setStack('photoreal');
  hidden.resolve();
  await settle();
  assert.equal(installed.length, 1, 'nothing is installed behind a tileset');
  await env.controller.setStack('osm');
  assert.equal(installed.at(-1), real, 'the next globe activation installs it');
  assert.equal(terrain.calls, 2);
  env.controller.destroy();
});

test('a switch that read the flat fallback installs the terrain a retry just cached', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Sweep the microtask distance between the retry landing and the switch.
  for (let hops = 0; hops < 12; hops++) {
    const real = { id: 'real' },
      gate = deferred();
    const keyless = {
      id: 'keyless',
      create: async () => {
        if (!keyless.retried) return flatTerrain(1);
        await gate.promise;
        return { provider: real };
      },
    };
    const other = { id: 'other', create: async () => ({ provider: {} }) };
    const source = (id, terrain) => ({
      descriptor: descriptor(id),
      imagery: async () => ({ id }),
      terrain,
    });
    const env = fixture({
      defaultId: 'a',
      sources: [source('a', keyless), source('c', other)],
    });
    const installed = [];
    Object.defineProperty(env.viewer, 'terrainProvider', {
      get: () => installed.at(-1),
      set: (provider) => installed.push(provider),
    });
    await env.controller.setStack('a');
    keyless.retried = true;
    t.mock.timers.tick(30_000);
    await settle();
    await env.controller.setStack('c');
    gate.resolve();
    for (let i = 0; i < hops; i++) await null;
    await env.controller.setStack('a');
    await settle();
    assert.equal(installed.at(-1), real, `hops ${hops}`);
    env.controller.destroy();
  }
});

test('destroy cancels a pending retry and releases one in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = publicFixture();
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  env.controller.destroy();
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(esri.attempts, 1, 'a pending retry is cancelled');

  const late = publicFixture();
  const lateEsri = failingEsri(late);
  await late.controller.setStack('esri-imagery');
  const retry = deferred();
  lateEsri.next = retry.promise;
  lateEsri.failing = false;
  let destroyed = 0;
  late.providers.get('esri-imagery').destroy = () => destroyed++;
  t.mock.timers.tick(30_000);
  await settle();
  late.controller.destroy();
  retry.resolve();
  await settle();
  assert.equal(destroyed, 1, 'a late provider is released');
  assert.equal(late.imagery.length, 0);
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(lateEsri.attempts, 2);
});

test('retries stay single-flight when an activation re-shows the fallback mid-retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = publicFixture();
  const created = [],
    pending = [];
  let attempts = 0;
  env.registry.sources.find(
    (source) => source.descriptor.id === 'esri-imagery',
  ).imagery = async () => {
    if (++attempts === 1) throw new Error('Esri unreachable');
    const gate = deferred();
    pending.push(gate);
    await gate.promise;
    const provider = { id: `esri-${attempts}`, errorEvent: event() };
    provider.destroy = () => (provider.destroyed = true);
    created.push(provider);
    return provider;
  };
  await env.controller.setStack('esri-imagery');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(attempts, 2, 'retry #1 is in flight');
  await env.controller.setStack('osm');
  await env.controller.setStack('esri-imagery');
  assert.equal(env.controller.getActiveId(), 'osm', 'the fallback is shown');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(attempts, 2, 'no second retry while one is in flight');
  for (const gate of pending.reverse()) {
    gate.resolve();
    await settle();
  }
  const shown = env.imagery.at(-1).provider;
  assert.equal(env.controller.getActiveId(), 'esri-imagery');
  await env.controller.setStack('osm');
  await env.controller.setStack('esri-imagery');
  assert.equal(env.imagery.at(-1).provider, shown, 'the cached one is shown');
  env.controller.destroy();
  await settle();
  assert.ok(created.length > 0);
  for (const provider of created)
    assert.equal(provider.destroyed, true, `${provider.id} is disposed`);
});

test('a stalled terrain retry does not hold back recovered imagery', async (t) => {
  const stalled = deferred();
  const { env, terrain } = terrainFixture(t, async (n) => {
    if (n > 1) await stalled.promise;
    return flatTerrain(n);
  });
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  assert.equal(env.controller.getActiveId(), 'osm');
  esri.failing = false;
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(terrain.calls, 2, 'the terrain retry is in flight');
  assert.equal(env.controller.getActiveId(), 'esri-imagery');
  assert.equal(env.imagery.at(-1).provider, env.providers.get('esri-imagery'));
  stalled.resolve();
  await settle();
  env.controller.destroy();
});

test('a stalled imagery retry does not hold back recovered terrain', async (t) => {
  const real = { id: 'real' };
  const { env, installed } = terrainFixture(t, async (n) =>
    n > 1 ? { provider: real } : flatTerrain(n),
  );
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  const stalled = deferred();
  esri.next = stalled.promise;
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(esri.attempts, 2, 'the imagery retry is in flight');
  assert.equal(installed.at(-1), real, 'real terrain is installed');
  stalled.resolve();
  await settle();
  env.controller.destroy();
});

test('a retry attempt that never settles is abandoned at its deadline and released if it lands late', async (t) => {
  const hung = deferred();
  const late = { id: 'late', destroy: () => (late.destroyed = true) };
  const { env, installed, terrain } = terrainFixture(t, async (n) => {
    if (n === 2) await hung.promise;
    return n === 2 ? { provider: late } : flatTerrain(n);
  });
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(esri.attempts, 2, 'imagery failed');
  assert.equal(terrain.calls, 2, 'terrain hangs');
  t.mock.timers.tick(60_000); // The hung attempt's deadline.
  await settle();
  t.mock.timers.tick(60_000); // The doubled backoff.
  await settle();
  assert.equal(esri.attempts, 3, 'imagery is retried again');
  assert.equal(terrain.calls, 3, 'terrain is retried again');
  hung.resolve();
  await settle();
  assert.equal(late.destroyed, true, 'the late provider is released');
  assert.ok(!installed.includes(late), 'and never installed');
  env.controller.destroy();
});

test('a failed retry after a mid-retry re-show re-arms once, after the doubled delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = publicFixture();
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  const gate = deferred();
  esri.next = gate.promise;
  t.mock.timers.tick(30_000);
  await settle();
  await env.controller.setStack('osm');
  await env.controller.setStack('esri-imagery');
  gate.resolve();
  await settle();
  assert.equal(esri.attempts, 2);
  t.mock.timers.tick(59_999);
  await settle();
  assert.equal(esri.attempts, 2, 'not before the doubled delay');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(esri.attempts, 3, 'one retry after it');
  t.mock.timers.tick(119_999);
  await settle();
  assert.equal(esri.attempts, 3, 'no second timer was armed');
  env.controller.destroy();
});

test('destroy releases recovered imagery and terrain that lands afterwards', async (t) => {
  const stalled = deferred();
  const real = { id: 'real', destroy: () => (real.destroyed = true) };
  const { env, installed } = terrainFixture(t, async (n) => {
    if (n === 1) return flatTerrain(n);
    await stalled.promise;
    return { provider: real };
  });
  const esri = failingEsri(env);
  const imagery = env.providers.get('esri-imagery');
  imagery.destroy = () => (imagery.destroyed = true);
  await env.controller.setStack('esri-imagery');
  esri.failing = false;
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(env.imagery.at(-1).provider, imagery, 'imagery has landed');
  env.controller.destroy();
  stalled.resolve();
  await settle();
  assert.equal(imagery.destroyed, true);
  assert.equal(real.destroyed, true);
  assert.ok(!installed.includes(real));
});

function liveTimers(t) {
  const live = new Set();
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = set(
      (...values) => {
        live.delete(id);
        fn(...values);
      },
      ms,
      ...args,
    );
    live.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    live.delete(id);
    clear(id);
  };
  t.after(() =>
    Object.assign(globalThis, { setTimeout: set, clearTimeout: clear }),
  );
  return live;
}

test('destroy during a hung retry attempt clears its deadline at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const live = liveTimers(t);
  const env = publicFixture();
  const esri = failingEsri(env);
  await env.controller.setStack('esri-imagery');
  esri.next = new Promise(() => {});
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(esri.attempts, 2, 'the attempt hangs');
  assert.equal(live.size, 1, 'only its deadline is armed');
  env.controller.destroy();
  assert.equal(live.size, 0, 'destroy clears the deadline');
  assert.equal(env.controller._retrying, false);
  await settle();
  assert.equal(live.size, 0, 'and nothing re-arms');
});

function destroyableFlat(n) {
  const provider = { id: `flat-${n}` };
  provider.destroy = () => (provider.destroyed = true);
  return { provider, fallback: true };
}

test('terrain recovered on screen releases the fallback it replaced', async (t) => {
  const real = { id: 'real' };
  let flat;
  const { env, installed } = terrainFixture(t, async (n) =>
    n === 1 ? (flat = destroyableFlat(n)) : { provider: real },
  );
  await env.controller.setStack('esri-imagery');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(installed.at(-1), real);
  assert.equal(flat.provider.destroyed, true);
  env.controller.destroy();
});

test('terrain recovered behind a tileset releases the fallback once a globe replaces it', async (t) => {
  const real = { id: 'real' };
  const gate = deferred();
  let flat;
  const { env, installed } = terrainFixture(t, async (n) => {
    if (n === 1) return (flat = destroyableFlat(n));
    await gate.promise;
    return { provider: real };
  });
  await env.controller.setStack('esri-imagery');
  t.mock.timers.tick(30_000);
  await settle();
  await env.controller.setStack('photoreal');
  gate.resolve();
  await settle();
  assert.equal(installed.at(-1), flat.provider);
  assert.ok(!flat.provider.destroyed, 'still installed behind the tileset');
  await env.controller.setStack('osm');
  assert.equal(installed.at(-1), real);
  assert.equal(flat.provider.destroyed, true);
  env.controller.destroy();
});

test('a hung imagery attempt that lands after its deadline is released, never cached or shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = publicFixture();
  const hung = deferred();
  const late = { id: 'late', errorEvent: event() };
  const good = { id: 'good', errorEvent: event() };
  for (const provider of [late, good])
    provider.destroy = () => (provider.destroyed = true);
  let attempts = 0;
  env.registry.sources.find(
    (source) => source.descriptor.id === 'esri-imagery',
  ).imagery = async () => {
    if (++attempts === 1) throw new Error('Esri unreachable');
    if (attempts === 2) {
      await hung.promise;
      return late;
    }
    return good;
  };
  await env.controller.setStack('esri-imagery');
  t.mock.timers.tick(30_000);
  await settle();
  t.mock.timers.tick(60_000); // The deadline.
  await settle();
  hung.resolve();
  await settle();
  assert.equal(late.destroyed, true, 'the late provider is released');
  assert.equal(env.controller.getActiveId(), 'osm', 'and not shown');
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(attempts, 3);
  assert.equal(env.imagery.at(-1).provider, good, 'the next retry installs');
  await env.controller.setStack('osm');
  await env.controller.setStack('esri-imagery');
  assert.equal(env.imagery.at(-1).provider, good, 'only its own is cached');
  env.controller.destroy();
  await settle();
  assert.equal(good.destroyed, true);
});
