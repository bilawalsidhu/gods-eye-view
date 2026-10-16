import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { createApiFetch } from '../../../server/mcp/services.js';
import {
  createInfrastructureSource,
  featurePoint,
  mapAnalystRecord,
} from '../../sources/infrastructureData.js';

test('features are placed at their point or average outline vertex', () => {
  assert.deepEqual(
    featurePoint({ geometry: { type: 'Point', coordinates: [10, 20] } }),
    { lon: 10, lat: 20 },
  );
  assert.deepEqual(
    featurePoint({
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
          ],
        ],
      },
    }),
    { lon: 1, lat: 1 },
  );
  assert.deepEqual(
    featurePoint({
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [4, 4],
              [6, 6],
            ],
          ],
        ],
      },
    }),
    { lon: 5, lat: 5 },
  );
  assert.equal(featurePoint({ geometry: null }), null);
});

test('datacenters and dams are listed nearest first with their own fields', async () => {
  const records = {
    'local-datacenters': [
      {
        id: 'a',
        name: 'Equinix DC2',
        lat: 38.9,
        lon: -77.45,
        operator: 'Equinix',
        capacity: '20 MW',
        river: null,
        output: null,
      },
      {
        id: 'b',
        name: 'Far DC',
        lat: 48.8,
        lon: 2.35,
        operator: null,
        capacity: null,
        river: null,
        output: null,
      },
    ],
    'local-dams': [
      {
        id: 'c',
        name: 'Hoover Dam',
        lat: 36.016,
        lon: -114.737,
        operator: 'USBR',
        capacity: null,
        river: 'Colorado River',
        output: '2080 MW',
        source: 'OpenStreetMap / OpenInfraMap',
        sourceFeatureId: '123',
        attribution:
          '© OpenStreetMap contributors (ODbL 1.0), via Open Infrastructure Map',
      },
    ],
  };
  const infrastructure = { getRecords: async (layerId) => records[layerId] };
  const catalog = composeCatalog({
    tools: coreTools,
    services: { infrastructure },
  });
  const dc = await catalog.call('find_infrastructure', {
    kind: 'datacenters',
    area: { lat: 38.95, lon: -77.45, radius_km: 20 },
  });
  assert.equal(
    dc.summary,
    '1 mapped datacenter in 20 km around 38.950, -77.450.',
  );
  assert.deepEqual(dc.data.rows[0], {
    name: 'Equinix DC2',
    operator: 'Equinix',
    capacity: '20 MW',
    lat: 38.9,
    lon: -77.45,
    distance_km: 5.6,
  });
  assert.match(dc.data.attribution, /OpenStreetMap contributors \(ODbL 1\.0\)/);
  const dams = await catalog.call('find_infrastructure', {
    kind: 'dams',
    area: { lat: 36, lon: -114.7, radius_km: 20 },
  });
  assert.deepEqual(dams.data.rows[0], {
    name: 'Hoover Dam',
    operator: 'USBR',
    river: 'Colorado River',
    output: '2080 MW',
    source: 'OpenStreetMap / OpenInfraMap',
    source_id: '123',
    retrieved_at: null,
    source_updated_at: null,
    lat: 36.016,
    lon: -114.737,
    distance_km: 3.8,
  });
  assert.doesNotMatch(dams.data.attribution, /IGN|Geográfico/);
});

test('dam query attribution follows matching records and rows retain their provenance', async () => {
  const osm = mapAnalystRecord(
    { id: 42, lat: 36, lon: -114, properties: { osm_id: 42, name: 'OSM dam' } },
    'local-dams',
  );
  const ign = mapAnalystRecord(
    {
      id: 'ign-ar-dique-9',
      lat: -39,
      lon: -68,
      properties: {
        name: 'IGN dam',
        data_source: 'IGN Argentina · Dique',
        source_feature_id: 'dique.9',
        attribution:
          'FUENTE: Instituto Geográfico Nacional de la República Argentina',
        retrieved_at: '2026-10-15',
        source_updated_at: null,
      },
    },
    'local-dams',
  );
  const catalog = composeCatalog({
    tools: coreTools,
    services: { infrastructure: { getRecords: async () => [osm, ign] } },
  });
  const query = (bbox) =>
    catalog.call('find_infrastructure', { kind: 'dams', area: { bbox } });
  const onlyOsm = await query([-115, 35, -113, 37]);
  assert.equal(onlyOsm.data.attribution, osm.attribution);
  assert.equal(onlyOsm.data.rows[0].source_id, '42');
  const onlyIgn = await query([-69, -40, -67, -38]);
  assert.equal(onlyIgn.data.attribution, ign.attribution);
  assert.equal(onlyIgn.data.rows[0].source, 'IGN Argentina · Dique');
  assert.equal(onlyIgn.data.rows[0].source_id, 'dique.9');
  assert.equal(onlyIgn.data.rows[0].retrieved_at, '2026-10-15');
  assert.equal(onlyIgn.data.rows[0].source_updated_at, null);
  const mixed = await query([-180, -90, 180, 90]);
  assert.match(mixed.data.attribution, /OpenStreetMap/);
  assert.match(mixed.data.attribution, /Geográfico/);
  assert.equal((await query([0, 0, 1, 1])).data.attribution, null);
});

test('the bundled datasets load through the local fetch', async () => {
  const fetchImpl = createApiFetch({
    apiBase: 'http://127.0.0.1:1',
    fetchImpl: async () => assert.fail('no network'),
  });
  const source = createInfrastructureSource({ fetchImpl });
  const dams = await source.getRecords('local-dams');
  const datacenters = await source.getRecords('local-datacenters');
  assert.ok(dams.length > 500 && datacenters.length > 3000);
  assert.ok(
    dams.every(
      (record) => Number.isFinite(record.lat) && Number.isFinite(record.lon),
    ),
  );
  assert.equal(await source.getRecords('local-dams'), dams);
  await assert.rejects(
    source.getRecords('local-other'),
    /Unknown infrastructure layer/,
  );
});
