import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationScene } from './scene.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import {
  installRenderGovernor,
  isRenderGovernorInstalled,
} from '../renderGovernor.js';

// The scene's Navara branch in Node: the globe loader is a seam, so the fake
// engine stands in for Navara and nothing Cesium is built.

function installDom() {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    CustomEvent: globalThis.CustomEvent,
    location: globalThis.location,
  };
  const container = { id: 'cesiumContainer' };
  const appended = [];
  globalThis.document = {
    getElementById: (id) => (id === 'cesiumContainer' ? container : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => {
      throw new Error('the Navara scene creates no Cesium credit container');
    },
    body: { appendChild: (node) => appended.push(node) },
  };
  globalThis.location = { search: '?engine=navara&look=photoreal' };
  const events = [];
  globalThis.window = {
    dispatchEvent: (event) => events.push(event),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.CustomEvent ??= class {
    constructor(type, { detail } = {}) {
      this.type = type;
      this.detail = detail;
    }
  };
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  };
  return { container, appended, events, restore };
}

const requestServices = {
  terrain: { getHeights: async () => [] },
  regional: { getBrief: async () => null },
  weather: { getConditions: async () => null },
  summary: { summarize: async () => null },
  features: Object.fromEntries(
    [
      'getAdministrativeAreas',
      'getAreaGeometry',
      'getEnclosingAreas',
      'getFocusFootprints',
      'getFootprints',
      'getMonuments',
      'getNeighborhoodAreas',
      'getStreetAreas',
      'getStreetLines',
    ].map((name) => [name, async () => []]),
  ),
};

// Tests end with run.teardown (the scene's cleanups, then the DOM stand-ins).
async function startScene(options = {}) {
  const dom = installDom();
  const cleanups = [];
  const loads = [];
  const engine = createFakeEngine({ kind: 'navara' });
  let globeDestroyed = 0;
  const loaderStatus = { textContent: '' };
  const scene = await createApplicationScene({
    engineKind: 'navara',
    requestServices,
    googleApiKey: 'google-test',
    credits: [
      { key: 'opensky', html: 'Flights credit' },
      { key: 'photon-geocoder', html: 'Search credit' },
      { key: 'openstreetmap', html: 'OSM credit' },
      { key: 'reearth-terrain', html: 'Terrain credit' },
    ],
    loaderStatus,
    signal: new AbortController().signal,
    defer: (dispose) => cleanups.push(dispose),
    loadNavaraGlobe: async () => async (globeOptions) => {
      loads.push(globeOptions);
      return {
        engine,
        destroy() {
          globeDestroyed += 1;
          engine.destroy();
        },
      };
    },
    ...options,
  });
  const teardown = async () => {
    while (cleanups.length) await cleanups.pop()();
    dom.restore();
  };
  return {
    scene,
    engine,
    loads,
    dom,
    loaderStatus,
    teardown,
    globeDestroyed: () => globeDestroyed,
  };
}

test('the Navara scene builds the engine on the app container and no viewer', async (t) => {
  const run = await startScene();
  t.after(run.teardown);
  assert.equal(run.scene.viewer, null);
  assert.equal(run.scene.tileset, null);
  assert.equal(run.scene.engine, run.engine);
  assert.equal(run.scene.engine.kind, 'navara');
  assert.equal(run.loads.length, 1);
  assert.equal(run.loads[0].container, run.dom.container);
  // The globe picks its look from the page's ?look= (cinematic by default).
  assert.equal(run.loads[0].search, '?engine=navara&look=photoreal');
  assert.ok(run.scene.operations.searchAndFlyTo);
  assert.equal(globalThis.window.__GOOGLE_MAPS_API_KEY__, 'google-test');
  // Match the native static attribution policy for available data layers,
  // even before a layer is enabled.
  assert.deepEqual(
    run.engine.fake.credits.map(({ html }) => html),
    ['Flights credit', 'Search credit', 'OSM credit', 'Terrain credit'],
  );
});

test('the Navara scene opens Google 3D through the engine', async (t) => {
  const run = await startScene();
  t.after(run.teardown);
  const { mapStackController } = run.scene;
  assert.equal(mapStackController.getActiveId(), 'photoreal');
  assert.equal(mapStackController.isStackAvailable('bing-aerial'), false);
  const [tiles] = run.engine.fake.callsOf('maps.setPhotorealTiles')[0].args;
  assert.equal(tiles.kind, 'photoreal');
});

test('without a browser key the Navara scene opens on base imagery', async (t) => {
  const run = await startScene({ googleApiKey: '' });
  t.after(run.teardown);
  assert.equal(run.scene.mapStackController.getActiveId(), 'esri-imagery');
  assert.equal(
    run.engine.fake.callsOf('maps.setBaseImagery')[0].args[0].kind,
    'esri-imagery',
  );
});

test('the Navara scene tears down the controller, then the globe', async (t) => {
  const run = await startScene();
  // The tools install the governor on the engine (src/app/tools.js); the
  // scene removes it before the engine goes.
  installRenderGovernor(run.engine);
  const view = globalThis.window;
  await run.teardown();
  assert.equal(run.globeDestroyed(), 1);
  assert.equal(run.engine.isDestroyed(), true);
  assert.equal(isRenderGovernorInstalled(run.engine), false);
  assert.equal(view.__GOOGLE_MAPS_API_KEY__, undefined);
});

test('Navara keeps attribution for every available W1/W2 source and excludes unavailable data', async (t) => {
  const keys = [
    'opensky',
    'adsblol',
    'adsbdb',
    'aisstream',
    'celestrak',
    'launch-library-2',
    'usgs',
    'firms',
    'photon-geocoder',
    'openstreetmap',
    'reearth-terrain',
  ];
  const run = await startScene({
    credits: [...keys, 'radio-browser'].map((key) => ({
      key,
      html: `Credit ${key}`,
    })),
  });
  t.after(run.teardown);
  assert.deepEqual(
    run.engine.fake.credits.map(({ html }) => html),
    keys.map((key) => `Credit ${key}`),
  );
});
