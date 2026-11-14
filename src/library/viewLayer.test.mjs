import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryViewLayer } from './layers.js';
import { libraryEntry } from './catalog.js';
import { fromDegrees } from '../geo/ellipsoid.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';

const entry = libraryEntry('fema-usa-structures');

/**
 * A viewer whose renderer has a camera at `height` over (lon, lat), a query
 * port picking that point on the ellipsoid, and a draw port.
 */
function fakeViewer(t, { height, lon = -77.03, lat = 38.89 }) {
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort();
  let centre = null;
  const moveTo = (nextLon, nextLat) => {
    centre = fromDegrees(nextLon, nextLat, 0);
    camera.setPose({
      lon: nextLon,
      lat: nextLat,
      height,
      position: fromDegrees(nextLon, nextLat, height),
    });
    camera.setViewRectangle({
      west: nextLon - 1,
      south: nextLat - 1,
      east: nextLon + 1,
      north: nextLat + 1,
    });
  };
  moveTo(lon, lat);
  const { draw, unbind } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: { pickEllipsoid: () => centre },
  });
  t.after(unbind);
  /** The view's fill sets in the scene. */
  const drawn = () =>
    [...draw.sets.values()].filter(
      (set) => !set.disposed && set.spec.id.endsWith(':fills'),
    );
  return { viewer, camera, draw, drawn, moveTo };
}

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

test('above its altitude a view-bounded layer loads nothing and asks to zoom in', async (t) => {
  const calls = [];
  const layer = createLibraryViewLayer(entry, {
    source: { loadDataset: async (...args) => calls.push(args) },
  });
  const { viewer, camera } = fakeViewer(t, { height: 900_000 });
  await layer.init(viewer);
  await layer.enable(viewer);
  assert.equal(calls.length, 0);
  assert.equal(camera.listenerCount('moveEnd'), 1);
  assert.deepEqual(layer.getStats(), {
    count: 0,
    lastUpdate: null,
    status: 'zoom-in',
    statusMessage: 'zoom in to load this layer',
  });
  await layer.disable(viewer);
  assert.equal(camera.listenerCount('moveEnd'), 0);
});

test('below it, the layer loads the box around the view centre and reads PARTIAL when capped', async (t) => {
  const calls = [];
  const layer = createLibraryViewLayer(entry, {
    source: {
      loadDataset: async (target, options) => {
        calls.push(options.bbox);
        return { features: [polygon, polygon], truncated: true };
      },
    },
  });
  const { viewer, drawn } = fakeViewer(t, { height: 2000 });
  await layer.init(viewer);
  await layer.enable(viewer);
  assert.equal(calls.length, 1);
  const [west, south, east, north] = calls[0];
  // A window around the centre sized by height (±1 km here), not the
  // ±1° visible rectangle.
  assert.ok(north - south < 0.05 && north - south > 0.005, String(calls[0]));
  assert.ok(west < -77.03 && east > -77.03 && south < 38.89 && north > 38.89);
  assert.equal(drawn().length, 1);
  const [fill] = drawn()[0].items.values();
  // On the ground and the 3D tiles, with no outline.
  assert.equal(fill.height, 'clampGround');
  assert.equal(fill.clampTo, 'both');
  assert.equal(fill.outline, undefined);
  assert.equal(drawn()[0].show, true);
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
  assert.equal(drawn().length, 0);
});

test('returning to the drawn view cancels the request for the view in between', async (t) => {
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
  });
  const { viewer, drawn, moveTo } = fakeViewer(t, { height: 2000 });
  await layer.init(viewer);
  await layer.enable(viewer);
  const [first] = drawn();
  moveTo(-77.2, 38.95);
  const between = layer.enable(viewer);
  await new Promise((resolve) => setImmediate(resolve));
  moveTo(-77.03, 38.89);
  await layer.enable(viewer);
  assert.equal(signals[1].aborted, true);
  release();
  await between;
  assert.deepEqual(drawn(), [first]);
  assert.equal(layer.getStats().loading, false);
  await layer.destroy(viewer);
});

test('returning to the drawn view clears an error from the view in between', async (t) => {
  let call = 0;
  const layer = createLibraryViewLayer(entry, {
    source: {
      loadDataset: async () => {
        call += 1;
        if (call === 2) throw new Error('HTTP 503');
        return { features: [polygon], truncated: false };
      },
    },
    debounceMs: 0,
  });
  const env = fakeViewer(t, { height: 2000 });
  const { viewer } = env;
  const moveTo = async (lon, lat) => {
    env.moveTo(lon, lat);
    // The camera settles: the layer's moveEnd listener schedules a load.
    env.camera.emit('moveEnd');
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

test('the row legend labels each colour and counts what is in view', async (t) => {
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
  });
  const { viewer, drawn } = fakeViewer(t, { height: 3000 });
  await layer.init(viewer);
  await layer.enable(viewer);
  // Each polygon fills in its value's colour.
  const fills = [...drawn()[0].items.values()].map((item) =>
    item.fill.map((channel) => Math.round(channel * 255)),
  );
  assert.deepEqual(fills[0], [12, 163, 12, 115]);
  assert.deepEqual(fills[2], [208, 59, 59, 115]);
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

test('features draw as the GeoJSON loader drew them: rhumb edges and their own simplestyle', async (t) => {
  // A long east-west edge: a rhumb line holds its latitude, a geodesic bows
  // toward the pole, so the edge is drawn as points along its rhumb line.
  const wide = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-80, 38.89],
          [-74, 38.89],
          [-74, 38.9],
          [-80, 38.89],
        ],
      ],
    },
    properties: { fill: '#ff0000', 'fill-opacity': 0.5 },
  };
  const road = {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-80, 38.89],
        [-74, 38.89],
      ],
    },
    properties: { stroke: '#00ff00', 'stroke-width': 5 },
  };
  // An entry with no colorBy (a colorBy fill is drawn over simplestyle).
  const plainEntry = {
    ...entry,
    display: { ...entry.display, colorBy: undefined },
  };
  const layer = createLibraryViewLayer(plainEntry, {
    source: { loadDataset: async () => ({ features: [wide, road, polygon] }) },
  });
  const { viewer, drawn, draw } = fakeViewer(t, { height: 2000 });
  await layer.init(viewer);
  await layer.enable(viewer);
  const [own, plain] = drawn()[0].items.values();
  const ring = own.geometry.rings[0];
  assert.ok(ring.length > 40, `densified (${ring.length} points)`);
  for (const { lat } of ring.slice(0, ring.length / 2))
    assert.ok(Math.abs(lat - 38.89) < 1e-9, 'the long edge holds its latitude');
  assert.deepEqual(own.fill, [1, 0, 0, 0.5]);
  // Without simplestyle, the entry's colour at 0.35.
  assert.equal(plain.fill[3], 0.35);
  const [line] = [...draw.sets.values()]
    .find((set) => !set.disposed && set.spec.id.endsWith(':lines'))
    .items.values();
  assert.equal(line.widthPx, 5);
  assert.deepEqual(line.style.color.slice(0, 3), [0, 1, 0]);
  assert.ok(line.positions.length > 40);
  await layer.destroy(viewer);
});
