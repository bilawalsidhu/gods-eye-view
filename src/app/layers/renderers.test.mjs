import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_PRIMITIVES,
  DRAWS_ITSELF,
  LAYER_MANIFEST,
  createLayerAvailability,
  layerAvailableOn,
  loadLayerRenderers,
  registerLayerRenderers,
  rendererFor,
} from './renderers.js';
import { APPLICATION_LAYER_DIRECTORY } from './directory.js';
import { ENGINE_KINDS, engineCapabilities } from '../../globe/contract.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';

test('the manifest lists every directory layer, in its order', () => {
  assert.deepEqual(
    Object.keys(LAYER_MANIFEST),
    APPLICATION_LAYER_DIRECTORY.map(({ id }) => id),
  );
  assert.ok(Object.isFrozen(LAYER_MANIFEST));
  for (const entry of Object.values(LAYER_MANIFEST))
    assert.ok(Object.isFrozen(entry));
});

test('the primitives a display needs are the contract primitives every engine has', () => {
  const capabilities = engineCapabilities(createFakeEngine());
  for (const name of CONTRACT_PRIMITIVES)
    assert.equal(capabilities[name], true, name);
  for (const [id, entry] of Object.entries(LAYER_MANIFEST))
    for (const name of entry.needs ?? [])
      assert.ok(CONTRACT_PRIMITIVES.includes(name), `${id} needs ${name}`);
});

test('every layer shows on both engines, as before', () => {
  for (const { id } of APPLICATION_LAYER_DIRECTORY)
    for (const kind of ENGINE_KINDS)
      assert.equal(layerAvailableOn(id, kind), true, `${id} on ${kind}`);
  assert.equal(layerAvailableOn('flights', 'vulkan'), false);
  assert.equal(layerAvailableOn('unknown', 'cesium'), false);
  assert.equal(layerAvailableOn('toString', 'cesium'), false);
  assert.equal(rendererFor('toString', createFakeEngine()), null);
});

test('the layers drawn through one display, and the ones that draw without one', () => {
  const kinds = (filter) =>
    Object.entries(LAYER_MANIFEST)
      .filter(([, entry]) => filter(entry))
      .map(([id]) => id);
  assert.deepEqual(
    kinds((entry) => entry.display),
    [
      'flights',
      'military',
      'local-adsb',
      'earthquakes',
      'air-quality',
      'fire-perimeters',
      'gnss-integrity',
      's2-ghostmaps',
      'drone-airspace',
      'alpr-cameras',
      'street-level',
      'satellites',
      'rocket-launches',
      'traffic',
      'cctv',
      'radio',
      'transit',
      'bikeshare',
      'directions',
      'recent-imagery',
      'osm-places',
      'ais-live-vessels',
      'military-installations',
      'military-awareness',
      'weather-cyclones',
      'local-datacenters',
      'local-dams',
      'telegeography-submarine-cables',
      'local-firms',
    ],
  );
  // Engine-specific options of a display: the Navara backends.
  assert.deepEqual(
    kinds((entry) => Object.keys(entry.backends ?? {}).length),
    ['cctv', 'military-awareness'],
  );
  assert.deepEqual(Object.keys(LAYER_MANIFEST.cctv.backends), ['navara']);
  // The layer that draws itself through the contract.
  assert.deepEqual(
    kinds((entry) => !entry.display && entry.needs),
    ['wildlife-sightings'],
  );
  // Without a display: drawn by the layer itself or by an engine-specific
  // renderer.
  const engines = Object.fromEntries(
    kinds((entry) => entry.engines).map((id) => [
      id,
      Object.fromEntries(
        Object.entries(LAYER_MANIFEST[id].engines).map(([kind, drawing]) => [
          kind,
          drawing === DRAWS_ITSELF ? 'itself' : 'renderer',
        ]),
      ),
    ]),
  );
  const navaraRenderer = { cesium: 'itself', navara: 'renderer' };
  assert.deepEqual(engines, {
    'bhote-koshi-2026': navaraRenderer,
    'bhote-koshi-locator': navaraRenderer,
    wind: navaraRenderer,
    'weather-radar': navaraRenderer,
    'weather-satellite': navaraRenderer,
    'weather-lightning': navaraRenderer,
    'sea-marks': { cesium: 'itself', navara: 'itself' },
    'ski-pistes': { cesium: 'itself', navara: 'itself' },
  });
});

test('a display or an engine-specific renderer answers only after its engine loaded them', () => {
  const engine = createFakeEngine({ kind: 'navara' });
  // Nothing is loaded yet: the later tests load them.
  assert.throws(
    () => rendererFor('weather-radar', engine),
    /weather-radar on navara: its renderer is not loaded/,
  );
  assert.throws(() => rendererFor('cctv', engine), /not loaded/);
  const cesium = createFakeEngine();
  assert.throws(
    () => rendererFor('flights', cesium),
    /flights on cesium: its renderer is not loaded/,
  );
  cesium.destroy();
  engine.destroy();
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
    cctv: ['cctv', 'createCctvDisplay'],
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
    'military-awareness': ['awareness', 'createAwarenessDisplay'],
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
  assert.deepEqual(
    Object.keys(displays).sort(),
    Object.keys(LAYER_MANIFEST)
      .filter((id) => LAYER_MANIFEST[id].display)
      .sort(),
  );
  const drawAtlas = async () => ({ canvas: {}, cells: {} });
  for (const [id, [directory, name]] of Object.entries(displays)) {
    const factory = (
      await import(`../../layers/${directory}/render/display.js`)
    )[name];
    assert.equal(await LAYER_MANIFEST[id].display(), factory, id);
    // Each display's own tests build it with its services; the aircraft
    // family needs none beyond an atlas.
    if (!['flights', 'military', 'local-adsb'].includes(id)) continue;
    for (const kind of ENGINE_KINDS) {
      await loadLayerRenderers(kind);
      const engine = createFakeEngine({ kind });
      const display = rendererFor(id, engine, { drawAtlas });
      assert.equal(display.engine, engine, `${id} on ${kind}`);
      display.destroy();
      engine.destroy();
    }
  }
});

test('a layer that draws itself has no renderer; an unknown engine none either', () => {
  const engine = createFakeEngine();
  for (const id of [
    'wildlife-sightings',
    'sea-marks',
    'ski-pistes',
    'wind',
    'weather-radar',
    'bhote-koshi-2026',
  ])
    assert.equal(rendererFor(id, engine), null, id);
  assert.equal(rendererFor('flights', null), null);
  assert.equal(rendererFor('flights', { kind: 'vulkan' }), null);
  engine.destroy();
});

test('a test engine of its own kind brings its renderers', () => {
  const made = [];
  registerLayerRenderers('renderers-test', {
    flights: (engine, options) => {
      made.push([engine.kind, options]);
      return { destroy() {} };
    },
  });
  const engine = { kind: 'renderers-test' };
  assert.ok(rendererFor('flights', engine, { tint: 1 }));
  assert.deepEqual(made, [['renderers-test', { tint: 1 }]]);
  assert.equal(rendererFor('satellites', engine), null);
  assert.throws(
    () => registerLayerRenderers('renderers-test', { flights: () => ({}) }),
    /already/,
    'one renderer per layer and engine',
  );
  assert.throws(
    () => registerLayerRenderers('renderers-test', { x: 42 }),
    TypeError,
  );
  for (const kind of ENGINE_KINDS)
    assert.throws(
      () => registerLayerRenderers(kind, { flights: () => ({}) }),
      /manifest/,
    );
});

test('the layer availability API: engine, isAvailable, available, unavailable', () => {
  const directory = [
    { id: 'flights', name: 'Live Flights' },
    { id: 'satellites', name: 'Satellites' },
  ];
  const availability = createLayerAvailability('navara', {
    manifest: { flights: LAYER_MANIFEST.flights },
    directory,
  });
  assert.equal(availability.engine, 'navara');
  assert.equal(availability.isAvailable('flights'), true);
  assert.equal(availability.isAvailable('satellites'), false);
  assert.equal(availability.isAvailable('unknown'), false);
  assert.equal(availability.isAvailable('toString'), false);
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
  // A layer without a display shows only on the engine kinds it lists.
  const cesiumOnly = { wind: { engines: { cesium: DRAWS_ITSELF } } };
  const wind = [{ id: 'wind', name: 'Wind' }];
  for (const [kind, shown] of [
    ['cesium', true],
    ['navara', false],
  ])
    assert.equal(
      createLayerAvailability(kind, {
        manifest: cesiumOnly,
        directory: wind,
      }).isAvailable('wind'),
      shown,
      kind,
    );
  for (const kind of ENGINE_KINDS) {
    const all = createLayerAvailability(kind);
    assert.equal(all.unavailable().length, 0, kind);
    assert.equal(all.available().length, APPLICATION_LAYER_DIRECTORY.length);
  }
  assert.throws(() => createLayerAvailability('vulkan'), TypeError);
});
