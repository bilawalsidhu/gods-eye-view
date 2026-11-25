// Focused tests for the local-infrastructure analyst-record mapper and snapshot seam.
import { EARTH_RADIUS_KM } from '../geoDistance.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';
import {
  getContextStore,
  getSelectedEntityContext,
  selectEntityContext,
} from './contextStore.js';
import {
  describeEntity,
  findRecord,
  layerMatches,
  nearbyForLayer,
  viewSummaryForLayer,
} from './entityContext.js';
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
      properties: { ...plant, operator: 'Line operator' },
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
    // Crest lines use the middle vertex of the part with the most vertices.
    {
      type: 'Feature',
      id: 'split-crest',
      properties: { name: 'Split Crest Dam', operator: 'Crest operator' },
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
    {
      type: 'Feature',
      id: 'polar-crest',
      properties: { name: 'Polar Crest' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [48.5, 89.76],
          [48.5, 89.84],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'polar-pin',
      properties: { name: 'Polar Pin' },
      geometry: { type: 'Point', coordinates: [0, 89.4742703] },
    },
    {
      type: 'Feature',
      id: 'visitor-centre',
      properties: {
        name: 'Split Crest Dam',
        operator: 'Visitor centre operator',
        website: 'https://example.org/visitor-centre',
      },
      geometry: { type: 'Point', coordinates: [10, 10] },
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
    const clicked = layer.getContextRecord('outlined-dam_2', {
      fromDrawnPart: true,
    });
    assert.equal(clicked.operator, 'Line operator');
    assert.equal(clicked.key, plants[0].key);
    const crest = rows.find((row) => row.key === 'geojson:id:split-crest');
    assert.equal(crest.lat, 30.302);
    assert.equal(crest.lon, -97.81);
    assert.equal(rows.length, 5, 'the split crest is listed once');
    const row = { id: 'local-dams', enabled: true, module: layer };
    const manager = { layers: new Map([[row.id, row]]) };
    for (const [lon, lat, name] of [
      [14.2915, 46.169, 'Two Crest Plant'],
      [-97.905, 30.39, 'Split Crest Dam'],
    ]) {
      const center = { lat, lon };
      const rect = {
        west: lon - 0.0001,
        east: lon + 0.0001,
        south: lat - 0.0001,
        north: lat + 0.0001,
      };
      const found = layerMatches(manager, row.id, { rect, center });
      assert.deepEqual(
        found.items.map((item) => item.title),
        [name],
      );
      assert.deepEqual(
        viewSummaryForLayer(manager, row, rect, center)?.items.map(
          (item) => item.title,
        ),
        [name],
      );
      const card = describeEntity(manager, found.items[0].identity);
      assert.ok(Math.abs(card.lon - lon) < 0.0001);
      assert.equal(describeEntity(manager, card.identity).lon, card.lon);
    }
    const center = { lat: 30.56, lon: -97.905 };
    const nearby = nearbyForLayer(manager, row, center, { radiusKm: 25 });
    assert.equal(nearby.count, 1);
    assert.equal(nearby.items[0].title, 'Split Crest Dam');
    const card = describeEntity(manager, nearby.items[0].identity);
    assert.ok(Math.abs(card.lat - 30.39) < 0.0001);
    assert.ok(Math.abs(card.lon - center.lon) < 0.0001);
    assert.equal(describeEntity(manager, card.identity).lat, card.lat);
    // The crest crosses the 25 km radius even though both vertices lie outside.
    const polarCenter = { lat: 89.7, lon: 0 };
    const polar = nearbyForLayer(manager, row, polarCenter, { radiusKm: 25 });
    assert.equal(polar.count, 1);
    const [polarCrest] = polar.items;
    assert.equal(polarCrest.title, 'Polar Crest');
    assert.ok(polarCrest.distanceKm < 25);
    const polarCard = describeEntity(manager, polarCrest.identity);
    assert.ok(polarCard.lat > 89.76 && polarCard.lat < 89.84);
    assert.equal(polarCard.lon, 48.5);
    assert.equal(
      describeEntity(manager, polarCard.identity).lat,
      polarCard.lat,
    );

    // The pin is 25.1 km away, between the true line minimum and its end.
    const polarRect = { west: -1, east: 49, south: 89.4, north: 89.9 };
    const visible = [
      nearbyForLayer(manager, row, polarCenter, { radiusKm: 26, limit: 1 }),
      layerMatches(manager, row.id, {
        center: polarCenter,
        rect: polarRect,
        limit: 1,
      }),
      viewSummaryForLayer(manager, row, polarRect, polarCenter, {
        perLayer: 1,
      }),
      viewSummaryForLayer(manager, row, null, polarCenter, {
        hemisphere: true,
        perLayer: 1,
      }),
    ];
    assert.deepEqual(
      visible.map(({ items }) => items[0].title),
      Array(4).fill('Polar Crest'),
    );
    for (const {
      items: [item],
    } of visible) {
      const opened = describeEntity(manager, item.identity);
      assert.ok(Math.abs(opened.lat - 89.801213) < 0.00001);
      assert.equal(describeEntity(manager, opened.identity).lat, opened.lat);
    }
    const northEdge = 89.79;
    const clipped = viewSummaryForLayer(
      manager,
      row,
      { ...polarRect, south: 89.69, north: northEdge },
      polarCenter,
    ).items[0];
    assert.equal(clipped.title, 'Polar Crest');
    assert.equal(
      clipped.identity.lat,
      northEdge,
      'nearest point is on the viewport edge',
    );
    const globeHeight = 20_000_000;
    const horizonAngle =
      (Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + globeHeight / 1000)) *
        180) /
      Math.PI;
    const atLimb = viewSummaryForLayer(manager, row, null, polarCenter, {
      hemisphere: true,
      heightM: globeHeight,
      eye: { lat: northEdge - horizonAngle, lon: 48.5 },
      query: 'Polar Crest',
    }).items[0];
    assert.ok(
      atLimb.identity.lat > northEdge - 0.00001 &&
        atLimb.identity.lat < northEdge,
    );

    const websiteOf = (item) =>
      item.links.find(({ kind }) => kind === 'website')?.href;
    assert.equal(card.operator, 'Crest operator');
    assert.equal(websiteOf(card), undefined, 'a namesake supplies no link');

    const point = describeEntity(manager, {
      layerId: row.id,
      id: 'local-dams:visitor-centre',
    });
    assert.equal(point.operator, 'Visitor centre operator');
    assert.equal(websiteOf(point), 'https://example.org/visitor-centre');
    assert.equal(
      websiteOf(describeEntity(manager, point.identity)),
      websiteOf(point),
    );

    const withCrestWebsite = features.map((feature) =>
      feature.id === 'split-crest'
        ? {
            ...feature,
            properties: {
              ...feature.properties,
              website: 'https://example.org/crest',
            },
          }
        : feature,
    );
    await layer.replaceFeatures(viewer, withCrestWebsite);
    const refreshed = describeEntity(manager, card.identity);
    assert.equal(refreshed.operator, 'Crest operator');
    assert.equal(websiteOf(refreshed), 'https://example.org/crest');

    await layer.replaceFeatures(
      viewer,
      features.filter(({ id }) => id !== 'split-crest'),
    );
    const missing = describeEntity(manager, {
      ...card.identity,
      id: `${row.id}:${card.identity.id}`,
    });
    assert.equal(
      websiteOf(missing),
      undefined,
      'a missing crest cannot borrow the pin link',
    );
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
        coordinates: [square(179.7, 30.3), square(179.75, 30.3)],
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
      id: 'campus',
      properties: { name: 'Split Campus' },
      geometry: { type: 'Polygon', coordinates: square(-179.99, 30.3) },
    },
    {
      type: 'Feature',
      id: 'single',
      properties: { name: 'Single Hall' },
      geometry: { type: 'Polygon', coordinates: square(179.7, 30.4) },
    },
    {
      type: 'Feature',
      // This source ID also names the second rendered part of campus.
      id: 'campus_2',
      properties: { name: 'Single Hall' },
      geometry: { type: 'Point', coordinates: [179.72, 30.39] },
    },
    ...[
      { properties: { operator: 'First operator' } },
      { properties: { operator: 'Second operator' } },
      { id: 42, properties: { operator: 'Source ID operator' } },
      { properties: { osm_id: 42, operator: 'OSM operator' } },
    ].map((feature) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [8, 47] },
      ...feature,
    })),
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
      rows
        .filter((row) => row.lon !== 8)
        .map((row) => row.name)
        .sort(),
      ['Single Hall', 'Single Hall', 'Split Campus', 'Twin Pins'],
      'one row per feature, not per part',
    );
    assert.equal(layer.getStats().count, 8, 'counted per feature');
    const campus = rows.find((row) => row.name === 'Split Campus');
    assert.equal(campus.parts.length, 3, 'each part keeps its point');
    assert.deepEqual(
      layer.getAnalystRecords(1),
      [campus],
      'the cap keeps one feature and all its parts, including the later row',
    );
    assert.equal(rows.find((row) => row.name === 'Twin Pins').parts.length, 2);
    assert.equal(
      rows.find((row) => row.name === 'Single Hall').parts,
      undefined,
    );
    // The first campus parts are outside the radius. Its third part is just
    // across the dateline, so Nearby must list the campus at that part.
    const row = {
      id: 'local-datacenters',
      name: 'Multi-part Sites',
      enabled: true,
      module: layer,
    };
    const dm = { getAll: () => [row], layers: new Map([[row.id, row]]) };
    const coincident = nearbyForLayer(
      dm,
      row,
      { lat: 47, lon: 8 },
      { radiusKm: 5, limit: 4 },
    );
    assert.equal(coincident.count, 4);
    const opened = coincident.items.map(({ identity }) =>
      describeEntity(dm, identity),
    );
    assert.deepEqual(
      opened.map(({ identity }) => findRecord(dm, identity)?.operator),
      coincident.items.map(({ identity }) => identity.record.operator),
      'rereading each selected card keeps its source operator',
    );
    assert.equal(new Set(opened.map(({ key }) => key)).size, 4);

    const twin = rows.find(({ name }) => name === 'Twin Pins');
    const twinPick = describeEntity(dm, {
      layerId: row.id,
      // Twin Pins follows the campus's two rendered parts in this fixture.
      id: 'local-datacenters:local-part:3',
      ...twin.parts[1],
    });
    assert.equal(twinPick.identity.id, twin.key);
    assert.equal(describeEntity(dm, twinPick.identity).lon, twin.parts[1].lon);

    const center = { lat: 30.305, lon: 179.995 };
    const nearby = nearbyForLayer(dm, row, center, { radiusKm: 5 });
    assert.equal(nearby?.count, 1);
    assert.equal(nearby.items[0].title, 'Split Campus');
    assert.equal(nearby.items[0].identity.lon, campus.parts[2].lon);
    const wider = nearbyForLayer(dm, row, center, { radiusKm: 40, limit: 4 });
    assert.equal(
      wider.count,
      4,
      'still one row per feature when both parts qualify',
    );
    const halls = wider.items.filter((item) => item.title === 'Single Hall');
    assert.equal(halls.length, 2);
    assert.notEqual(halls[0].key, halls[1].key);
    const mapPick = describeEntity(dm, {
      layerId: row.id,
      id: 'local-datacenters:campus_2',
      ...campus.parts[1],
    });
    assert.equal(mapPick.key, nearby.items[0].key);
    assert.equal(mapPick.lon, campus.parts[1].lon);
    assert.equal(describeEntity(dm, mapPick.identity).lon, mapPick.lon);
    const hallPick = describeEntity(dm, {
      layerId: row.id,
      id: 'local-datacenters:campus_2_2',
    });
    assert.equal(hallPick.lon, 179.72);
    for (const hall of halls) {
      const card = describeEntity(dm, hall.identity);
      assert.equal(card.key, hall.key);
      const fresh = findRecord(dm, { layerId: row.id, id: card.identity.id });
      assert.deepEqual([fresh.lat, fresh.lon], [card.lat, card.lon]);
    }

    const inserted = {
      type: 'Feature',
      properties: { name: 'Newer site' },
      geometry: { type: 'Point', coordinates: [7, 48] },
    };
    // New datasets contain fresh feature objects, and may arrive sorted
    // differently when a new feature enters the feed.
    const reordered = [inserted, ...structuredClone(features).reverse()];
    const pins = reordered.find(
      ({ properties }) => properties.name === 'Twin Pins',
    );
    pins.properties.__gevRank = 200;
    await layer.replaceFeatures(viewer, reordered);
    assert.deepEqual(
      opened.map(({ identity }) => findRecord(dm, identity)?.operator),
      opened.map(({ operator }) => operator),
      'already-selected records retain their operators through insertion and reorder',
    );
    assert.equal(describeEntity(dm, twinPick.identity).key, twinPick.key);
    assert.equal(describeEntity(dm, twinPick.identity).lon, twinPick.lon);

    const retained = reordered.filter(
      ({ properties }) =>
        !['Second operator', 'OSM operator'].includes(properties.operator),
    );
    await layer.replaceFeatures(viewer, retained);
    const first = opened.find(({ operator }) => operator === 'First operator');
    const second = opened.find(
      ({ operator }) => operator === 'Second operator',
    );
    assert.equal(findRecord(dm, first.identity)?.operator, first.operator);
    assert.equal(
      findRecord(dm, second.identity),
      null,
      'a removed feature cannot retarget',
    );

    const newTwin = {
      type: 'Feature',
      properties: { name: 'Twin Pins', operator: 'Another operator' },
      geometry: { type: 'Point', coordinates: pins.geometry.coordinates[0] },
    };
    await layer.replaceFeatures(viewer, [newTwin, ...retained]);
    assert.equal(describeEntity(dm, twinPick.identity).lon, twinPick.lon);
    const newTwinRecord = layer
      .getAnalystRecords()
      .find(({ operator }) => operator === 'Another operator');
    assert.notEqual(newTwinRecord.key, twinPick.identity.id);
    assert.ok(!newTwinRecord.key.includes('Another operator'));

    await layer.replaceFeatures(viewer, [
      newTwin,
      ...retained.filter((feature) => feature !== pins),
    ]);
    assert.equal(findRecord(dm, twinPick.identity), null);
    assert.equal(
      findRecord(dm, { layerId: row.id, id: newTwinRecord.key })?.operator,
      'Another operator',
      'a surviving twin cannot inherit the old singleton key',
    );
  } finally {
    layer.destroy(viewer);
    globalThis.fetch = originalFetch;
    fake.unbind();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
