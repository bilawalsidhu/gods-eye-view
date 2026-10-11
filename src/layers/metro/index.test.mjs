import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetroLayer, METRO_OVERLAY_SOURCE_ID } from './index.js';

const RAD = Math.PI / 180;

function fakeCesium() {
  class PointPrimitiveCollection {
    constructor() {
      this.items = new Set();
      this.show = true;
    }
    add(options) {
      const point = { ...options };
      this.items.add(point);
      return point;
    }
    remove(point) {
      return this.items.delete(point);
    }
  }
  const color = (css) => ({ css, withAlpha: () => ({ css }) });
  return {
    PointPrimitiveCollection,
    GroundPolylinePrimitive: Object.assign(
      class {
        constructor(options) {
          Object.assign(this, options);
        }
      },
      { isSupported: () => true },
    ),
    GeometryInstance: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    GroundPolylineGeometry: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    ColorGeometryInstanceAttribute: { fromColor: (c) => ({ c }) },
    PolylineColorAppearance: class {},
    ClassificationType: { BOTH: 2 },
    Cartesian2: class {},
    NearFarScalar: class {},
    Cartographic: {
      fromDegrees: (lon, lat) => ({
        longitude: lon * RAD,
        latitude: lat * RAD,
      }),
      fromCartesian: () => null,
    },
    Cartesian3: {
      // Planar metres are enough for distance ranking in tests.
      fromDegrees: (lon, lat) => ({ x: lon * 111_000, y: lat * 111_000, z: 0 }),
      distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    },
    Color: {
      fromCssColorString: color,
      YELLOW: color('yellow'),
      BLACK: color('black'),
    },
  };
}

function fakeViewer({ lon, lat, height }) {
  const listeners = new Set();
  const primitives = new Set();
  const groundPrimitives = new Set();
  return {
    primitives,
    groundPrimitives,
    fireMoveEnd: () => listeners.forEach((fn) => fn()),
    scene: {
      primitives: {
        add: (p) => primitives.add(p),
        remove: (p) => primitives.delete(p),
      },
      groundPrimitives: {
        add: (p) => (groundPrimitives.add(p), p),
        remove: (p) => groundPrimitives.delete(p),
      },
    },
    camera: {
      positionCartographic: {
        longitude: lon * RAD,
        latitude: lat * RAD,
        height,
      },
      positionWC: { x: lon * 111_000, y: lat * 111_000, z: height },
      moveEnd: {
        addEventListener(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    },
  };
}

function fakeOverlayHost() {
  const calls = [];
  return {
    calls,
    entries: [],
    visible: false,
    setEntries(id, entries) {
      calls.push(['set', id]);
      this.entries = entries;
    },
    clearSource(id) {
      calls.push(['clear', id]);
      this.entries = [];
    },
    setVisible(id, visible) {
      this.visible = visible;
    },
  };
}

const LINE_1 = { id: 'Q50', name: 'Line 1', color: '#ffcd00' };

function fakeSource() {
  const cache = new Map();
  const requests = [];
  return {
    requests,
    async getCitiesInView(box) {
      requests.push(['cities', box]);
      return [{ id: 'Q90', name: 'Paris' }];
    },
    peekStations: (id) => cache.get(id),
    async fetchStations(ids) {
      requests.push(['stations', ids]);
      cache.set('Q90', [
        {
          id: 'Q1',
          name: 'Châtelet',
          lon: 2.347,
          lat: 48.858,
          color: '#ffcd00',
          lines: ['Line 1'],
          lineRefs: [LINE_1],
          adjacent: [{ id: 'Q3', lineId: 'Q50' }],
          url: 'https://www.wikidata.org/wiki/Q1',
        },
        {
          id: 'Q3',
          name: 'Louvre',
          lon: 2.341,
          lat: 48.861,
          color: '#ffcd00',
          lines: ['Line 1'],
          lineRefs: [LINE_1],
          adjacent: [],
          url: 'https://www.wikidata.org/wiki/Q3',
        },
        {
          id: 'Q2',
          name: 'Far',
          lon: 2.6,
          lat: 48.9,
          color: null,
          lines: [],
          lineRefs: [],
          adjacent: [],
          url: 'https://www.wikidata.org/wiki/Q2',
        },
      ]);
      return new Map(cache);
    },
  };
}

test('loads cities then stations, draws points, and labels only nearby stations', async () => {
  const source = fakeSource();
  const overlayHost = fakeOverlayHost();
  const layer = createMetroLayer({
    source,
    overlayHost,
    cesium: fakeCesium(),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const viewer = fakeViewer({ lon: 2.347, lat: 48.858, height: 3000 });
  layer.init(viewer);
  assert.equal(overlayHost.visible, false);
  layer.enable(viewer);
  await layer.update(viewer);

  assert.deepEqual(
    source.requests.map(([kind]) => kind),
    ['cities', 'stations'],
  );
  assert.deepEqual(source.requests[1][1], ['Q90']);
  const [points] = viewer.primitives;
  // Each station is a thin-outlined stop plus a fainter, larger glow halo.
  assert.equal(points.items.size, 6);
  const stops = [...points.items].filter((p) => p.outlineWidth === 1);
  const glows = [...points.items].filter((p) => p.pixelSize === 15);
  assert.deepEqual(stops.map((p) => p.id).sort(), [
    'metro:Q1',
    'metro:Q2',
    'metro:Q3',
  ]);
  assert.deepEqual(glows.map((p) => p.id).sort(), [
    'metro:Q1',
    'metro:Q2',
    'metro:Q3',
  ]);
  const [track] = viewer.groundPrimitives;
  assert.equal(track.geometryInstances.length, 1);
  assert.equal(track.geometryInstances[0].id, 'metro:line:Q1-Q3~Q50');
  assert.equal(layer.getDiagnostics().segments, 1);
  assert.equal(overlayHost.visible, true);
  assert.deepEqual(
    overlayHost.entries.map((e) => e.title),
    ['Châtelet', 'Louvre'],
  );
  assert.equal(overlayHost.calls.at(-1)[1], METRO_OVERLAY_SOURCE_ID);

  const stats = layer.getStats();
  assert.equal(stats.status, 'ready');
  assert.equal(stats.count, 3);
  assert.match(stats.countLabel, /3 stations · 1 city/);
  assert.deepEqual(layer.getRowControls().legend, [
    { label: 'Line 1', color: '#ffcd00', count: 2 },
  ]);

  layer.disable(viewer);
  assert.equal(points.items.size, 0);
  assert.equal(viewer.groundPrimitives.size, 0);
  assert.equal(overlayHost.visible, false);
  assert.deepEqual(overlayHost.entries, []);
  assert.equal(layer.getStats().status, 'idle');
  layer.destroy(viewer);
  assert.equal(viewer.primitives.size, 0);
});

test('asks the user to zoom in instead of querying a continental view', async () => {
  const source = fakeSource();
  const layer = createMetroLayer({
    source,
    overlayHost: fakeOverlayHost(),
    cesium: fakeCesium(),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const viewer = fakeViewer({ lon: 2.3, lat: 48.8, height: 2_000_000 });
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update(viewer);
  assert.equal(source.requests.length, 0);
  const stats = layer.getStats();
  assert.equal(stats.status, 'zoom-in');
  assert.match(stats.statusMessage, /Zoom in/);
  layer.destroy(viewer);
});

test('reports Wikidata failures without throwing', async () => {
  const layer = createMetroLayer({
    source: {
      getCitiesInView: async () => {
        throw new Error('Wikidata rate limit reached; try again shortly');
      },
      fetchStations: async () => new Map(),
      peekStations: () => undefined,
    },
    overlayHost: fakeOverlayHost(),
    cesium: fakeCesium(),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const viewer = fakeViewer({ lon: 2.3, lat: 48.8, height: 3000 });
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update(viewer);
  const stats = layer.getStats();
  assert.equal(stats.status, 'unavailable');
  assert.match(stats.error, /rate limit/);
  layer.destroy(viewer);
});
