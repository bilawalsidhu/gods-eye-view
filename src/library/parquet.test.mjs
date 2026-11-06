import test from 'node:test';
import assert from 'node:assert/strict';
import {
  featureInBox,
  geoParquetInfo,
  neededColumns,
  partitionsForBox,
} from './parquet.js';
import { createLibrarySource, robustExtent } from './source.js';
import { libraryEntry } from './catalog.js';

const epc = libraryEntry('epc-england-wales');

test('partitions rank by how specific their bbox is, not by name order', () => {
  const index = [
    // A few stray geocodes stretch this area's bbox across the country.
    { url: 'https://h/Barnsley.parquet', bbox: [-3, 51, 0, 54] },
    { url: 'https://h/Sheffield.parquet', bbox: [-1.6, 53.3, -1.3, 53.5] },
    { url: 'https://h/Far.parquet', bbox: [1, 52, 2, 53] },
  ];
  const picked = partitionsForBox(index, [-1.48, 53.37, -1.46, 53.385]);
  assert.deepEqual(
    picked.map(({ url }) => url.split('/').pop()),
    ['Sheffield.parquet', 'Barnsley.parquet'],
  );
});

test('the GeoParquet footer gives the geometry column and its bbox', () => {
  const metadata = {
    key_value_metadata: [
      {
        key: 'geo',
        value: JSON.stringify({
          primary_column: 'geometry',
          columns: {
            geometry: { encoding: 'WKB', bbox: [-0.36, 50.82, -0.22, 50.86] },
          },
        }),
      },
    ],
  };
  assert.deepEqual(geoParquetInfo(metadata), {
    column: 'geometry',
    bbox: [-0.36, 50.82, -0.22, 50.86],
  });
  assert.deepEqual(geoParquetInfo({ key_value_metadata: [] }), {
    column: null,
    bbox: null,
  });
});

test('only the columns the entry uses are read', () => {
  assert.deepEqual(neededColumns(epc, 'geometry'), [
    'geometry',
    'UPRN',
    'CURRENT_ENERGY_RATING',
    'POTENTIAL_ENERGY_RATING',
  ]);
});

test('a learned extent ignores stray points', () => {
  const features = Array.from({ length: 200 }, (_, index) => ({
    geometry: { type: 'Point', coordinates: [-1.4 - index / 1e4, 53.4] },
  }));
  features.push({ geometry: { type: 'Point', coordinates: [-2.6, 51.36] } });
  const [west, south] = robustExtent(features);
  assert.ok(west > -1.5 && south > 53, String([west, south]));
  assert.equal(featureInBox(features[0], [-1.5, 53, -1.3, 54]), true);
  assert.equal(featureInBox(features.at(-1), [-1.5, 53, -1.3, 54]), false);
});

test('a partitioned view reads candidates in batches until one finds features', async () => {
  const index = [
    { url: 'https://h/A.parquet', bbox: [-1.5, 53.3, -1.4, 53.45] },
    { url: 'https://h/B.parquet', bbox: [-1.55, 53.3, -1.35, 53.5] },
  ];
  const reads = [];
  const point = (lon, lat, rating) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { CURRENT_ENERGY_RATING: rating, UPRN: '1' },
  });
  const store = new Map();
  const source = createLibrarySource({
    entries: [epc],
    fetchImpl: async () => ({ ok: false, status: 404 }),
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
    loadParquet: async () => ({
      ...(await import('./parquet.js')),
      buildPartitionIndex: async () => index,
      readGeoParquetFeatures: async (entry, url) => {
        reads.push(url);
        return url.endsWith('A.parquet')
          ? [point(-1.47, 53.38, 'C'), point(-1.2, 53.0, 'D')]
          : [point(-1.47, 53.381, 'B')];
      },
    }),
  });
  const box = [-1.48, 53.37, -1.46, 53.385];
  const first = await source.loadDataset(epc, { bbox: box });
  assert.equal(first.features.length, 2);
  assert.deepEqual(reads.sort(), [
    'https://h/A.parquet',
    'https://h/B.parquet',
  ]);
  // The index is kept in this browser; extents are learned per partition.
  assert.ok(store.get('gev:library:index:epc-england-wales'));
  const learned = JSON.parse(store.get('gev:library:extent:epc-england-wales'));
  assert.ok(learned['https://h/A.parquet']);
  // A second view of the same area is served from the decoded cache.
  await source.loadDataset(epc, { bbox: box });
  assert.equal(reads.length, 2);
  // Without a view box nothing is read.
  assert.deepEqual(await source.loadDataset(epc), {
    features: [],
    truncated: false,
  });
});
