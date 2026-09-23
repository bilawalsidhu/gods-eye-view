// Focused tests for the local-infrastructure analyst-record mapper and snapshot seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createLocalGeoJsonLayer, mapAnalystRecord } from './localGeojson.js';

const DC_RAW = {
  id: '1176042553',
  lat: -52.942,
  lon: -70.85,
  properties: {
    tags: {
      name: 'AWS',
      operator: 'Amazon Web Services',
      'operator:short': 'AWS',
      'capacity:it_load': '27 MW',
    },
  },
};

const DAM_RAW = {
  id: '-19685440',
  lat: -25.41,
  lon: -54.59,
  properties: {
    name: 'Usina Hidrelétrica de Itaipu',
    output: '14000 MW',
    tags: {
      name: 'Usina Hidrelétrica de Itaipu',
      'name:en': 'Itaipu Dam',
      operator: 'Itaipú Binacional',
      associated_river: 'Paraná',
      'plant:output:electricity': '14000 MW',
    },
  },
};

test('infra analyst record: datacenter maps name, operator, capacity', () => {
  const r = mapAnalystRecord(DC_RAW, 'local-datacenters');
  assert.deepEqual(r, {
    id: 'AWS',
    name: 'AWS',
    lat: -52.942,
    lon: -70.85,
    operator: 'Amazon Web Services',
    capacity: '27 MW',
    river: null,
    output: null,
  });
});

test('infra analyst record: dam maps name, operator, river, output; names stay unclamped', () => {
  const r = mapAnalystRecord(DAM_RAW, 'local-dams');
  assert.equal(r.id, 'Usina Hidrelétrica de Itaipu');
  assert.equal(r.name, 'Usina Hidrelétrica de Itaipu');
  assert.equal(r.operator, 'Itaipú Binacional');
  assert.equal(r.river, 'Paraná');
  assert.equal(r.output, '14000 MW');
  assert.equal(r.capacity, null);
});

test('infra analyst record: unnamed feature falls back to source id', () => {
  const r = mapAnalystRecord(
    {
      id: 'dc-42',
      lat: 30.2,
      lon: -97.7,
      properties: { tags: { operator: 'Example Cloud' } },
    },
    'local-datacenters',
  );
  assert.equal(r.id, 'dc-42');
  assert.equal(r.name, null);
  assert.equal(r.operator, 'Example Cloud');
});

test('infra analyst record: empty record yields nulls, never NaN/undefined', () => {
  const r = mapAnalystRecord(undefined, 'local-dams');
  assert.equal(r.id, 'Dam');
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number')
      assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('infra analyst record: output is JSON-safe (no Cesium types leak)', () => {
  const r = mapAnalystRecord(
    {
      ...DAM_RAW,
      entity: {},
      position: { x: 1 },
    },
    'local-dams',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.equal('entity' in r, false);
  assert.equal('position' in r, false);
});

class MockLayerEvent {
  constructor() {
    this.listeners = new Set();
  }

  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

test('infra getAnalystRecords: enabled layer snapshots loaded stems; disable returns []', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        type: 'Feature',
        id: 'runtime-dam',
        properties: {
          name: 'Runtime Dam',
          output: '12 MW',
          tags: { associated_river: 'Test River', operator: 'Test Hydro' },
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-97.7, 30.2],
              [-97.69, 30.2],
              [-97.69, 30.21],
              [-97.7, 30.2],
            ],
          ],
        },
      }),
  });
  const viewer = {
    selectedEntity: undefined,
    dataSources: {
      add(dataSource) {
        return dataSource;
      },
      remove() {
        return true;
      },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-97.695, 30.205, 100_000),
      frustum: { fov: Math.PI / 3 },
      moveEnd: new MockLayerEvent(),
      flyTo() {},
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender: new MockLayerEvent(),
      sampleHeightSupported: false,
      sampleHeight() {
        return undefined;
      },
      screenSpaceCameraController: { enableInputs: true },
      pick() {
        return null;
      },
      requestRender() {},
    },
  };
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    url: '/runtime-dam.geojsonl',
    name: 'Runtime Dams',
    color: '#0088ff',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    projectToWindow: () => ({ x: 400, y: 300 }),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  try {
    assert.deepEqual(
      layer.getAnalystRecords(),
      [],
      'unenabled layer has no analyst records',
    );
    await layer.enable(viewer);
    const rows = layer.getAnalystRecords();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'Runtime Dam');
    assert.equal(rows[0].name, 'Runtime Dam');
    assert.equal(rows[0].operator, 'Test Hydro');
    assert.equal(rows[0].river, 'Test River');
    assert.equal(rows[0].output, '12 MW');
    assert.ok(Number.isFinite(rows[0].lat) && Number.isFinite(rows[0].lon));
    assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), rows[0]);
    assert.equal(
      layer.getAnalystRecords(0).length,
      1,
      'non-finite/zero cap still returns at least one',
    );

    layer.disable(viewer);
    assert.deepEqual(
      layer.getAnalystRecords(),
      [],
      'disable keeps stems but analyst snapshot is empty',
    );
  } finally {
    layer.destroy(viewer);
    assert.deepEqual(
      layer.getAnalystRecords(),
      [],
      'destroy releases analyst records',
    );
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
