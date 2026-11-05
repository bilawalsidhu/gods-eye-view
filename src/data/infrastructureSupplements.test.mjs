import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadInfrastructureFeatures,
  mapAnalystRecord,
  featurePoint,
} from '../sources/infrastructureData.js';
import { composeCatalog, coreTools } from '../tools/index.js';

// Same display name and overlapping numeric source identifiers deliberately
// exercise provenance, not a name-keyed merge. Coordinates distinguish structures.
const feature = (id, lon, properties) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [lon, 0] },
  properties: { name: 'Shared name', ...properties },
});
const packs = new Map([
  ['osm', [feature(42, -1, { osm_id: 42 })]],
  [
    'nve',
    [feature('nve-dam-42', 0, { source: 'nve', nve: { damNumber: 42 } })],
  ],
  [
    'ign',
    [
      feature('ign-ar-dique-42', 1, {
        data_source: 'IGN Argentina · Dique',
        source_feature_id: 'dique.42',
        attribution:
          'FUENTE: Instituto Geográfico Nacional de la República Argentina',
        retrieved_at: '2026-10-15',
        source_updated_at: null,
      }),
    ],
  ],
]);
const readPack = async (url) =>
  new Response(packs.get(url).map(JSON.stringify).join('\n'));
const recordsFor = (features) =>
  features.map((f) =>
    mapAnalystRecord(
      {
        id: f.id,
        ...featurePoint(f),
        properties: f.properties,
      },
      'local-dams',
    ),
  );

test('three independent sources append in URL order, despite reverse completion and duplicate URLs', async () => {
  const requested = [];
  const pending = new Map();
  const loaded = loadInfrastructureFeatures(['osm', 'nve', 'ign', 'nve'], {
    fetchImpl: (url) => {
      requested.push(url);
      return new Promise((resolve) => pending.set(url, resolve));
    },
  });
  for (const url of ['ign', 'nve', 'osm'])
    pending.get(url)(await readPack(url));
  const { features, error } = await loaded;
  assert.equal(error, null);
  assert.deepEqual(requested, ['osm', 'nve', 'ign']);
  assert.deepEqual(features, [...packs.values()].flat());
  const records = recordsFor(features);
  assert.equal(
    records.length,
    3,
    'namesakes and different providers must not overwrite each other',
  );
  assert.deepEqual(
    records.map((r) => r.source),
    ['OpenStreetMap / OpenInfraMap', 'NVE', 'IGN Argentina · Dique'],
  );
  assert.deepEqual(
    records.map((r) => r.sourceFeatureId),
    ['42', 'nve-dam-42', 'dique.42'],
  );
  assert.equal(
    records[1].retrievedAt,
    null,
    'do not invent dates missing from NVE features',
  );
  assert.equal(records[1].sourceUpdatedAt, null);
});

test('either failed supplement leaves the main file and its healthy sibling intact', async () => {
  for (const failed of ['nve', 'ign']) {
    for (const malformed of [false, true]) {
      const result = await loadInfrastructureFeatures([...packs.keys()], {
        fetchImpl: (url) =>
          url === failed
            ? Promise.resolve(
                new Response(malformed ? 'broken JSON' : '', {
                  status: malformed ? 200 : 404,
                }),
              )
            : readPack(url),
      });
      assert.ok(result.error);
      assert.deepEqual(
        result.features,
        [...packs]
          .filter(([url]) => url !== failed)
          .flatMap(([, features]) => features),
      );
    }
  }
  const recovered = await loadInfrastructureFeatures([...packs.keys()], {
    fetchImpl: readPack,
  });
  assert.equal(recovered.error, null);
  assert.equal(recovered.features.length, 3);
});

test('source attribution follows capped rows for each provider, mixed results and empty results', async () => {
  const records = recordsFor([...packs.values()].flat());
  const catalog = composeCatalog({
    tools: coreTools,
    services: { infrastructure: { getRecords: async () => records } },
  });
  for (const record of records) {
    const result = await catalog.call('find_infrastructure', {
      kind: 'dams',
      area: { lat: record.lat, lon: record.lon, radius_km: 300 },
      limit: 1,
    });
    assert.equal(result.data.total, 3);
    assert.equal(result.data.returned, 1);
    assert.equal(result.data.rows[0].source, record.source);
    assert.equal(result.data.rows[0].source_id, record.sourceFeatureId);
    assert.equal(result.data.attribution, record.attribution);
  }
  const mixed = await catalog.call('find_infrastructure', {
    kind: 'dams',
    area: { bbox: [-2, -1, 2, 1] },
  });
  assert.equal(mixed.data.returned, 3);
  for (const record of records)
    assert.ok(mixed.data.attribution.includes(record.attribution));
  const empty = await catalog.call('find_infrastructure', {
    kind: 'dams',
    area: { bbox: [10, 10, 11, 11] },
  });
  assert.equal(empty.data.returned, 0);
  assert.equal(empty.data.attribution, null);
});
