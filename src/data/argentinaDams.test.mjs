import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSupplement } from '../../scripts/build-argentina-dams.mjs';
import {
  createInfrastructureSource,
  parseGeojsonLines,
  loadInfrastructureFeatures,
  featurePoint,
  infrastructureDataUrls,
} from '../sources/infrastructureData.js';

const folder = new URL('./local_data/argentina_dams/', import.meta.url);
const read = (name) => readFileSync(new URL(name, folder), 'utf8');
const metadata = JSON.parse(read('source.json'));
const original = JSON.parse(read('source.geojson'));
const osm = parseGeojsonLines(
  readFileSync(
    new URL('./local_data/dams/dams.geojsonl', import.meta.url),
    'utf8',
  ),
);
const packed = parseGeojsonLines(read('dams.geojsonl'));
const expectedAnalystCount = [...osm, ...packed].filter(featurePoint).length;

test('the pinned IGN snapshot reproduces 122 additions and audits exclusions and uncertain pairs', () => {
  const result = buildSupplement(original, osm, metadata);
  assert.deepEqual(result.features, packed);
  assert.equal(packed.length, 122);
  assert.deepEqual(
    result.omitted.map((f) => f.retainedId),
    [110183925, 220340687],
  );
  const audit = JSON.parse(read('deduplication.json'));
  assert.deepEqual(result.excluded, audit.excluded);
  assert.deepEqual(
    result.excluded.map((f) => f.id),
    ['ign-ar-dique-2575'],
  );
  assert.equal(result.excluded[0].reason, 'flood-defense-embankment');
  assert.deepEqual(result.nearbyUnnamed, audit.nearbyUnnamed);
  assert.deepEqual(
    result.nearbyUnnamed.map((pair) => pair.ids),
    [
      ['ign-ar-dique-2578', 'ign-ar-dique-2579'],
      ['ign-ar-dique-2956', 'ign-ar-dique-2957'],
    ],
  );
  for (const pair of result.nearbyUnnamed) {
    assert.ok(pair.distanceM > 5 && pair.distanceM <= 100);
    assert.equal(pair.status, 'retained-distinctness-unverified');
    for (const id of pair.ids)
      assert.ok(packed.some((feature) => feature.id === id));
  }
  assert.equal(
    original.features.length,
    packed.length + result.omitted.length + result.excluded.length,
  );
  assert.deepEqual(
    result.omitted,
    JSON.parse(read('deduplication.json')).omitted,
  );
  assert.equal(new Set(packed.map((f) => f.id)).size, packed.length);
  assert.ok(packed.some((f) => f.properties.name === 'Dique El Chocón'));
  assert.ok(
    packed.some((f) => f.properties.name === 'Dique Piedra del Águila'),
  );
  assert.ok(
    packed.some((f) => f.properties.name === null),
    'missing names stay missing',
  );
  for (const feature of packed) {
    assert.equal(feature.geometry.type, 'Point');
    assert.equal(feature.properties.source_updated_at, null);
    assert.equal(feature.properties.retrieved_at, metadata.retrievedAt);
    assert.equal(feature.properties.attribution, metadata.attribution);
    assert.ok(
      !('osm_id' in feature.properties),
      'IGN is not represented as OSM',
    );
    const raw = original.features.find(
      (f) => f.id === feature.properties.source_feature_id,
    );
    assert.deepEqual(
      feature.properties.ign,
      raw.properties,
      'compilation metadata is retained',
    );
  }
});

test('deduplication keeps distant namesakes and nearby distinct dams', () => {
  const raw = (gid, name, x) => ({
    id: 'dique.' + gid,
    type: 'Feature',
    properties: { gid, fna: name },
    geometry: { type: 'Point', coordinates: [x, -34] },
  });
  const collection = {
    type: 'FeatureCollection',
    totalFeatures: 4,
    features: [
      raw(1, 'Dique Azul', -68),
      raw(2, 'Azul', -68.001),
      raw(3, 'Azul', -67),
      raw(4, 'Verde', -68.002),
    ],
  };
  const result = buildSupplement(collection, [], metadata);
  assert.deepEqual(
    result.features.map((f) => f.id),
    ['ign-ar-dique-1', 'ign-ar-dique-3', 'ign-ar-dique-4'],
  );
  assert.equal(result.omitted[0].reason, 'same-name-within-1500m');
  collection.features[0].geometry.coordinates.reverse();
  assert.throws(() => buildSupplement(collection, [], metadata), /Invalid/);
});

test('renderer acquisition and analyst source include the same separate IGN pack', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return { ok: true, text: async () => readFileSync(new URL(url), 'utf8') };
  };
  const source = createInfrastructureSource({ fetchImpl });
  const records = await source.getRecords('local-dams');
  assert.equal(records.length, expectedAnalystCount);
  assert.deepEqual(requests, infrastructureDataUrls('local-dams'));
  assert.ok(records.some((r) => r.name === 'Dique El Chocón'));
  const features = await loadInfrastructureFeatures(requests.slice(), {
    fetchImpl,
  });
  assert.equal(features.length, osm.length + packed.length);
  assert.equal(await source.getRecords('local-dams'), records);
});

test('a missing supplement fails the complete load and can be retried', async () => {
  let fail = true;
  const source = createInfrastructureSource({
    fetchImpl: async (url) => ({
      ok: !(fail && url.includes('argentina_dams')),
      status: 404,
      text: async () => readFileSync(new URL(url), 'utf8'),
    }),
  });
  await assert.rejects(source.getRecords('local-dams'), /HTTP 404/);
  fail = false;
  assert.equal(
    (await source.getRecords('local-dams')).length,
    expectedAnalystCount,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadInfrastructureFeatures(['unused'], {
      signal: controller.signal,
      fetchImpl: () => assert.fail('aborted before fetch'),
    }),
    { name: 'AbortError' },
  );
});
