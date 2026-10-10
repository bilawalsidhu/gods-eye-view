import test from 'node:test';
import assert from 'node:assert/strict';
import { createVectorTileSource } from './vectorTiles.js';
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

test('a configured tileJsonUrl sets the tile origin, and a foreign tiles[0] is still refused', async () => {
  // Without an explicit allowedOrigin the mirror's own TileJSON is honoured…
  const mirrored = createVectorTileSource({
    tileJsonUrl: 'http://127.0.0.1:12348/planet',
    decode: () => [],
    fetchImpl: async () =>
      Response.json({ tiles: ['http://127.0.0.1:12348/p/{z}/{x}/{y}.pbf'] }),
  });
  assert.equal(
    (await mirrored.getMetadata()).template,
    'http://127.0.0.1:12348/p/{z}/{x}/{y}.pbf',
  );

  // …while a TileJSON that names a different host is refused rather than
  // silently fetched, which is what the origin check is for.
  const foreign = createVectorTileSource({
    tileJsonUrl: 'http://127.0.0.1:12348/planet',
    decode: () => [],
    fetchImpl: async () =>
      Response.json({
        tiles: ['https://tiles.example/planet/{z}/{x}/{y}.pbf'],
      }),
  });
  await assert.rejects(foreign.getMetadata(), { retryable: false });
});

test('an explicit allowedOrigin still wins over the one derived from tileJsonUrl', async () => {
  const source = createVectorTileSource({
    tileJsonUrl: 'http://127.0.0.1:12348/planet',
    allowedOrigin: 'https://tiles.example',
    decode: () => [],
    fetchImpl: async () =>
      Response.json({
        tiles: ['https://tiles.example/planet/{z}/{x}/{y}.pbf'],
      }),
  });
  assert.equal(
    (await source.getMetadata()).template,
    'https://tiles.example/planet/{z}/{x}/{y}.pbf',
  );
});
