// Focused tests for the local-infrastructure analyst-record mapper and snapshot seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';
import { nearbyByLayer } from './entityContext.js';
import {
  createLocalGeoJsonLayer as createLayer,
  mapAnalystRecord,
} from './localGeojsonCore.js';

/** The catalog's services, with the overlay host each test supplies. */
const createLocalGeoJsonLayer = (options) =>
  createLayer(options, {
    ...localGeoJsonServices,
    overlayHost: options.overlayHost,
  });

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
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: -97.695, lat: 30.205, height: 100_000 },
  });
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    url: '/runtime-dam.geojsonl',
    name: 'Runtime Dams',
    color: '#0088ff',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    projectToWindow: () => ({ x: 400, y: 300 }),
    inputFor: () => ({
      onClick: () => () => {},
      suspendCamera: () => () => {},
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
    fake.unbind();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('infra getAnalystRecords: line features are listed at their middle vertex, as counted', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  const features = [
    {
      type: 'Feature',
      id: 'crest-dam',
      properties: { name: 'Crest Dam' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-97.9, 30.39],
          [-97.91, 30.392],
          [-97.92, 30.394],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'pin-dam',
      properties: { name: 'Pin Dam' },
      geometry: { type: 'Point', coordinates: [-97.79, 30.29] },
    },
  ];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => features.map((f) => JSON.stringify(f)).join('\n'),
  });
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: -97.8, lat: 30.3, height: 100_000 },
  });
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    url: '/line-dam.geojsonl',
    name: 'Line Dams',
    color: '#0088ff',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    projectToWindow: () => ({ x: 400, y: 300 }),
    inputFor: () => ({
      onClick: () => () => {},
      suspendCamera: () => () => {},
    }),
  });
  try {
    await layer.enable(viewer);
    const rows = layer.getAnalystRecords();
    assert.equal(rows.length, layer.getStats().count);
    const crest = rows.find((row) => row.name === 'Crest Dam');
    assert.ok(crest, 'the line dam is listed');
    assert.equal(crest.lat, 30.392);
    assert.equal(crest.lon, -97.91);
    assert.ok(rows.some((row) => row.name === 'Pin Dam'));
    assert.equal(layer.getAnalystRecords(1).length, 1);
  } finally {
    layer.destroy(viewer);
    assert.deepEqual(layer.getAnalystRecords(), []);
    globalThis.fetch = originalFetch;
    fake.unbind();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('infra getAnalystRecords: a multi-part line feature is listed once', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  const plant = { name: 'Two Crest Plant' };
  const features = [
    // A dam mapped as its outline and again as its crest lines, under one id.
    {
      type: 'Feature',
      id: 'outlined-dam',
      properties: plant,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [14.29, 46.168],
            [14.293, 46.168],
            [14.293, 46.17],
            [14.29, 46.17],
            [14.29, 46.168],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'outlined-dam',
      properties: plant,
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [14.291, 46.169],
            [14.292, 46.169],
          ],
          [
            [14.291, 46.1695],
            [14.292, 46.1695],
          ],
        ],
      },
    },
    // Crest lines alone: listed at the middle vertex of the longest part.
    {
      type: 'Feature',
      id: 'split-crest',
      properties: { name: 'Split Crest Dam' },
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [-97.9, 30.39],
            [-97.91, 30.39],
          ],
          [
            [-97.8, 30.3],
            [-97.81, 30.302],
            [-97.82, 30.304],
          ],
        ],
      },
    },
  ];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => features.map((f) => JSON.stringify(f)).join('\n'),
  });
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: -97.8, lat: 30.3, height: 100_000 },
  });
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    url: '/multi-part-dam.geojsonl',
    name: 'Multi-part Dams',
    color: '#0088ff',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    projectToWindow: () => ({ x: 400, y: 300 }),
    inputFor: () => ({
      onClick: () => () => {},
      suspendCamera: () => () => {},
    }),
  });
  try {
    await layer.enable(viewer);
    const rows = layer.getAnalystRecords();
    const plants = rows.filter((row) => row.name === 'Two Crest Plant');
    assert.equal(plants.length, 1, 'the outlined dam is listed once');
    const crests = rows.filter((row) => row.name === 'Split Crest Dam');
    assert.equal(crests.length, 1, 'the split crest is listed once');
    assert.equal(crests[0].lat, 30.302);
    assert.equal(crests[0].lon, -97.81);
    assert.equal(rows.length, 2);
  } finally {
    layer.destroy(viewer);
    globalThis.fetch = originalFetch;
    fake.unbind();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('infra records list and count multi-part features across the dateline once', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  const square = (lon, lat) => [
    [
      [lon, lat],
      [lon + 0.01, lat],
      [lon + 0.01, lat + 0.01],
      [lon, lat + 0.01],
      [lon, lat],
    ],
  ];
  const features = [
    {
      type: 'Feature',
      id: 'campus',
      properties: { name: 'Split Campus' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [square(179.7, 30.3), square(-179.99, 30.3)],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'Twin Pins' },
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [179.7, 30.2],
          [-179.9, 30.2],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'single',
      properties: { name: 'Single Hall' },
      geometry: { type: 'Polygon', coordinates: square(179.7, 30.4) },
    },
  ];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => features.map((f) => JSON.stringify(f)).join('\n'),
  });
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: 179.995, lat: 30.305, height: 100_000 },
  });
  const layer = createLocalGeoJsonLayer({
    id: 'local-datacenters',
    url: '/multi-part-sites.geojsonl',
    name: 'Multi-part Sites',
    color: '#0088ff',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    projectToWindow: () => ({ x: 400, y: 300 }),
    inputFor: () => ({
      onClick: () => () => {},
      suspendCamera: () => () => {},
    }),
  });
  try {
    await layer.enable(viewer);
    const rows = layer.getAnalystRecords();
    assert.deepEqual(
      rows.map((row) => row.name).sort(),
      ['Single Hall', 'Split Campus', 'Twin Pins'],
      'one row per feature, not per part',
    );
    assert.equal(layer.getStats().count, 3, 'counted per feature');
    const campus = rows.find((row) => row.name === 'Split Campus');
    assert.equal(campus.parts.length, 2, 'each part keeps its point');
    assert.equal(rows.find((row) => row.name === 'Twin Pins').parts.length, 2);
    assert.equal(
      rows.find((row) => row.name === 'Single Hall').parts,
      undefined,
    );
    // The first campus part is outside the radius. Its other part is just
    // across the dateline, so Nearby must list the campus at that part.
    const row = {
      id: 'local-datacenters',
      name: 'Multi-part Sites',
      enabled: true,
      module: layer,
    };
    const dm = { getAll: () => [row], layers: new Map([[row.id, row]]) };
    const center = { lat: 30.305, lon: 179.995 };
    const [nearby] = nearbyByLayer(dm, center, { radiusKm: 5 });
    assert.equal(nearby?.count, 1);
    assert.equal(nearby.items[0].title, 'Split Campus');
    assert.equal(nearby.items[0].identity.lon, campus.parts[1].lon);
    const [wider] = nearbyByLayer(dm, center, { radiusKm: 40 });
    assert.equal(
      wider.count,
      3,
      'still one row per feature when both parts qualify',
    );
  } finally {
    layer.destroy(viewer);
    globalThis.fetch = originalFetch;
    fake.unbind();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
