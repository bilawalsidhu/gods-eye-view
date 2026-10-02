import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createSha256 } from './sha256.js';
import { teeWithBackpressure } from './streamTee.js';
import { openModelStream } from './workers/modelCache.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function chunkedSource(chunks, counter = { reads: 0 }) {
  let index = 0;
  return new ReadableStream(
    {
      pull(controller) {
        counter.reads++;
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

async function drain(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

function fakeCaches({ failOpen = false, failPut = false } = {}) {
  const stored = new Map();
  const cache = {
    async match(url) {
      return stored.has(url)
        ? new Response(stored.get(url), {
            headers: { 'content-length': String(stored.get(url).length) },
          })
        : undefined;
    },
    async put(url, response) {
      const body = Buffer.from(await response.arrayBuffer());
      if (failPut) throw new Error('QuotaExceededError');
      stored.set(url, body);
    },
  };
  return {
    stored,
    open: async () => {
      if (failOpen) throw new Error('SecurityError');
      return cache;
    },
  };
}

const payload = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const chunks = () =>
  Array.from({ length: 50 }, (_, i) =>
    payload.subarray(i * 100, i * 100 + 100),
  );
const fetchOf =
  (parts, length = payload.length) =>
  async () =>
    new Response(chunkedSource(parts), {
      headers: { 'content-length': String(length) },
    });

test('streaming SHA-256 matches the platform digest across chunk sizes', () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 1000, 4096 + 7]) {
    const bytes = Buffer.from(
      Array.from({ length: size }, (_, i) => (i * 7) % 256),
    );
    const hash = createSha256();
    for (let offset = 0; offset < size; offset += 13)
      hash.update(bytes.subarray(offset, offset + 13));
    assert.equal(hash.digest(), sha(bytes), `size ${size}`);
  }
});

test('the bounded tee never reads far ahead of a stalled consumer', async () => {
  const counter = { reads: 0 };
  const parts = Array.from({ length: 1000 }, () => new Uint8Array(1024));
  const { primary, secondary } = teeWithBackpressure(
    chunkedSource(parts, counter),
    { highWaterMark: 8 * 1024 },
  );
  const reader = primary.getReader();
  for (let i = 0; i < 20; i++) {
    const race = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(resolve, 20, 'blocked')),
    ]);
    if (race === 'blocked') break;
  }
  assert.ok(counter.reads <= 12, `read ${counter.reads} chunks`);
  const secondaryReader = secondary.getReader();
  await secondaryReader.cancel();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
  }
  assert.ok(total > 900 * 1024);
});

test('a download is cached once verified and later read from the cache', async () => {
  const caches = fakeCaches();
  const first = await openModelStream('m', {
    cachesApi: caches,
    fetchImpl: fetchOf(chunks()),
    sha256: sha(payload),
  });
  assert.equal(first.fromCache, false);
  assert.deepEqual(await drain(first.stream), payload);
  await first.finish();
  assert.deepEqual(await first.cacheWrite, { ok: true });
  const second = await openModelStream('m', {
    cachesApi: caches,
    fetchImpl: () => assert.fail('cached models are not downloaded'),
  });
  assert.equal(second.fromCache, true);
  assert.deepEqual(await drain(second.stream), payload);
});

test('altered or truncated downloads fail and are not cached', async () => {
  const caches = fakeCaches();
  const altered = await openModelStream('m', {
    cachesApi: caches,
    fetchImpl: fetchOf(chunks()),
    sha256: '0'.repeat(64),
  });
  await assert.rejects(drain(altered.stream), /integrity/);
  await assert.rejects(altered.finish(), /integrity/);
  assert.equal((await altered.cacheWrite).ok, false);
  const short = await openModelStream('m', {
    cachesApi: caches,
    fetchImpl: fetchOf(chunks().slice(0, 10)),
  });
  await assert.rejects(drain(short.stream), /ended early/);
  assert.equal((await short.cacheWrite).ok, false);
  assert.equal(caches.stored.size, 0);
});

test('without a usable cache the model still loads and says it was not kept', async () => {
  const closed = await openModelStream('m', {
    cachesApi: fakeCaches({ failOpen: true }),
    fetchImpl: fetchOf(chunks()),
  });
  assert.deepEqual(await drain(closed.stream), payload);
  assert.match((await closed.cacheWrite).error, /SecurityError/);
  const full = await openModelStream('m', {
    cachesApi: fakeCaches({ failPut: true }),
    fetchImpl: fetchOf(chunks()),
  });
  assert.deepEqual(await drain(full.stream), payload);
  assert.match((await full.cacheWrite).error, /Quota/);
});

test('a loader that stops early still gets the file verified and cached', async () => {
  const caches = fakeCaches();
  const opened = await openModelStream('m', {
    cachesApi: caches,
    fetchImpl: fetchOf(chunks()),
    sha256: sha(payload),
  });
  const reader = opened.stream.getReader();
  for (let i = 0; i < 5; i++) await reader.read();
  await opened.finish();
  assert.deepEqual(await opened.cacheWrite, { ok: true });
  assert.deepEqual(caches.stored.get('m'), payload);
});

test('an early-stopping loader of an altered file is told to discard it', async () => {
  const opened = await openModelStream('m', {
    cachesApi: fakeCaches({ failOpen: true }),
    fetchImpl: fetchOf(chunks()),
    sha256: '0'.repeat(64),
  });
  const reader = opened.stream.getReader();
  await reader.read();
  await assert.rejects(opened.finish(), /integrity/);
  assert.equal((await opened.cacheWrite).ok, false);
});

test('a cache write that fails without reading never stalls the loader', async () => {
  // Larger than the tee's 32 MiB read-ahead, so an unread branch would block.
  const big = Buffer.alloc(2 * 1024 * 1024, 7);
  const many = () => Array.from({ length: 40 }, () => big);
  const whole = Buffer.concat(many());
  const refusing = {
    open: async () => ({
      match: async () => undefined,
      put: async () => {
        throw new Error('QuotaExceededError');
      },
    }),
  };
  const full = await openModelStream('m', {
    cachesApi: refusing,
    fetchImpl: fetchOf(many(), whole.length),
    sha256: sha(whole),
  });
  assert.equal((await drain(full.stream)).length, whole.length);
  await full.finish();
  assert.match((await full.cacheWrite).error, /Quota/);

  const early = await openModelStream('m', {
    cachesApi: refusing,
    fetchImpl: fetchOf(many(), whole.length),
    sha256: sha(whole),
  });
  const reader = early.stream.getReader();
  await reader.read();
  await early.cacheWrite;
  await early.finish();
});
