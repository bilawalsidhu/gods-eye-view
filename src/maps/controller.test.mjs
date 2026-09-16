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
function publicFixture() {
  const tileset = { show: true, imageryLayers: { id: 'drape' } };
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
  return { ...fixture(registry), registry, providers, tileset };
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

test('the controller says which imagery collection is being rendered', async () => {
  // A photoreal stack hides the globe, so imagery added to the globe's
  // collection draws nothing. This controller owns both halves of that switch,
  // so it answers the question rather than leaving callers to read scene state
  // and guess.
  const env = publicFixture();
  await env.controller.setStack('esri-imagery');
  assert.deepEqual(env.controller.getImageryTarget(), {
    regime: 'globe',
    imageryLayers: env.viewer.imageryLayers,
  });

  await env.controller.setStack('photoreal');
  assert.deepEqual(env.controller.getImageryTarget(), {
    regime: 'tileset',
    imageryLayers: env.tileset.imageryLayers,
  });

  await env.controller.setStack('osm');
  assert.equal(env.controller.getImageryTarget().regime, 'globe');

  // Teardown hands back the globe rather than a destroyed tileset's collection.
  await env.controller.setStack('photoreal');
  env.controller.destroy();
  assert.deepEqual(env.controller.getImageryTarget(), {
    regime: 'globe',
    imageryLayers: env.viewer.imageryLayers,
  });
});

test('the boot activation resolves a target even though it emits no event', async () => {
  // Startup calls setStack with { silent: true }; a target derived from the
  // change event would still be unset at first draw.
  const env = publicFixture();
  await env.controller.setStack('photoreal', { silent: true });
  assert.equal(
    env.changes.length,
    0,
    'the silent activation must emit nothing',
  );
  assert.equal(env.controller.getImageryTarget().regime, 'tileset');
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
