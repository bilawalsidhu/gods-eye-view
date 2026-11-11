import assert from 'node:assert/strict';
import test from 'node:test';
import { LAYER_MANIFEST } from './renderers.js';
const CONTRACT_PRIMITIVES = ['movers', 'lines', 'ground', 'imagery', 'meshes'];
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import * as geo from '../../geo/index.js';
import { rgbaFromCss } from '../../layers/shared/color.js';
import { aircraftAtlasLayout } from '../../layers/aircraft/render/display.js';
import { vesselAtlasLayout } from '../../layers/vessels/render/display.js';
import { transitTestAtlas } from '../../layers/transit/render/testAtlas.mjs';
import { transitIcon } from '../../data/transitIcons.js';
import { createBikeshareLayer } from '../../layers/bikeshare/index.js';
import { createRadioLayer } from '../../layers/radio/index.js';
import { createDisplayHarness } from '../../layers/installations/render/displayHarness.mjs';
import { BOX } from '../../layers/recentImagery/testDoubles.mjs';
import { createNewsLayer } from '../../layers/news/index.js';
import { createShipwrecksLayer } from '../../layers/shipwrecks/index.js';
import { testMarkerAtlas } from '../../testSupport/mapMarkers.mjs';

const noop = () => {};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const at = (lon = 0, lat = 0, height = 5) =>
  geo.cartesian3.fromDegrees(lon, lat, height);
const color = rgbaFromCss('#5ef08a');
const ring = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
];
const atlas = (layout) => async () => ({
  canvas: { width: layout.width, height: layout.height },
  cells: layout.cells,
});
const story = () => ({
  name: 'story',
  entities: {
    values: [
      {
        id: 'point',
        position: at(85, 28),
        point: { color, pixelSize: 8 },
      },
    ],
  },
});

// Small records from the displays' parity tests; transport and image decoding
// are supplied so this rehearsal needs neither a DOM canvas nor a network.
const cases = {
  news: async (make, _engine, services) => {
    const d = make({
      overlayHost: services.overlayHost,
      drawAtlas: testMarkerAtlas,
      matchMedia: () => ({ matches: true }),
      source: {
        getHotspots: async () => ({
          hotspots: [
            {
              id: 'news-area',
              name: 'Area',
              bbox: [-1, -1, 1, 1],
              focus: { lat: 0, lon: 0 },
              last24h: 1,
            },
          ],
          categories: [],
        }),
        getFeed: async () => ({ reports: [], nextBefore: null }),
      },
    });
    d.enable();
    await d.update();
    return { hide: () => d.show(false) };
  },
  shipwrecks: async (make, _engine, services) => {
    const d = make({
      overlayHost: services.overlayHost,
      drawAtlas: testMarkerAtlas,
      source: {
        getSnapshot: async () => ({
          records: [
            {
              id: 'wreck',
              name: 'Wreck',
              source: 'wikidata',
              lat: 0,
              lon: 0,
              year: 1900,
            },
          ],
          sources: { emodnet: true, wikidata: true },
          fetchedAt: 1,
        }),
      },
    });
    d.enable();
    await d.update();
    return { hide: () => d.show(false) };
  },
  'bhote-koshi-2026': async (make) => {
    const d = make();
    await d.loadImages(BOX, ['pre.webp', 'post.webp'], 'Vantor');
    d.draw(story());
    return { hide: () => d.setVisible(false) };
  },
  'bhote-koshi-locator': (make) => {
    const data = story();
    make({ data });
    return {
      hide: () => {
        data.show = false;
      },
    };
  },
  flights: async (make) => {
    const d = make({ drawAtlas: atlas(aircraftAtlasLayout()) });
    await d.whenReady();
    d.fleet.attach();
    d.fleet.add({ id: 'flight', position: at(), show: true, color });
    return { hide: () => d.fleet.setVisible(false) };
  },
  military: async (make) => cases.flights(make),
  'local-adsb': async (make) => {
    const d = make({ drawAtlas: atlas(aircraftAtlasLayout()) });
    await d.whenReady();
    d.attach();
    d.setVisible(true);
    d.markers.add({
      id: 'local',
      position: () => at(),
      rotation: () => 0,
      show: () => true,
    });
    return { hide: () => d.setVisible(false), detach: () => d.detach() };
  },
  earthquakes: (make) => {
    const d = make();
    d.replace([
      {
        stableId: 'quake',
        lon: 0,
        lat: 0,
        baseRadius: 1000,
        color,
        fillAlpha: 0.4,
      },
    ]);
    d.setVisible(true);
    return { hide: () => d.setVisible(false) };
  },
  'air-quality': (make) => {
    const d = make();
    d.replace([{ id: 'station', lon: 0, lat: 0, color: '#5ef08a' }], 1000);
    d.setVisible(true);
    return { hide: () => d.setVisible(false) };
  },
  'fire-perimeters': (make) => {
    const d = make();
    d.replace([{ id: 'area', containedPct: 20, polygons: [[ring]] }]);
    d.onClick(noop);
    d.setVisible(true);
    return { hide: () => d.setVisible(false) };
  },
  'drone-airspace': (make) => {
    const d = make();
    d.replace([{ id: 'zone', typeCode: 'R', polygons: [[ring]] }]);
    d.onClick(noop);
    d.setVisible(true);
    return { hide: () => d.setVisible(false) };
  },
  'gnss-integrity': (make) => {
    const d = make();
    d.replace(
      [{ west: 30, south: 50, east: 30.5, north: 50.5, level: 'low' }],
      { low: 0.3 },
    );
    d.setVisible(true);
    return { hide: () => d.setVisible(false) };
  },
  's2-ghostmaps': async (make) => {
    const d = make();
    const paint = d.draw(
      'kinetic-30d',
      new Map([
        [
          1,
          {
            style: { polyColor: [0, 0, 1, 0.6] },
            geometries: [{ type: 'polygon', outer: ring, holes: [] }],
          },
        ],
      ]),
      '#00d4ff',
      () => '',
    );
    await paint.ready;
    return { hide: () => paint.destroy() };
  },
  'alpr-cameras': (make, engine, services) => {
    const record = { id: 'alpr:0', latitude: 30, longitude: -97, osmId: 0 };
    const state = {
      enabled: true,
      selectedId: null,
      lastAnchorSampleAt: 0,
      renderRevision: 0,
      records: [record],
      recordById: new Map([[record.id, record]]),
    };
    const d = make({
      state,
      services,
      source: {
        label: 'Fixture',
        attribution: {
          name: 'Fixture cameras',
          text: 'Fixture cameras',
          href: 'https://example.com/cameras',
        },
      },
    });
    engine.camera.setView({ destination: at(-97, 30, 2000) });
    d.init({ onMove: noop });
    d.setVisible(true);
    d.renderRecords();
    return { hide: () => d.setVisible(false) };
  },
  'street-level': (make) => {
    const d = make();
    const lines = d.sequenceLines(
      [
        {
          id: 'a',
          parts: [
            [
              [-121.49, 38.58],
              [-121.48, 38.58],
            ],
          ],
        },
      ],
      {
        id: 'coverage:14/1/2',
        color: '#00ff00',
        alpha: 0.92,
        widthPx: 2.5,
        pickPrefix: 'mly:seq:',
        order: 0,
      },
    );
    return { hide: () => lines.destroy() };
  },
  satellites: (make) => {
    const d = make();
    const points = d.createPoints();
    points.add({ id: '1', position: at(), color, pixelSize: 5, show: true });
    const click = d.listenClick(noop);
    return {
      hide: () => {
        points.show = false;
      },
      detach: () => click.destroy(),
    };
  },
  'rocket-launches': (make) => {
    const d = make();
    d.setVisible(true);
    d.addPoint({ id: 'launch', position: at(), sizePx: 8, color });
    d.onClick(noop);
    return { hide: () => d.setVisible(false) };
  },
  traffic: (make) => {
    const d = make();
    d.drawDots([
      { point: { position: at(), pixelSize: 5, show: true, color } },
    ]);
    d.setHeat(
      'jam',
      [
        {
          coords: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
      { color: color.rgba(), widthPx: 3 },
    );
    return { hide: () => d.show(false) };
  },
  cctv: (make) => {
    const d = make({
      state: { _recordById: new Map(), _projectionEntities: [] },
    });
    d.attach();
    d.createMarkers();
    const marker = d.createMarker({ id: 'a' }, at());
    marker.show = true;
    d.bindClick(noop);
    return { hide: () => d.setMarkersVisible(false) };
  },
  radio: (make, engine, services) => {
    let context;
    const layer = createRadioLayer({
      services,
      source: {},
      rendererFactory(value) {
        context = value;
        return make(value);
      },
    });
    layer.attachRenderer({ engine });
    const renderer = context.parts.renderer;
    const station = {
      id: '00000000-0000-4000-8000-000000000000',
      name: 'Station 0',
      lat: 0,
      lon: 0,
      tags: ['news'],
    };
    context.state._stationById.set(station.id, station);
    context.state._renderById.set(
      station.id,
      renderer.addStation(station, at(), '#44adff'),
    );
    renderer.setVisible(true);
    return {
      hide: () => renderer.setVisible(false),
      destroy: () => layer.detachRenderer(),
    };
  },
  transit: async (make) => {
    const d = make({ state: {}, services: {}, drawAtlas: transitTestAtlas });
    d.attach();
    const [markers] = d.createMarkers();
    markers.show = true;
    await d.whenReady();
    markers.add({
      id: 'bus',
      position: at(),
      image: transitIcon('bus'),
      width: 20,
      height: 20,
      color,
      rotation: 0,
      show: true,
    });
    return {
      hide: () => {
        markers.show = false;
      },
    };
  },
  bikeshare: (make, engine, services) => {
    let display;
    const layer = createBikeshareLayer({
      services,
      source: { getStations: async () => ({ data: { stations: [] } }) },
      rendererFactory(value) {
        display = make(value);
        return display;
      },
    });
    layer.init(null, { engine });
    display.show();
    display.ensureCityPoints(
      'austin-capmetro',
      new Map([
        [
          'central',
          {
            stationId: 'central',
            name: 'Central',
            lat: 30.2672,
            lon: -97.7431,
            capacity: 10,
          },
        ],
      ]),
    );
    return { hide: () => layer.disable(), destroy: () => layer.destroy() };
  },
  directions: (make, engine) => {
    const d = make();
    d.setMarker('A', { lat: 0, lon: 0 });
    d.setRoute({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
    const off = engine.input.on('click', noop, { pick: true });
    d.show(true);
    return { hide: () => d.show(false), detach: off };
  },
  'recent-imagery': (make) => {
    const d = make();
    d.rebind(d.resolveHost());
    assert.equal(
      d.showSlot(
        'a',
        { key: 'S30:2026-09-18', product: 'S30', day: '2026-09-18' },
        BOX,
      ),
      true,
    );
    return { hide: () => d.hideSlot('a') };
  },
  'osm-places': (make) => {
    const d = make();
    d.replace([{ id: 'node/1', lat: 0, lon: 0, color: '#5ef08a' }]);
    d.setVisible(true);
    return { hide: () => d.setVisible(false) };
  },
  'ais-live-vessels': async (make) => {
    const d = make({ drawAtlas: atlas(vesselAtlasLayout()) });
    await d.whenReady();
    d.fleet.attach({ show: true });
    d.fleet.add({
      id: { mmsi: '123456789' },
      position: at(),
      show: true,
      scale: 0.6,
      rotation: 0,
    });
    return { hide: () => d.fleet.setVisible(false) };
  },
  'military-installations': (make, engine, services) => {
    const h = createDisplayHarness(() => ({ engine, destroy: noop }), {
      context: services.context,
      displayFactory: (_engine, options) => make(options),
    });
    h.start();
    h.setRecords([
      {
        id: 'site',
        name: 'Site',
        latitude: 0,
        longitude: 0,
        category: 'military',
        sources: [],
      },
    ]);
    h.parts.display.renderRecords();
    return {
      hide: () => h.parts.display.disable(),
      destroy: () => h.destroy(),
    };
  },
  'military-awareness': (make) => {
    const d = make();
    const rim = d.createRim(at());
    const pulses = d.createPulses(at());
    pulses.draw({ radii: [0.5], alphas: [0.5], level: 1 });
    return {
      hide: () => pulses.draw({ radii: [], alphas: [], level: 0 }),
      detach: () => {
        rim.destroy();
        pulses.destroy();
      },
    };
  },
  wind: (make) => {
    const d = make({
      createCanvas: ({ width, height }) => ({ width, height }),
    });
    d.attach();
    d.setField({
      model: 'gfs',
      grid: { nx: 8, ny: 5, lo1: 0, la1: 90, dx: 45, dy: 45 },
      u: Array.from({ length: 40 }, (_, i) => 5 + (i % 7)),
      v: Array.from({ length: 40 }, (_, i) => (i % 3) - 1),
    });
    d.setOptions({ overlay: 'speed' });
    d.start();
    return { hide: () => d.stop() };
  },
  'weather-radar': async (make) => weather(make, 'radar'),
  'weather-satellite': async (make) => weather(make, 'clouds-regional'),
  'weather-lightning': async (make) => weather(make, 'lightning'),
  'weather-cyclones': async (make, engine, services) => {
    const d = make({ overlayHost: services.overlayHost });
    await d.setSnapshot({
      storms: [
        {
          id: 'ep152026',
          name: 'Fifteen-E',
          position: { longitude: 179, latitude: 15 },
          forecastPoints: [],
          track: {
            type: 'MultiLineString',
            coordinates: [
              [
                [179, 15],
                [-179, 16],
              ],
            ],
          },
        },
      ],
    });
    return { hide: () => d.setSnapshot({ storms: [] }) };
  },
  'local-datacenters': (make, engine, services) =>
    infrastructure(make, services, 'local-datacenters'),
  'local-dams': (make, engine, services) =>
    infrastructure(make, services, 'local-dams'),
  'telegeography-submarine-cables': (make, engine, services) => {
    const d = make({ overlayHost: services.overlayHost });
    d.show({
      cables: {
        features: [
          {
            type: 'Feature',
            id: 'cable',
            properties: { name: 'Cable' },
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          },
        ],
      },
      landingPoints: { features: [] },
    });
    return { hide: () => d.hide() };
  },
  'local-firms': (make) => {
    const d = make();
    d.addCell({ west: 30, south: 50, east: 30.5, north: 50.5, color });
    d.setVisible(true);
    return { hide: () => d.setVisible(false) };
  },
};

async function weather(make, product) {
  const d = make();
  const time = '2026-11-07T12:00:00.000Z';
  assert.equal(
    await d.setFrame(
      {
        schemaVersion: 1,
        product,
        bounds: { west: -130, south: 20, east: -60, north: 55 },
        times: [time],
        latest: time,
        tileSize: 256,
        maxLevel: 6,
        tilingScheme: 'geographic',
      },
      time,
    ),
    true,
  );
  return { hide: () => d.setHidden(true), destroy: () => d.clear() };
}

function infrastructure(make, services, id) {
  const d = make({
    config: {
      id,
      name: 'Runtime Dam',
      source: 'fixture',
      color: '#5ef08a',
      labels: false,
    },
    services,
  });
  const geometry = { type: 'Polygon', coordinates: [ring] };
  d.show({
    features: [
      {
        type: 'Feature',
        id: 'real-dam',
        properties: { name: 'Runtime Dam' },
        geometry,
      },
    ],
    records: [
      {
        id: 'real-dam',
        lon: 0.5,
        lat: 0.5,
        properties: { name: 'Runtime Dam' },
        geometry,
      },
    ],
  });
  return { hide: () => d.hide() };
}

const skips = {
  'wildlife-sightings':
    'The layer draws itself through the contract; no manifest display factory.',
  'sea-marks':
    'The overlay controller draws imagery itself; no manifest display factory.',
  'ski-pistes':
    'The overlay controller draws imagery itself; no manifest display factory.',
};

const layerDisplays = {
  news: createNewsLayer,
  shipwrecks: createShipwrecksLayer,
};

function listenerCounts(engine) {
  return [engine.camera, engine.frames].flatMap((part) =>
    Object.values(part)
      .filter((value) => value && typeof value.addEventListener === 'function')
      .map((event) => event.numberOfListeners),
  );
}

function servicesFixture() {
  const entries = new Map();
  const contexts = new Map();
  const owners = new Map();
  const overlayHost = {
    setEntries: (id, value) => entries.set(id, value),
    setVisible: noop,
    clearSource: (id) => entries.delete(id),
  };
  const context = {
    getSelectedEntityContext: () => null,
    clearSelectedEntityContextForLayer: noop,
    selectEntityContext: noop,
    registerEntityContext: (_entity, metadata) =>
      contexts.set(metadata.id, metadata),
    removeEntityContextsForLayer: (id) => {
      for (const [key, value] of contexts)
        if (value.layerId === id) contexts.delete(key);
    },
  };
  return {
    entries,
    contexts,
    owners,
    context,
    overlayHost,
    render: { governorRequestRender: noop },
    groundFloor: { cachedGroundFloor: () => 150 },
    ground: { cachedGroundFloor: () => 20, warmGroundFloor: noop },
    globe: { getKeyholeGeometry: () => ({ radius: 500 }) },
    overlays: {
      setEntries: overlayHost.setEntries,
      clearSource: overlayHost.clearSource,
      setVisible: noop,
    },
    picking: {
      registerPickOwner: (id, fn) => owners.set(id, fn),
      unregisterPickOwner: (id) => owners.delete(id),
      resolvePickId: (pick) => pick?.id,
      isOwnedByOtherLayer: () => false,
    },
    ...context,
  };
}

test('every manifest display draws and releases its resources on a third engine', async (t) => {
  assert.deepEqual(
    Object.keys(cases).sort(),
    Object.entries(LAYER_MANIFEST)
      .filter(([id, entry]) => entry.display || layerDisplays[id])
      .map(([id]) => id)
      .sort(),
  );
  assert.deepEqual(
    Object.keys(skips).sort(),
    Object.entries(LAYER_MANIFEST)
      .filter(([id, entry]) => !entry.display && !layerDisplays[id])
      .map(([id]) => id)
      .sort(),
  );
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  for (const [id, entry] of Object.entries(LAYER_MANIFEST)) {
    await t.test(id, { skip: skips[id] }, async () => {
      const engine = createFakeEngine({ kind: 'rehearsal' });
      engine.extensions = {};
      engine.fake.script('sampleHeight', 0);
      engine.fake.script('terrainHeight', 0);
      const before = listenerCounts(engine);
      const credits = [...engine.fake.credits];
      const inputs = new Set();
      const on = engine.input.on;
      engine.input.on = (...args) => {
        const off = on(...args);
        const token = {};
        inputs.add(token);
        return () => {
          inputs.delete(token);
          off();
        };
      };
      const services = servicesFixture();
      const factory = entry.display ? await entry.display() : layerDisplays[id];
      let display;
      let lifecycle;
      const make = (options = {}) => {
        assert.equal(display, undefined, 'one factory call per manifest entry');
        if (entry.display) return (display = factory(engine, options));
        display = factory(options);
        display.attachRenderer({ engine });
        return display;
      };
      try {
        lifecycle = (await cases[id](make, engine, services)) ?? {};
        await settle();
        engine.fake.frame();
        assert.ok(
          CONTRACT_PRIMITIVES.some((name) =>
            engine[name]
              .list()
              .some(
                (item) =>
                  item.count > 0 ||
                  name === 'imagery' ||
                  name === 'lines' ||
                  item.kind === 'pulse-field',
              ),
          ),
          'the fixture draws nonempty geometry or imagery',
        );
        lifecycle.hide?.();
        lifecycle.detach?.();
        if (lifecycle.destroy) lifecycle.destroy();
        else display.destroy();
        await settle();
        engine.fake.frame();
        for (const name of CONTRACT_PRIMITIVES)
          assert.deepEqual(
            engine[name].list(),
            [],
            `${name} released before engine destruction`,
          );
        assert.deepEqual(
          listenerCounts(engine),
          before,
          'frame and camera listeners released',
        );
        assert.equal(inputs.size, 0, 'input subscriptions released');
        assert.deepEqual(engine.fake.credits, credits, 'credits released');
        assert.equal(
          engine.input.cameraInputsEnabled(),
          true,
          'camera input restored',
        );
        assert.equal(
          engine.render.isContinuous(),
          false,
          'continuous rendering released',
        );
        assert.equal(engine.camera.following(), null, 'no retained follow');
        assert.ok(
          [...services.entries.values()].every(
            (entries) => entries.length === 0,
          ),
          'overlay entries released',
        );
        assert.equal(services.contexts.size, 0, 'context records released');
        assert.equal(services.owners.size, 0, 'pick owners released');
      } finally {
        lifecycle?.destroy?.();
        display?.destroy?.();
        engine.destroy();
      }
    });
  }
});
