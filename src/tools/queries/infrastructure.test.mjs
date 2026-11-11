import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { createApiFetch } from '../../../server/mcp/services.js';
import {
  createInfrastructureSource,
  featurePoint,
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
    lat: 36.016,
    lon: -114.737,
    distance_km: 3.8,
  });
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
