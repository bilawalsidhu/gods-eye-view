import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cachedModelBytes,
  downloadModel,
  modelCacheReader,
} from './localModelCache.js';
import {
  MODEL_CHUNK_SIZE,
  deleteCachedModelFile,
  modelFileParts,
  readCachedModelFile,
} from './localModelStorage.js';

function memoryCache() {
  const entries = new Map();
  return {
    match: async (url) => entries.get(url)?.clone(),
    delete: async (url) => entries.delete(url),
    async put(url, response) {
      assert.equal(response.status, 200, 'Cache Storage rejects 206 responses');
      entries.set(
        url,
        new Response(await response.arrayBuffer(), {
          headers: response.headers,
        }),
      );
    },
  };
}
const file = {
  url: 'https://example.test/resolve/revision/model.onnx_data',
  size: MODEL_CHUNK_SIZE + 8,
};
const model = { revision: 'revision', files: [file] };
const parts = modelFileParts(file);
function rangeResponse(part) {
  return new Response(new Uint8Array(part.size).fill(part.start ? 2 : 1), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${part.start}-${part.end}/${file.size}`,
    },
  });
}

test('failed large-file download preserves completed parts and resumes at the missing range', async () => {
  const cache = memoryCache(),
    requested = [];
  await assert.rejects(
    downloadModel(model, {
      cache,
      retryDelays: [],
      fetchImpl: async (_url, options) => {
        requested.push(options.headers.Range);
        if (requested.length === 2) throw new TypeError('network disconnected');
        return rangeResponse(parts[0]);
      },
    }),
    /Saved parts are kept/,
  );
  assert.equal(await cachedModelBytes(model, cache), MODEL_CHUNK_SIZE);
  assert.equal(
    await readCachedModelFile(cache, file),
    undefined,
    'inference cannot read an incomplete model',
  );
  await downloadModel(model, {
    cache,
    fetchImpl: async (url, options) => {
      assert.equal(url, file.url);
      assert.equal(
        options.headers.Range,
        `bytes=${parts[1].start}-${parts[1].end}`,
      );
      return rangeResponse(parts[1]);
    },
  });
  assert.equal(await cachedModelBytes(model, cache), file.size);
  const response = await modelCacheReader(cache, [model]).match(file.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), String(file.size));
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, file.size);
  assert.equal(bytes[0], 1);
  assert.equal(bytes[MODEL_CHUNK_SIZE - 1], 1);
  assert.equal(bytes[MODEL_CHUNK_SIZE], 2);
  assert.equal(bytes.at(-1), 2);
  await downloadModel(model, {
    cache,
    fetchImpl: () => assert.fail('Completed parts must be reused'),
  });
  await deleteCachedModelFile(cache, file);
  assert.equal(await cachedModelBytes(model, cache), 0);
});

test('whole files from the previous cache format are reused without downloading or rewriting', async () => {
  const cache = memoryCache();
  await cache.put(
    file.url,
    new Response(new Uint8Array(file.size), {
      headers: { 'X-GEV-Model-Size': String(file.size) },
    }),
  );
  await downloadModel(model, {
    cache,
    fetchImpl: () => assert.fail('Legacy cache should remain valid'),
  });
  assert.equal(await cachedModelBytes(model, cache), file.size);
  assert.equal(
    (await readCachedModelFile(cache, file)).headers.get('X-GEV-Model-Size'),
    String(file.size),
  );
});

test('ignored and mismatched HTTP ranges cannot corrupt a cached model', async () => {
  for (const response of [
    new Response(new Uint8Array(8)),
    new Response(new Uint8Array(8), {
      status: 206,
      headers: { 'Content-Range': `bytes 1-8/${file.size}` },
    }),
  ]) {
    const cache = memoryCache();
    await assert.rejects(
      downloadModel(model, {
        cache,
        retryDelays: [],
        fetchImpl: async () => response,
      }),
      /incorrect download range/,
    );
    assert.equal(await cachedModelBytes(model, cache), 0);
  }
});

test('transient fetch errors are retried automatically with bounded attempts', async () => {
  const cache = memoryCache(),
    tiny = { files: [{ url: 'https://example.test/file', size: 4 }] };
  let requests = 0;
  await downloadModel(tiny, {
    cache,
    retryDelays: [0, 0],
    fetchImpl: async () => {
      if (++requests < 3) throw new TypeError('network disconnected');
      return new Response(new Uint8Array(4));
    },
  });
  assert.equal(requests, 3);
  assert.equal(await cachedModelBytes(tiny, cache), 4);
});

test('cancelling a later part preserves the first part and never marks partial data complete', async () => {
  const cache = memoryCache(),
    controller = new AbortController();
  await cache.put(
    parts[0].url,
    new Response(new Uint8Array(parts[0].size), {
      headers: { 'X-GEV-Model-Size': String(parts[0].size) },
    }),
  );
  await assert.rejects(
    downloadModel(model, {
      cache,
      signal: controller.signal,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new Uint8Array(2));
            },
          }),
          {
            status: 206,
            headers: {
              'Content-Range': `bytes ${parts[1].start}-${parts[1].end}/${file.size}`,
            },
          },
        ),
      onProgress: ({ loaded }) => {
        if (loaded > MODEL_CHUNK_SIZE) controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(await cachedModelBytes(model, cache), MODEL_CHUNK_SIZE);
  assert.equal(await cache.match(parts[1].url), undefined);
});

test('quota errors stop immediately and leave existing parts untouched', async () => {
  const cache = memoryCache();
  cache.put = async () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  let requests = 0;
  await assert.rejects(
    downloadModel(
      { files: [{ url: 'https://example.test/file', size: 4 }] },
      {
        cache,
        fetchImpl: async () => {
          requests++;
          return new Response(new Uint8Array(4));
        },
      },
    ),
    /Browser storage is full/,
  );
  assert.equal(requests, 1);
});
