import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CESIUM_BUILTIN,
  CESIUM_LAYER_RENDERERS,
  rendererFor,
  createLayerAvailability,
  createRendererRegistry,
  layerAvailableOn,
} from './renderers.js';
import { APPLICATION_LAYER_DIRECTORY } from './directory.js';

test('a registry knows which engine renders which layer', () => {
  const registry = createRendererRegistry();
  const made = [];
  registry.register('navara', {
    flights: (engine, options) => {
      made.push([engine.kind, options]);
      return { destroy() {} };
    },
  });
  registry.register('cesium', {
    flights: CESIUM_BUILTIN,
    satellites: CESIUM_BUILTIN,
  });
  assert.equal(registry.layerAvailableOn('flights', 'navara'), true);
  assert.equal(registry.layerAvailableOn('satellites', 'navara'), false);
  assert.equal(registry.layerAvailableOn('satellites', 'cesium'), true);
  assert.equal(registry.layerAvailableOn('flights', 'other'), false);
  const renderer = registry.rendererFor(
    'flights',
    { kind: 'navara' },
    { tint: 1 },
  );
  assert.ok(renderer);
  assert.deepEqual(made, [['navara', { tint: 1 }]]);
  // A Cesium layer that still renders itself has no separate renderer.
  assert.equal(registry.rendererFor('flights', { kind: 'cesium' }), null);
  assert.equal(registry.rendererFor('satellites', { kind: 'navara' }), null);
  assert.deepEqual(registry.availableIds('cesium').sort(), [
    'flights',
    'satellites',
  ]);
  assert.throws(() => registry.register('navara', { x: 42 }), TypeError);
  assert.throws(
    () => registry.register('navara', { flights: () => ({}) }),
    /already/,
    'one renderer per layer and engine',
  );
});

test('the default registry: every layer on Cesium, none yet on Navara', () => {
  for (const { id } of APPLICATION_LAYER_DIRECTORY) {
    assert.equal(layerAvailableOn(id, 'cesium'), true, id);
    assert.equal(layerAvailableOn(id, 'navara'), false, id);
  }
});

test('the aircraft, vessels, satellites, launches and earthquakes have extracted Cesium renderers', () => {
  assert.deepEqual(Object.keys(CESIUM_LAYER_RENDERERS), [
    'earthquakes',
    'air-quality',
    'local-firms',
    'rocket-launches',
    'satellites',
    'flights',
    'military',
    'local-adsb',
    'ais-live-vessels',
  ]);
  const vessels = rendererFor(
    'ais-live-vessels',
    { kind: 'cesium' },
    {
      viewer: { scene: {}, camera: {} },
    },
  );
  assert.equal(vessels.kind, 'cesium');
  const viewer = { scene: {}, camera: {} };
  const renderer = rendererFor('flights', { kind: 'cesium' }, { viewer });
  assert.equal(renderer.kind, 'cesium');
  assert.equal(renderer.viewer, viewer);
  const military = rendererFor('military', { kind: 'cesium' }, { viewer });
  assert.equal(military.kind, 'cesium');
  assert.equal(military.viewer, viewer);
  assert.equal(rendererFor('satellites', { kind: 'cesium' }).kind, 'cesium');
});

test('the layer availability API: engine, isAvailable, available, unavailable', () => {
  const registry = createRendererRegistry();
  registry.register('navara', { flights: () => ({}) });
  const directory = [
    { id: 'flights', name: 'Live Flights' },
    { id: 'satellites', name: 'Satellites' },
  ];
  const availability = createLayerAvailability('navara', {
    registry,
    directory,
  });
  assert.equal(availability.engine, 'navara');
  assert.equal(availability.isAvailable('flights'), true);
  assert.equal(availability.isAvailable('satellites'), false);
  assert.equal(availability.isAvailable('unknown'), false);
  assert.deepEqual(availability.available(), [
    { id: 'flights', name: 'Live Flights' },
  ]);
  assert.deepEqual(availability.unavailable(), [
    { id: 'satellites', name: 'Satellites' },
  ]);
  // Fresh copies: a caller cannot change the answer.
  availability.unavailable().push({ id: 'x', name: 'x' });
  assert.equal(availability.unavailable().length, 1);
  assert.ok(Object.isFrozen(availability));
  const cesium = createLayerAvailability('cesium');
  assert.equal(cesium.unavailable().length, 0);
  assert.equal(cesium.available().length, APPLICATION_LAYER_DIRECTORY.length);
  assert.throws(() => createLayerAvailability('vulkan'), TypeError);
});
