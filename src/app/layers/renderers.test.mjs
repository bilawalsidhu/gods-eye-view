import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_MANIFEST,
  loadLayerRenderers,
  rendererFor,
} from './renderers.js';
import { APPLICATION_LAYER_DIRECTORY } from './directory.js';
import { ENGINE_KINDS } from '../../globe/contract.js';
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

test('the layers drawn through one display, and the ones that draw without one', () => {
  const kinds = (filter) =>
    Object.entries(LAYER_MANIFEST)
      .filter(([, entry]) => filter(entry))
      .map(([id]) => id);
  assert.deepEqual(
    kinds((entry) => entry.display),
    [
      'bhote-koshi-2026',
      'bhote-koshi-locator',
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
      'wind',
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
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
    ['wind', 'weather-radar', 'weather-satellite', 'weather-lightning'],
  );
  assert.deepEqual(Object.keys(LAYER_MANIFEST.cctv.backends), []);
  assert.deepEqual(
    kinds((entry) => !entry.display),
    ['shipwrecks', 'news', 'wildlife-sightings', 'sea-marks', 'ski-pistes'],
  );
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
    'bhote-koshi-2026': ['bhoteKoshi', 'createBhoteKoshiDisplay'],
    'bhote-koshi-locator': ['bhoteKoshi', 'createBhoteKoshiLocatorDisplay'],
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
    wind: ['wind', 'createWindDisplay'],
    'weather-radar': ['weather', 'createWeatherDisplay'],
    'weather-satellite': ['weather', 'createWeatherDisplay'],
    'weather-lightning': ['weather', 'createWeatherDisplay'],
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
  for (const id of ['wildlife-sightings', 'sea-marks', 'ski-pistes'])
    assert.equal(rendererFor(id, engine), null, id);
  engine.destroy();
});
