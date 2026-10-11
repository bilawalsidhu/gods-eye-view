import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createInfrastructureSource,
  infrastructureDataUrls,
  mapAnalystRecord,
} from '../sources/infrastructureData.js';
import { localInfrastructureOverlayCopy } from './localGeojsonCore.js';
import { composeCatalog, coreTools } from '../tools/index.js';

const PACK = new URL('./local_data/dams/', import.meta.url);

const magoB = {
  type: 'Feature',
  id: 'nve-dam-3615',
  geometry: { type: 'Point', coordinates: [11.17056, 60.30177] },
  properties: {
    name: 'Mago B',
    tags: { associated_river: 'Glommavassdraget' },
    source: 'nve',
    nve: {
      damNumber: 3615,
      purpose: ['Hydropower'],
      damType: 'Concrete',
      function: 'Main dam',
      setting: 'River',
      built: 1952,
      reservoir: 'Mago B',
      powerPlant: 'Mago B',
      municipality: 'Eidsvoll',
      county: 'Akershus',
    },
  },
};

test('the Norwegian dam file matches its checksum and stays inside Norway', () => {
  const raw = readFileSync(new URL('norway.geojsonl', PACK));
  const [expected] = readFileSync(new URL('norway.sha256', PACK), 'utf8').split(
    /\s+/,
  );
  assert.equal(createHash('sha256').update(raw).digest('hex'), expected);
  const features = raw
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(features.length, 4142);
  assert.equal(new Set(features.map((f) => f.id)).size, features.length);
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    assert.ok(lon >= -11 && lon <= 35 && lat >= 57 && lat <= 81.5, feature.id);
    assert.equal(feature.properties.source, 'nve');
  }
  const named = features.filter((f) => f.properties.name);
  assert.ok(named.length > 4000);
  assert.ok(
    named.every(
      (f) =>
        f.properties.name !== f.properties.name.toUpperCase() ||
        !/[A-ZÆØÅ]{4}/.test(f.properties.name),
    ),
    'register names in capitals are written in normal case',
  );
  assert.deepEqual(
    features.find((f) => f.id === 'nve-dam-3615').properties,
    magoB.properties,
  );
});

test('dams load the OpenStreetMap file, then the Norwegian supplement', async () => {
  const urls = infrastructureDataUrls('local-dams');
  assert.equal(urls.length, 2);
  assert.match(urls[0], /dams\.geojsonl$/);
  assert.match(urls[1], /norway\.geojsonl$/);
  assert.equal(infrastructureDataUrls('local-datacenters').length, 1);
  assert.deepEqual(infrastructureDataUrls('nope'), []);

  const hoover = {
    type: 'Feature',
    id: 1,
    geometry: { type: 'Point', coordinates: [-114.737, 36.016] },
    properties: { name: 'Hoover Dam', tags: { operator: 'USBR' } },
  };
  const requested = [];
  const source = createInfrastructureSource({
    fetchImpl: async (url) => {
      requested.push(url);
      const feature = url === urls[0] ? hoover : magoB;
      return new Response(`${JSON.stringify(feature)}\n`);
    },
  });
  const records = await source.getRecords('local-dams');
  assert.deepEqual(requested, urls);
  assert.deepEqual(
    records.map((r) => r.name),
    ['Hoover Dam', 'Mago B'],
  );
  assert.equal(records[0].purpose, null, 'OpenStreetMap dams keep one shape');
  assert.equal(records[1].river, 'Glommavassdraget');
});

test('NVE dams map to analyst records with register facts', () => {
  const record = mapAnalystRecord(
    {
      id: magoB.id,
      lat: 60.30177,
      lon: 11.17056,
      properties: magoB.properties,
    },
    'local-dams',
  );
  assert.deepEqual(record, {
    id: 'Mago B',
    name: 'Mago B',
    lat: 60.30177,
    lon: 11.17056,
    operator: null,
    capacity: null,
    river: 'Glommavassdraget',
    output: null,
    purpose: 'Hydropower',
    built: 1952,
    damType: 'Concrete',
    powerPlant: 'Mago B',
    municipality: 'Eidsvoll',
  });
  assert.equal(
    'purpose' in mapAnalystRecord({ properties: {} }, 'local-datacenters'),
    false,
  );
});

test('an NVE dam card reads purpose, type, year, plant and place', () => {
  assert.deepEqual(
    localInfrastructureOverlayCopy(magoB.properties, 'local-dams'),
    {
      title: 'Mago B',
      details: [
        'Hydropower · concrete dam · built 1952',
        'Mago B power plant · Eidsvoll',
        'Glommavassdraget',
      ],
    },
  );
  const sparse = {
    name: 'Bjordal',
    tags: {},
    nve: { purpose: ['Recreation', 'Water supply'], municipality: 'Voss' },
  };
  assert.deepEqual(
    localInfrastructureOverlayCopy(sparse, 'local-dams').details,
    ['Recreation, Water supply', 'Voss'],
  );
});

test('find_infrastructure returns NVE facts for Norwegian dams only', async () => {
  const records = {
    'local-dams': [
      mapAnalystRecord(
        {
          id: magoB.id,
          lat: 60.30177,
          lon: 11.17056,
          properties: magoB.properties,
        },
        'local-dams',
      ),
    ],
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: { infrastructure: { getRecords: async (id) => records[id] } },
  });
  const result = await catalog.call('find_infrastructure', {
    kind: 'dams',
    area: { lat: 60.3, lon: 11.17, radius_km: 10 },
  });
  assert.deepEqual(result.data.rows[0], {
    name: 'Mago B',
    operator: null,
    river: 'Glommavassdraget',
    output: null,
    purpose: 'Hydropower',
    dam_type: 'Concrete',
    built: 1952,
    power_plant: 'Mago B',
    municipality: 'Eidsvoll',
    lat: 60.30177,
    lon: 11.17056,
    distance_km: 0.2,
  });
  assert.match(result.data.attribution, /NVE \(NLOD\)/);
});
