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
      buildPartitionIndex: async () => ({ partitions: index, complete: true }),
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
  const learned = JSON.parse(
    store.get('gev:library:extent:v2:epc-england-wales'),
  );
  assert.ok(learned['https://h/A.parquet'].full);
  assert.ok(learned['https://h/A.parquet'].trimmed);
  // A second view of the same area is served from the decoded cache.
  await source.loadDataset(epc, { bbox: box });
  assert.equal(reads.length, 2);
  // Without a view box nothing is read.
  assert.deepEqual(await source.loadDataset(epc), {
    features: [],
    truncated: false,
  });
});

test('a revisit still finds homes at the edge of a partition', async () => {
  // 200 homes in a cluster and one real home at the partition's edge: the
  // trimmed (98 %) extent leaves the edge home out, the full one keeps it.
  const point = (lon, lat) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { CURRENT_ENERGY_RATING: 'C', UPRN: String(lon) },
  });
  const homes = Array.from({ length: 200 }, (_, index) =>
    point(-1.4 - index / 1e4, 53.4),
  );
  const edge = point(-1.2, 53.3);
  homes.push(edge);
  const index = [
    { url: 'https://h/Edge.parquet', bbox: [-1.5, 53.2, -1.1, 53.5] },
  ];
  const store = new Map([
    // A v1 extent (trimmed only) from an older build: never read again.
    [
      'gev:library:extent:epc-england-wales',
      JSON.stringify({ 'https://h/Edge.parquet': [-1.42, 53.4, -1.4, 53.4] }),
    ],
  ]);
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  const visit = () =>
    createLibrarySource({
      entries: [epc],
      fetchImpl: async () => ({ ok: false, status: 404 }),
      storage,
      loadParquet: async () => ({
        ...(await import('./parquet.js')),
        buildPartitionIndex: async () => ({
          partitions: index,
          complete: true,
        }),
        readGeoParquetFeatures: async () => homes,
      }),
    });
  const edgeBox = [-1.21, 53.29, -1.19, 53.31];
  // First visit: the old v1 extent would have skipped the partition.
  const first = await visit().loadDataset(epc, { bbox: edgeBox });
  assert.equal(first.features.length, 1);
  assert.equal(store.has('gev:library:extent:epc-england-wales'), false);
  // A later visit (new page, nothing decoded) reads the learned v2 extents.
  const later = await visit().loadDataset(epc, { bbox: edgeBox });
  assert.equal(later.features.length, 1);
  assert.deepEqual(later.features[0].geometry.coordinates, [-1.2, 53.3]);
  // A box outside every point of the partition is still ruled out.
  const outside = await visit().loadDataset(epc, {
    bbox: [-1.12, 53.45, -1.11, 53.46],
  });
  assert.equal(outside.features.length, 0);
});

test('a view over an incomplete index reads PARTIAL', async () => {
  const home = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-1.2, 53.3] },
    properties: { CURRENT_ENERGY_RATING: 'C', UPRN: '1' },
  };
  const visit = (complete) =>
    createLibrarySource({
      entries: [epc],
      fetchImpl: async () => ({ ok: false, status: 404 }),
      storage: null,
      loadParquet: async () => ({
        ...(await import('./parquet.js')),
        buildPartitionIndex: async () => ({
          partitions: [
            { url: 'https://h/A.parquet', bbox: [-1.5, 53.2, -1.1, 53.5] },
          ],
          complete,
        }),
        readGeoParquetFeatures: async () => [home],
      }),
    });
  const box = [-1.21, 53.29, -1.19, 53.31];
  const whole = await visit(true).loadDataset(epc, { bbox: box });
  assert.equal(whole.truncated, false);
  const partial = await visit(false).loadDataset(epc, { bbox: box });
  assert.equal(partial.features.length, 1);
  assert.equal(partial.truncated, true);
});

test('a view that moves on does not cancel the index build the next view waits for', async () => {
  const home = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-1.2, 53.3] },
    properties: { CURRENT_ENERGY_RATING: 'C', UPRN: '1' },
  };
  let release;
  let buildSignal = null;
  let builds = 0;
  const source = createLibrarySource({
    entries: [epc],
    fetchImpl: async () => ({ ok: false, status: 404 }),
    storage: null,
    loadParquet: async () => ({
      ...(await import('./parquet.js')),
      buildPartitionIndex: async (_entry, { signal }) => {
        builds += 1;
        buildSignal = signal;
        await new Promise((resolve) => {
          release = resolve;
        });
        signal?.throwIfAborted();
        return {
          partitions: [
            { url: 'https://h/A.parquet', bbox: [-1.5, 53.2, -1.1, 53.5] },
          ],
          complete: true,
        };
      },
      readGeoParquetFeatures: async () => [home],
    }),
  });
  const box = [-1.21, 53.29, -1.19, 53.31];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const first = new AbortController();
  const a = source.loadDataset(epc, { bbox: box, signal: first.signal });
  await tick();
  first.abort();
  await assert.rejects(a);
  const b = source.loadDataset(epc, { bbox: box, signal: new AbortController().signal });
  await tick();
  release();
  const view = await b;
  assert.equal(view.features.length, 1);
  assert.equal(builds, 1, 'the second view reused the build');
  assert.equal(buildSignal, undefined, 'no view owns the build');
});

test('a footer that keeps failing leaves the index incomplete, and a retry recovers', async () => {
  const { buildPartitionIndex } = await import('./parquet.js');
  const entry = {
    ...epc,
    source: {
      ...epc.source,
      partitions: {
        listUrl: 'https://s3.us-west-2.amazonaws.com/bucket?list-type=2',
        keyBase: 'https://s3.us-west-2.amazonaws.com/bucket/',
      },
    },
  };
  const listing = `<ListBucketResult><Contents><Key>a.parquet</Key><Size>100</Size></Contents><Contents><Key>b.parquet</Key><Size>100</Size></Contents></ListBucketResult>`;
  let footerFailures = 0;
  const fetchImpl = async (url) => {
    if (url.includes('list-type'))
      return new Response(listing, { status: 200 });
    if (url.endsWith('b.parquet') && footerFailures > 0) {
      footerFailures -= 1;
      return new Response('', { status: 503 });
    }
    // Not a Parquet footer: readable, but with no bbox, so left out.
    return new Response(new Uint8Array(100), { status: 200 });
  };
  footerFailures = 2; // fails once, then succeeds on the first retry
  const recovered = await buildPartitionIndex(entry, {
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal(recovered.complete, true);
  footerFailures = 100; // fails on every pass
  const broken = await buildPartitionIndex(entry, {
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal(broken.complete, false);
  assert.equal(broken.failed, 1);
});

test('a footer whose body fails mid-stream is retried, not left out', async () => {
  const { buildPartitionIndex } = await import('./parquet.js');
  const entry = {
    ...epc,
    source: {
      ...epc.source,
      partitions: {
        listUrl: 'https://s3.us-west-2.amazonaws.com/bucket?list-type=2',
        keyBase: 'https://s3.us-west-2.amazonaws.com/bucket/',
      },
    },
  };
  const listing = `<ListBucketResult><Contents><Key>a.parquet</Key><Size>100</Size></Contents></ListBucketResult>`;
  let cutOff = 0;
  const fetchImpl = async (url) => {
    if (url.includes('list-type'))
      return new Response(listing, { status: 200 });
    if (cutOff > 0) {
      cutOff -= 1;
      // Headers arrive, then the connection drops.
      const body = new ReadableStream({
        pull(controller) {
          controller.error(new Error('connection reset'));
        },
      });
      return new Response(body, { status: 206 });
    }
    return new Response(new Uint8Array(100), { status: 200 });
  };
  cutOff = 100;
  const broken = await buildPartitionIndex(entry, {
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal(broken.complete, false, 'never reported whole');
  assert.equal(broken.failed, 1);
  cutOff = 1;
  const recovered = await buildPartitionIndex(entry, {
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal(recovered.complete, true);
});

test('the browser keeps a complete index over an incomplete rebuild and retries later', async () => {
  let clock = 30 * 24 * 3600_000;
  const complete = [{ url: 'https://h/A.parquet', bbox: [-2, 53, -1, 54] }];
  const store = new Map([
    [
      'gev:library:index:epc-england-wales',
      // Past cacheSeconds: due for a rebuild.
      JSON.stringify({ savedAt: 0, complete: true, partitions: complete }),
    ],
  ]);
  let builds = 0;
  let nextComplete = false;
  const source = createLibrarySource({
    entries: [epc],
    now: () => clock,
    fetchImpl: async () => ({ ok: false, status: 404 }),
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
    loadParquet: async () => ({
      ...(await import('./parquet.js')),
      buildPartitionIndex: async () => {
        builds += 1;
        return nextComplete
          ? { partitions: complete, complete: true, failed: 0 }
          : { partitions: [], complete: false, failed: 3 };
      },
      readGeoParquetFeatures: async () => [],
    }),
  });
  const box = [-1.5, 53.4, -1.4, 53.5];
  await source.loadDataset(epc, { bbox: box });
  assert.equal(builds, 1);
  // The old complete index stays stored; the incomplete one is not saved.
  assert.equal(
    JSON.parse(store.get('gev:library:index:epc-england-wales')).savedAt,
    0,
  );
  // Within the retry pause the incomplete result is reused, not rebuilt.
  await source.loadDataset(epc, { bbox: box });
  assert.equal(builds, 1);
  // After it, the index is rebuilt; a complete build is kept.
  clock += 6 * 60_000;
  nextComplete = true;
  await source.loadDataset(epc, { bbox: box });
  assert.equal(builds, 2);
  assert.equal(
    JSON.parse(store.get('gev:library:index:epc-england-wales')).savedAt,
    clock,
  );
});

test('a view that leaves touching partitions unread is partial', async () => {
  const index = Array.from({ length: 6 }, (_, n) => ({
    url: `https://h/P${n}.parquet`,
    bbox: [-1.5 - n / 100, 53.3, -1.4, 53.45],
  }));
  const point = (lon, lat) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { CURRENT_ENERGY_RATING: 'C', UPRN: '1' },
  });
  const reads = [];
  const source = createLibrarySource({
    entries: [epc],
    fetchImpl: async () => ({ ok: false, status: 404 }),
    storage: null,
    loadParquet: async () => ({
      ...(await import('./parquet.js')),
      buildPartitionIndex: async () => ({ partitions: index, complete: true }),
      readGeoParquetFeatures: async (entry, url) => {
        reads.push(url);
        return [point(-1.45, 53.4)];
      },
    }),
  });
  const result = await source.loadDataset(epc, {
    bbox: [-1.46, 53.39, -1.44, 53.41],
  });
  // The first batch of four found homes; two touching partitions stay unread.
  assert.equal(reads.length, 4);
  assert.equal(result.truncated, true);
});
