import test from 'node:test';
import assert from 'node:assert/strict';
import { MapSourceController } from './controller.js';
import { createDefaultMapSources } from './defaultSources.js';
import { MAP_STACKS } from './catalog.js';
import { SENTINEL2_LAYER_OPTIONS } from './imagery.js';

const LOCKED_REASON =
  'Needs SENTINEL_HUB_CLIENT_ID + SENTINEL_HUB_CLIENT_SECRET — add it in Provider Settings';
const sentinel = (registry) =>
  registry.sources.find((s) => s.descriptor.id === 'sentinel2-latest');

test('without a Sentinel Hub key the stack is listed, locked, and changes nothing else', () => {
  const keyless = createDefaultMapSources();
  const source = sentinel(keyless);
  assert.equal(
    MAP_STACKS.find((s) => s.id === 'sentinel2-latest').label,
    'Sentinel-2 Latest',
  );
  assert.equal(source.available, false);
  assert.equal(source.unavailableReason, LOCKED_REASON);
  // Same defaults and same availability for every other stack as before.
  assert.equal(keyless.defaultId, 'esri-imagery');
  assert.equal(
    createDefaultMapSources({ googleTileset: {} }).defaultId,
    'photoreal',
  );
  const others = (registry) =>
    registry.sources
      .filter((s) => s.descriptor.id !== 'sentinel2-latest')
      .map((s) => [s.descriptor.id, s.available]);
  assert.deepEqual(
    others(keyless),
    others(createDefaultMapSources({ sentinelHubConfigured: true })),
  );
  // Only an explicit true unlocks it — a truthy string from a bad payload does not.
  assert.equal(
    sentinel(createDefaultMapSources({ sentinelHubConfigured: 'true' }))
      .available,
    false,
  );
});

test('a locked Sentinel-2 stack refuses selection without touching the map', async () => {
  const errors = [];
  const imagery = [];
  const viewer = {
    scene: { globe: { show: true }, requestRender() {} },
    imageryLayers: { add: (l) => imagery.push(l), remove() {} },
  };
  const controller = new MapSourceController(viewer, {
    registry: createDefaultMapSources(),
    createImageryLayer: (provider) => ({ provider }),
    onError: (message) => errors.push(message),
  });
  const state = await controller.setStack('sentinel2-latest');
  assert.equal(state.activeId, 'esri-imagery');
  assert.deepEqual(errors, [LOCKED_REASON]);
  assert.equal(imagery.length, 0);
  assert.equal(
    state.stacks.find((s) => s.id === 'sentinel2-latest').unavailableReason,
    LOCKED_REASON,
  );
});

test('a configured stack drapes over an Esri underlay and falls back to Esri', () => {
  const source = sentinel(
    createDefaultMapSources({ sentinelHubConfigured: true }),
  );
  assert.equal(source.available, true);
  assert.deepEqual(source.underlay, { id: 'esri-imagery' });
  assert.equal(source.layerOptions, SENTINEL2_LAYER_OPTIONS);
  assert.deepEqual(SENTINEL2_LAYER_OPTIONS, {
    minimumTerrainLevel: 7,
    maximumTerrainLevel: 14,
  });
  assert.equal(source.tileFailureFallback.id, 'esri-imagery');
  assert.match(
    source.credit,
    /Contains modified Copernicus Sentinel data \d{4}/,
  );
});

function layeredFixture() {
  const layers = [];
  const removed = [];
  const viewer = {
    scene: { globe: { show: true }, requestRender() {} },
    imageryLayers: {
      add(layer, index = layers.length) {
        layers.splice(index, 0, layer);
      },
      remove(layer, destroy) {
        layers.splice(layers.indexOf(layer), 1);
        removed.push({ layer, destroy });
      },
    },
  };
  const registry = createDefaultMapSources({ sentinelHubConfigured: true });
  const providers = new Map();
  for (const source of registry.sources) {
    if (!source.imagery) continue;
    const provider = { id: source.descriptor.id };
    providers.set(source.descriptor.id, provider);
    source.imagery = async () => provider;
    source.terrain = {
      id: 'keyless',
      create: async () => ({ provider: { id: 'terrain' } }),
    };
  }
  const controller = new MapSourceController(viewer, {
    registry,
    createImageryLayer: (provider, options) => ({ provider, options }),
  });
  return { controller, layers, removed, providers };
}

test('the controller stacks Sentinel-2 above the Esri underlay and removes both on leave', async () => {
  const env = layeredFixture();
  await env.controller.setStack('sentinel2-latest');
  assert.equal(env.controller.getActiveId(), 'sentinel2-latest');
  assert.deepEqual(
    env.layers.map((l) => l.provider.id),
    ['esri-imagery', 'sentinel2-latest'],
  );
  assert.equal(env.layers[1].options, SENTINEL2_LAYER_OPTIONS);
  assert.equal(env.layers[0].options, undefined);

  // Re-applying the stack keeps both loaded layers.
  await env.controller.setStack('sentinel2-latest');
  assert.equal(env.removed.length, 0);

  await env.controller.setStack('osm');
  assert.deepEqual(
    env.layers.map((l) => l.provider.id),
    ['osm'],
  );
  assert.ok(env.removed.every((entry) => entry.destroy === true));

  await env.controller.setStack('esri-imagery');
  assert.deepEqual(
    env.layers.map((l) => l.provider.id),
    ['esri-imagery'],
    'a plain stack never gains an underlay',
  );
});

test('an underlay that fails to build is skipped, never fatal', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const env = layeredFixture();
  const registry = env.controller._registry;
  for (const source of registry.sources)
    if (['esri-imagery', 'osm'].includes(source.descriptor.id))
      source.imagery = async () => {
        throw new Error('esri down');
      };
  await env.controller.setStack('sentinel2-latest');
  assert.equal(env.controller.getActiveId(), 'sentinel2-latest');
  assert.deepEqual(
    env.layers.map((l) => l.provider.id),
    ['sentinel2-latest'],
  );
});
