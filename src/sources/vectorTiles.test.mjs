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
