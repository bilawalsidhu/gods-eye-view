import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createLibraryViewLayer } from './layers.js';
import { libraryEntry } from './catalog.js';

const entry = libraryEntry('fema-usa-structures');

function fakeViewer({ height, lon = -77.03, lat = 38.89 }) {
  const listeners = new Set();
  const added = [];
  const viewer = {
    camera: {
      positionCartographic: { height },
      positionWC: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      moveEnd: {
        addEventListener: (listener) => listeners.add(listener),
        removeEventListener: (listener) => listeners.delete(listener),
      },
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(lon - 1, lat - 1, lon + 1, lat + 1),
    },
    scene: { canvas: { clientWidth: 800, clientHeight: 600 }, globe: {} },
    dataSources: {
      add: async (source) => added.push(source),
      remove: (source) => added.splice(added.indexOf(source), 1),
    },
  };
  return { viewer, listeners, added };
}

const fakeCesium = {
  ...Cesium,
  GeoJsonDataSource: {
    load: async (collection) => ({
      collection,
      entities: { values: collection.features.map(() => ({ polygon: {} })) },
    }),
  },
};

const polygon = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-77.03, 38.89],
        [-77.029, 38.89],
        [-77.029, 38.891],
        [-77.03, 38.89],
      ],
    ],
  },
  properties: { OCC_CLS: 'Government' },
};

test('above its altitude a view-bounded layer loads nothing and asks to zoom in', async () => {
  const calls = [];
  const layer = createLibraryViewLayer(entry, {
    source: { loadDataset: async (...args) => calls.push(args) },
    cesium: fakeCesium,
  });
  const { viewer, listeners } = fakeViewer({ height: 900_000 });
  await layer.init(viewer);
  await layer.enable(viewer);
  assert.equal(calls.length, 0);
  assert.equal(listeners.size, 1);
  assert.deepEqual(layer.getStats(), {
    count: 0,
    lastUpdate: null,
    status: 'zoom-in',
    statusMessage: 'zoom in to load this layer',
  });
  await layer.disable(viewer);
  assert.equal(listeners.size, 0);
});

test('below it, the layer loads the box around the view centre and reads PARTIAL when capped', async () => {
  const calls = [];
  const layer = createLibraryViewLayer(entry, {
    source: {
      loadDataset: async (target, options) => {
        calls.push(options.bbox);
        return { features: [polygon, polygon], truncated: true };
      },
    },
    cesium: fakeCesium,
  });
  const { viewer, added } = fakeViewer({ height: 2000 });
  await layer.init(viewer);
  await layer.enable(viewer);
  assert.equal(calls.length, 1);
  const [west, south, east, north] = calls[0];
  // A window around the centre sized by height (±1 km here), not the
  // ±1° visible rectangle.
  assert.ok(north - south < 0.05 && north - south > 0.005, String(calls[0]));
  assert.ok(west < -77.03 && east > -77.03 && south < 38.89 && north > 38.89);
  assert.equal(added.length, 1);
  assert.equal(added[0].entities.values[0].polygon.outline, false);
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.partial, true);
  // The same view does not refetch.
  await layer.enable(viewer);
  assert.equal(calls.length, 1);
  assert.deepEqual(layer.getExtent(), {
    west: -77.04,
    south: 38.885,
    east: -77.02,
    north: 38.9,
    maxAltitudeM: 4000,
  });
  await layer.destroy(viewer);
  assert.equal(added.length, 0);
});

test('returning to the drawn view cancels the request for the view in between', async () => {
  let release;
  const signals = [];
  let call = 0;
  const layer = createLibraryViewLayer(entry, {
    source: {
      loadDataset: async (target, { signal }) => {
        signals.push(signal);
        call += 1;
        if (call === 2)
          await new Promise((resolve) => {
            release = resolve;
          });
        return { features: [polygon], truncated: false };
      },
    },
    cesium: fakeCesium,
  });
  const { viewer, added } = fakeViewer({ height: 2000 });
  const moveTo = (lon, lat) => {
    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(lon, lat, 2000);
    viewer.camera.pickEllipsoid = () => Cesium.Cartesian3.fromDegrees(lon, lat, 0);
    viewer.camera.computeViewRectangle = () =>
      Cesium.Rectangle.fromDegrees(lon - 1, lat - 1, lon + 1, lat + 1);
  };
  await layer.init(viewer);
  await layer.enable(viewer);
  const drawn = added[0];
  moveTo(-77.2, 38.95);
  const between = layer.enable(viewer);
  await new Promise((resolve) => setImmediate(resolve));
  moveTo(-77.03, 38.89);
  await layer.enable(viewer);
  assert.equal(signals[1].aborted, true);
  release();
  await between;
  assert.deepEqual(added, [drawn]);
  assert.equal(layer.getStats().loading, false);
  await layer.destroy(viewer);
});

test('returning to the drawn view clears an error from the view in between', async () => {
  let call = 0;
  const layer = createLibraryViewLayer(entry, {
    source: {
      loadDataset: async () => {
        call += 1;
        if (call === 2) throw new Error('HTTP 503');
        return { features: [polygon], truncated: false };
      },
    },
    cesium: fakeCesium,
    debounceMs: 0,
  });
  const { viewer, listeners } = fakeViewer({ height: 2000 });
  const moveTo = async (lon, lat) => {
    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(lon, lat, 2000);
    viewer.camera.pickEllipsoid = () =>
      Cesium.Cartesian3.fromDegrees(lon, lat, 0);
    viewer.camera.computeViewRectangle = () =>
      Cesium.Rectangle.fromDegrees(lon - 1, lat - 1, lon + 1, lat + 1);
    // The camera settles: the layer's moveEnd listener schedules a load.
    for (const listener of listeners) listener();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  await layer.init(viewer);
  await layer.enable(viewer);
  await moveTo(-77.2, 38.95);
  assert.ok(layer.getStats().error);
  await moveTo(-77.03, 38.89);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().count, 1);
  await layer.destroy(viewer);
});

test('the row legend labels each colour and counts what is in view', async () => {
  const { colorByLegend } = await import('./layers.js');
  const bridges = libraryEntry('ntad-national-bridges');
  assert.deepEqual(colorByLegend(bridges.display), [
    { label: 'Good', color: '#0ca30c' },
    { label: 'Fair', color: '#fab219' },
    { label: 'Poor', color: '#d03b3b' },
  ]);
  assert.deepEqual(
    colorByLegend(bridges.display, new Map([['P', 2]])).map(
      ({ count }) => count,
    ),
    [0, 0, 2],
  );
  // A tile layer's static scale.
  assert.equal(
    colorByLegend(libraryEntry('gbif-occurrence-density').display).length,
    6,
  );
  assert.deepEqual(
    colorByLegend(libraryEntry('nasa-black-marble').display),
    [],
  );
  // A loaded view layer counts by value.
  const layer = createLibraryViewLayer(bridges, {
    source: {
      loadDataset: async () => ({
        features: [
          { ...polygon, properties: { __gevColorKey: 'G' } },
          { ...polygon, properties: { __gevColorKey: 'G' } },
          { ...polygon, properties: { __gevColorKey: 'P' } },
        ],
        truncated: false,
      }),
    },
    cesium: fakeCesium,
  });
  const { viewer } = fakeViewer({ height: 3000 });
  await layer.init(viewer);
  await layer.enable(viewer);
  assert.deepEqual(
    layer.getRowControls().legend.map(({ label, count }) => [label, count]),
    [
      ['Good', 2],
      ['Fair', 0],
      ['Poor', 1],
    ],
  );
  await layer.destroy(viewer);
});

test('values sharing a label are one legend group, and uncoloured values count as Other', async () => {
  const { colorByLegend } = await import('./layers.js');
  const legend = colorByLegend(
    libraryEntry('wri-global-power-plants').display,
    new Map([
      ['Coal', 3],
      ['Gas', 2],
      ['Wind', 4],
      ['Biomass', 1],
    ]),
  );
  assert.deepEqual(
    legend.map(({ label, count }) => [label, count]),
    [
      ['Fossil (coal, gas, oil)', 5],
      ['Nuclear', 0],
      ['Hydro', 0],
      ['Wind and solar', 4],
      ['Other', 1],
    ],
  );
  assert.equal(legend.at(-1).color, '#a0aec0');
});
