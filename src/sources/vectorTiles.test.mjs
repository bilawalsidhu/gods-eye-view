import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSharedDecodedTileCache,
  createVectorTileSource,
} from './vectorTiles.js';
const meta = { tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] };
const box = { south: 30.267, north: 30.268, west: -97.744, east: -97.743 };
const options = {
  tileJsonUrl: 'https://tiles.example/index.json',
  allowedOrigin: 'https://tiles.example',
  decode: () => [],
};

for (const failure of ['503', 'network', 'timeout'])
  test(`TileJSON ${failure} retries after cooldown and caches only success`, async () => {
    let calls = 0,
      time = 0;
    const source = createVectorTileSource({
      ...options,
      now: () => time,
      metadataCooldownMs: 5000,
      fetchImpl: async () => {
        calls++;
        if (calls > 1) return Response.json(meta);
        if (failure === '503') return new Response('', { status: 503 });
        throw failure === 'timeout'
          ? new DOMException('timeout', 'TimeoutError')
          : new TypeError('network');
      },
    });
    await assert.rejects(source.getMetadata(), { retryable: true });
    await assert.rejects(source.getMetadata(), { retryable: true });
    assert.equal(calls, 1);
    time = 5001;
    assert.equal((await source.getMetadata()).template, meta.tiles[0]);
    await source.getMetadata();
    assert.equal(calls, 2);
    source.clear();
    await source.getMetadata();
    assert.equal(calls, 3);
  });
for (const invalid of [
  { tiles: [] },
  { tiles: ['https://evil.example/{z}/{x}/{y}'] },
])
  test('invalid TileJSON is permanent only until clear', async () => {
    let calls = 0;
    const source = createVectorTileSource({
      ...options,
      fetchImpl: async () => {
        calls++;
        return Response.json(calls === 1 ? invalid : meta);
      },
    });
    await assert.rejects(source.getMetadata(), { retryable: false });
    await assert.rejects(source.getMetadata(), { retryable: false });
    assert.equal(calls, 1);
    source.clear();
    assert.equal((await source.getMetadata()).template, meta.tiles[0]);
  });
for (const declared of [true, false])
  test(`oversized ${declared ? 'declared' : 'streaming'} tile cancels body and aborts request before release`, async () => {
    let cancelled = 0,
      signal;
    const source = createVectorTileSource({
      ...options,
      template: meta.tiles[0],
      maxResponseBytes: 8,
      fetchImpl: async (_, opts) => {
        signal = opts.signal;
        return new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(16));
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: declared ? { 'content-length': '16' } : {} },
        );
      },
    });
    await assert.rejects(source.fetchBounds(box, { zoom: 14 }), {
      code: 'RESPONSE_TOO_LARGE',
    });
    assert.equal(cancelled, 1);
    assert.equal(signal.aborted, true);
    assert.equal(source.getStats().cacheEntries, 0);
  });

test('overlapping callers share XYZ; cancelling one keeps the other alive', async () => {
  let releaseBody,
    reads = 0,
    underlying;
  const source = createVectorTileSource({
    ...options,
    template: meta.tiles[0],
    fetchImpl: async (_, { signal }) => {
      reads++;
      underlying = signal;
      await new Promise((resolve) => {
        releaseBody = resolve;
      });
      return new Response(new Uint8Array([1]));
    },
  });
  const a = new AbortController(),
    b = new AbortController();
  const first = source.fetchBounds(box, { zoom: 12, signal: a.signal });
  const rejection = assert.rejects(first, { name: 'AbortError' });
  const second = source.fetchBounds(box, { zoom: 12, signal: b.signal });
  while (!releaseBody) await new Promise((resolve) => setTimeout(resolve, 0));
  a.abort();
  await rejection;
  assert.equal(underlying.aborted, false);
  releaseBody();
  assert.equal((await second).tiles.length, 1);
  assert.equal(reads, 1);
  await source.fetchBounds(box, { zoom: 12 });
  assert.equal(reads, 1);
});

test('final subscriber cancellation aborts the owned request; completed tiles publish before a straggler', async () => {
  let owned;
  const source = createVectorTileSource({
    ...options,
    template: meta.tiles[0],
    fetchImpl: (_, { signal }) =>
      new Promise((resolve, reject) => {
        owned = signal;
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  const controller = new AbortController();
  const pending = source.fetchBounds(box, {
    zoom: 12,
    signal: controller.signal,
  });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  while (!owned) await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await rejection;
  assert.equal(owned.aborted, true);
  let release,
    published = 0,
    requests = 0;
  const incremental = createVectorTileSource({
    ...options,
    template: meta.tiles[0],
    fetchImpl: async () => {
      if (++requests === 2)
        await new Promise((resolve) => {
          release = resolve;
        });
      return new Response(new Uint8Array([1]));
    },
  });
  const complete = incremental.fetchBounds(
    { ...box, east: -97.7 },
    { zoom: 12, onTile: () => published++ },
  );
  while (!published) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(published, 1);
  assert.equal(typeof release, 'function');
  release();
  await complete;
  assert.equal(published, 2);
});

test('polygon-selected tiles keep nearest-first order and cached revisits issue zero requests', async () => {
  const urls = [];
  const source = createVectorTileSource({
    ...options,
    template: 'https://tiles.example/{z}/{x}/{y}.pbf',
    tileJsonUrl: undefined,
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(new Uint8Array([1]));
    },
  });
  const tiles = [
    { z: 12, x: 935, y: 1685 },
    { z: 12, x: 936, y: 1685 },
  ];
  await source.fetchBounds(box, { zoom: 12, tiles });
  assert.ok(urls[0].endsWith('/12/935/1685.pbf'));
  assert.ok(urls[1].endsWith('/12/936/1685.pbf'));
  await source.fetchBounds(box, { zoom: 12, tiles: [...tiles].reverse() });
  assert.equal(urls.length, 2);
  await assert.rejects(
    source.fetchBounds(box, {
      zoom: 12,
      tiles: Array.from({ length: 17 }, (_, i) => ({
        z: 12,
        x: 935 + i,
        y: 1685,
      })),
    }),
    { code: 'TILE_VIEW_TOO_WIDE' },
  );
  assert.equal(
    urls.length,
    2,
    'over-budget selection is rejected before fetching',
  );
});

test('compatible consumers share bounded decoded ownership without sharing local lifetimes', async () => {
  const sharedDecodedCache = createSharedDecodedTileCache({
    maxEntries: 2,
    maxCacheBytes: 100,
  });
  let decodes = 0,
    requests = 0;
  const common = {
    ...options,
    template: meta.tiles[0],
    sharedDecodedCache,
    decode: () => {
      decodes++;
      return { roads: ['road'], outlines: ['outline'] };
    },
    fetchImpl: async () => {
      requests++;
      return new Response(new Uint8Array([1, 2, 3]));
    },
  };
  const roads = createVectorTileSource({
    ...common,
    selectDecoded: (value) => value.roads,
  });
  const outlines = createVectorTileSource({
    ...common,
    selectDecoded: (value) => value.outlines,
  });
  const tiles = [{ z: 14, x: 3743, y: 6745 }];
  assert.deepEqual((await roads.fetchBounds(box, { zoom: 14, tiles })).tiles, [
    ['road'],
  ]);
  roads.clear();
  assert.deepEqual(
    (await outlines.fetchBounds(box, { zoom: 14, tiles })).tiles,
    [['outline']],
  );
  assert.equal(requests, 1);
  assert.equal(decodes, 1);
  assert.deepEqual(sharedDecodedCache.stats(), { entries: 1, bytes: 12 });
});

test('shared decoded tiles are isolated from consumer mutation', async () => {
  const sharedDecodedCache = createSharedDecodedTileCache();
  let decodes = 0,
    requests = 0;
  const common = {
    ...options,
    template: meta.tiles[0],
    sharedDecodedCache,
    decode: () => {
      decodes++;
      return { roads: [{ name: 'Congress Avenue', coordinates: [[-97, 30]] }] };
    },
    selectDecoded: (value) => value.roads,
    fetchImpl: async () => {
      requests++;
      return new Response(new Uint8Array([1, 2, 3]));
    },
  };
  const first = createVectorTileSource(common);
  const second = createVectorTileSource(common);
  const third = createVectorTileSource(common);
  const tiles = [{ z: 14, x: 3743, y: 6745 }];
  const firstResult = await first.fetchBounds(box, { zoom: 14, tiles });
  firstResult.tiles[0][0].name = 'first mutation';
  firstResult.tiles[0][0].coordinates[0][0] = 0;

  const secondResult = await second.fetchBounds(box, { zoom: 14, tiles });
  assert.equal(secondResult.tiles[0][0].name, 'Congress Avenue');
  assert.equal(secondResult.tiles[0][0].coordinates[0][0], -97);
  secondResult.tiles[0][0].name = 'second mutation';
  secondResult.tiles[0][0].coordinates[0][0] = 1;

  const thirdResult = await third.fetchBounds(box, { zoom: 14, tiles });
  assert.equal(thirdResult.tiles[0][0].name, 'Congress Avenue');
  assert.equal(thirdResult.tiles[0][0].coordinates[0][0], -97);
  assert.equal(requests, 1);
  assert.equal(decodes, 1);
});

test('one source isolates in-flight and completed cache results from consumer mutation', async () => {
  const sharedDecodedCache = createSharedDecodedTileCache();
  let decodes = 0,
    requests = 0,
    releaseResponse;
  const responseReady = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const source = createVectorTileSource({
    ...options,
    template: meta.tiles[0],
    sharedDecodedCache,
    decode: () => {
      decodes++;
      return { roads: [{ name: 'Congress Avenue', coordinates: [[-97, 30]] }] };
    },
    selectDecoded: (value) => value.roads,
    fetchImpl: async () => {
      requests++;
      requestStarted();
      await responseReady;
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  const tiles = [{ z: 14, x: 3743, y: 6745 }];
  const firstPending = source.fetchBounds(box, { zoom: 14, tiles });
  await started;
  const concurrentPending = source.fetchBounds(box, { zoom: 14, tiles });
  releaseResponse();

  const firstResult = await firstPending;
  const concurrentResult = await concurrentPending;
  firstResult.tiles[0][0].name = 'first mutation';
  firstResult.tiles[0][0].coordinates[0][0] = 0;
  assert.equal(concurrentResult.tiles[0][0].name, 'Congress Avenue');
  assert.equal(concurrentResult.tiles[0][0].coordinates[0][0], -97);

  concurrentResult.tiles[0][0].name = 'concurrent mutation';
  concurrentResult.tiles[0][0].coordinates[0][0] = 1;
  const cachedResult = await source.fetchBounds(box, { zoom: 14, tiles });
  assert.equal(cachedResult.tiles[0][0].name, 'Congress Avenue');
  assert.equal(cachedResult.tiles[0][0].coordinates[0][0], -97);
  assert.equal(requests, 1);
  assert.equal(decodes, 1);
});

test('compatible consumers share one in-flight fetch and survive one consumer clearing', async () => {
  const sharedDecodedCache = createSharedDecodedTileCache();
  let requests = 0,
    decodes = 0,
    releaseResponse;
  const responseReady = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const common = {
    ...options,
    template: meta.tiles[0],
    sharedDecodedCache,
    decode: () => {
      decodes++;
      return { roads: ['road'], outlines: ['outline'] };
    },
    fetchImpl: async () => {
      requests++;
      requestStarted();
      await responseReady;
      return new Response(new Uint8Array([1, 2, 3]));
    },
  };
  const roads = createVectorTileSource({
    ...common,
    selectDecoded: (value) => value.roads,
  });
  const outlines = createVectorTileSource({
    ...common,
    selectDecoded: (value) => value.outlines,
  });
  const tiles = [{ z: 14, x: 3743, y: 6745 }];
  const roadResult = roads.fetchBounds(box, { zoom: 14, tiles });
  const roadRejected = assert.rejects(roadResult, { name: 'AbortError' });
  await started;
  const outlineResult = outlines.fetchBounds(box, { zoom: 14, tiles });
  await new Promise((resolve) => setImmediate(resolve));
  roads.clear();
  releaseResponse();
  await roadRejected;
  assert.deepEqual((await outlineResult).tiles, [['outline']]);
  assert.equal(requests, 1);
  assert.equal(decodes, 1);
});

test('shared ownership recharges materialized projections and evicts over budget', () => {
  const shared = createSharedDecodedTileCache({ maxCacheBytes: 100 });
  let resize,
    releases = 0;
  const decoded = {
    bindSharedCacheEntry(update) {
      resize = update;
    },
    releaseSharedCacheEntry() {
      releases++;
    },
  };
  const entry = shared.set('tile', decoded, 12);
  assert.deepEqual(shared.stats(), { entries: 1, bytes: 12 });
  resize(80);
  assert.deepEqual(shared.stats(), { entries: 1, bytes: 80 });
  resize(101);
  assert.deepEqual(shared.stats(), { entries: 0, bytes: 0 });
  assert.equal(entry.size, 101, 'the returned entry retains its real size');
  assert.equal(releases, 1, 'self-eviction releases decoded ownership once');
  shared.clear();
  assert.equal(releases, 1, 'clearing after eviction does not release twice');
});

test('shared clear releases entries and prevents a pending loader from refilling', async () => {
  const shared = createSharedDecodedTileCache();
  let releases = 0;
  const decoded = {
    releaseSharedCacheEntry() {
      releases++;
    },
  };
  shared.set('resident', decoded, 12);
  shared.clear();
  assert.deepEqual(shared.stats(), { entries: 0, bytes: 0 });
  assert.equal(releases, 1);

  let loaderStarted, resolveLoader;
  const started = new Promise((resolve) => {
    loaderStarted = resolve;
  });
  const loaderResult = new Promise((resolve) => {
    resolveLoader = resolve;
  });
  const pending = shared.load('late', null, async () => {
    loaderStarted();
    return loaderResult;
  });
  await started;
  resolveLoader({ value: {}, size: 16 });
  shared.clear();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(shared.stats(), { entries: 0, bytes: 0 });
});
