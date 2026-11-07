import test from 'node:test';
import { readFileSync } from 'node:fs';
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
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';

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

test('the layers with extracted renderers', () => {
  assert.deepEqual(Object.keys(CESIUM_LAYER_RENDERERS), [
    'earthquakes',
    'air-quality',
    'gnss-integrity',
    'fire-perimeters',
    'drone-airspace',
    'osm-places',
    'alpr-cameras',
    'bikeshare',
    'radio',
    'transit',
    'local-firms',
    's2-ghostmaps',
    'weather-cyclones',
    'telegeography-submarine-cables',
    'local-datacenters',
    'local-dams',
    'rocket-launches',
    'satellites',
    'flights',
    'military',
    'local-adsb',
    'ais-live-vessels',
    'cctv',
    'military-installations',
    'military-awareness',
    'street-level',
    'traffic',
    'directions',
    'recent-imagery',
  ]);
});

test('the layers drawn through one display get the same factory on every engine', async () => {
  const displays = {
    flights: ['flights', 'createFlightsDisplay'],
    military: ['military', 'createMilitaryDisplay'],
    'local-adsb': ['localAdsb', 'createLocalAdsbDisplay'],
    'ais-live-vessels': ['vessels', 'createVesselsDisplay'],
    satellites: ['satellites', 'createSatellitesDisplay'],
    'rocket-launches': ['launches', 'createLaunchesDisplay'],
    'osm-places': ['osmPlaces', 'createOsmPlacesDisplay'],
    'alpr-cameras': ['alpr', 'createAlprDisplay'],
    bikeshare: ['bikeshare', 'createBikeshareDisplay'],
    radio: ['radio', 'createRadioDisplay'],
    transit: ['transit', 'createTransitDisplay'],
    earthquakes: ['earthquakes', 'createEarthquakesDisplay'],
    'air-quality': ['airQuality', 'createAirQualityDisplay'],
    'gnss-integrity': ['gnss', 'createGnssDisplay'],
    'fire-perimeters': ['perimeters', 'createPerimetersDisplay'],
    'drone-airspace': ['droneAirspace', 'createDroneAirspaceDisplay'],
    's2-ghostmaps': ['ghostMaps', 'createGhostMapsDisplay'],
    'weather-cyclones': ['cyclones', 'createCyclonesDisplay'],
    'local-datacenters': ['infrastructure', 'createInfrastructureDisplay'],
    'local-dams': ['infrastructure', 'createInfrastructureDisplay'],
    'military-installations': ['installations', 'createInstallationsDisplay'],
    'street-level': ['streetLevel', 'createStreetLevelDisplay'],
    traffic: ['traffic', 'createTrafficDisplay'],
    directions: ['directions', 'createDirectionsDisplay'],
    'local-firms': ['firms', 'createFirmsDisplay'],
    'recent-imagery': ['recentImagery', 'createRecentImageryDisplay'],
    'telegeography-submarine-cables': [
      'submarineCables',
      'createCablesDisplay',
    ],
  };
  // The Navara mode registers the same modules' factories.
  const navaraMode = readFileSync(
    new URL('../navaraMode.js', import.meta.url),
    'utf8',
  );
  const drawAtlas = async () => ({ canvas: {}, cells: {} });
  for (const [id, [directory, name]] of Object.entries(displays)) {
    const factory = (
      await import(`../../layers/${directory}/render/display.js`)
    )[name];
    assert.equal(CESIUM_LAYER_RENDERERS[id], factory, id);
    assert.match(
      navaraMode,
      new RegExp(
        `'?${id}'?: async \\(\\) =>\\s*\\(await import\\('[^']+/render/display\\.js'\\)\\)\\s*\\.${name}\\b`,
      ),
      id,
    );
    // Each display's own tests build it with its services; the aircraft
    // family needs none beyond an atlas.
    if (!['flights', 'military', 'local-adsb'].includes(id)) continue;
    for (const kind of ['cesium', 'navara']) {
      const engine = createFakeEngine({ kind });
      const display = factory(engine, { drawAtlas });
      assert.equal(display.engine, engine, `${id} on ${kind}`);
      display.destroy();
      engine.destroy();
    }
  }
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
