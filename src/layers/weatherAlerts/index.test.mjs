import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherAlertsLayer } from './index.js';

const alert = (id, severity, coordinates) => ({
  id,
  event: 'Tornado Warning',
  headline: `${severity} tornado warning`,
  description: 'Take shelter now.',
  instruction: 'Move to a safe interior room.',
  severity,
  urgency: 'Immediate',
  certainty: 'Observed',
  expires: '2026-10-01T18:00:00Z',
  areas: [{ description: 'Example County', geocode: 'TXC001' }],
  geometries: [
    {
      type: 'Polygon',
      coordinates: [coordinates],
    },
  ],
});

test('renders warning polygons and flies to the selected Alerts row', async () => {
  const entities = [];
  const removed = [];
  const hierarchy = class {
    constructor(positions, holes = []) {
      this.positions = positions;
      this.holes = holes;
    }
  };
  const cesium = {
    CustomDataSource: class {
      constructor(name) {
        this.name = name;
        this.entities = {
          add: (item) => entities.push(item),
          removeAll: () => {
            removed.push(entities.length);
            entities.length = 0;
          },
        };
      }
    },
    Cartesian3: {
      fromDegrees: (longitude, latitude) => ({ longitude, latitude }),
    },
    PolygonHierarchy: hierarchy,
    ClassificationType: { BOTH: 'both' },
    ArcType: { GEODESIC: 'geodesic' },
    Color: {
      fromCssColorString: (value) => ({
        value,
        withAlpha(alpha) {
          return { value, alpha };
        },
      }),
    },
    BoundingSphere: {
      fromPoints: (positions) => ({ positions, radius: 1 }),
    },
  };
  const flights = [];
  let navigation;
  const viewer = {
    dataSources: {
      add: (value) => value,
      remove: () => true,
    },
    scene: { requestRender() {} },
    camera: {
      flyToBoundingSphere: (sphere, options) => flights.push({ sphere, options }),
    },
    isDestroyed: () => false,
  };
  const snapshot = {
    schemaVersion: 1,
    generatedAt: '2026-10-01T12:00:00Z',
    alerts: [
      alert('warning-extreme', 'Extreme', [
        [-100, 30],
        [-99, 30],
        [-99, 31],
        [-100, 30],
      ]),
      alert('warning-minor', 'Minor', [
        [-98, 30],
        [-97, 30],
        [-97, 31],
        [-98, 30],
      ]),
    ],
  };
  const layer = createWeatherAlertsLayer({
    feed: { getSnapshot: async () => snapshot },
    cesium,
    matchMedia: () => ({ matches: false }),
  });
  layer.init(viewer);
  layer.attachShellServices({ runNavigation: (run) => (navigation = run) });
  layer.enable();
  await layer.update();

  assert.equal(entities.length, 2);
  assert.equal(entities[0].id, 'weather-alert:warning-extreme:0:0');
  assert.equal(entities[0].polygon.material.value, '#e33b35');
  assert.equal(layer.getRowControls().list.items.length, 2);
  assert.equal(layer.getRowControls().list.items[0].active, true);
  assert.deepEqual(layer.getRowControls().list.items[1].params, {
    alertId: 'warning-minor',
    focus: true,
  });
  assert.equal(layer.getRowControls().legend.length, 5);
  assert.match(layer.getRowControls().summary.lines[0].text, /Example County/);

  layer.setParams({ alertId: 'warning-minor', focus: true });
  assert.equal(layer.getRowControls().list.items[1].active, true);
  assert.equal(entities[1].polygon.material.value, '#4aa3df');
  navigation();
  assert.equal(flights.length, 1);
  assert.equal(flights[0].sphere.positions.length, 4);
  assert.equal(flights[0].options.duration, 1.2);

  layer.disable();
  assert.equal(entities.length, 0);
  assert.ok(removed.length >= 2);
  layer.destroy();
});

test('rejects a layer without the standard snapshot source', () => {
  assert.throws(() => createWeatherAlertsLayer({ feed: {} }), /snapshot source/);
});