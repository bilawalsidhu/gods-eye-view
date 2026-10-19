import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cachedModelBytes,
  downloadModel,
  modelBytes,
  modelCacheReader,
  selectedLocalModels,
} from './localModelCache.js';

function memoryCache() {
  const entries = new Map();
  return {
    match: async (url) => entries.get(url)?.clone(),
    delete: async (url) => entries.delete(url),
    async put(url, response) {
      const data = await response.arrayBuffer();
      entries.set(url, new Response(data, { headers: response.headers }));
    },
  };
}
const model = {
  files: [
    { url: 'https://example.test/config.json', size: 2 },
    { url: 'https://example.test/model.onnx', size: 4 },
  ],
};

test('downloads stream into cache and a second download makes no network requests', async () => {
  const cache = memoryCache();
  let requests = 0;
  const progress = [];
  const fetchImpl = async (url) => {
    requests++;
    return new Response(new Uint8Array(url.endsWith('.json') ? 2 : 4));
  };
  await downloadModel(model, {
    cache,
    fetchImpl,
    onProgress: (value) => progress.push(value),
  });
  assert.equal(await cachedModelBytes(model, cache), 6);
  assert.deepEqual(progress.at(-1), { loaded: 6, total: 6 });
  await downloadModel(model, { cache, fetchImpl });
  assert.equal(requests, 2);
});

test('interrupted downloads retain completed files but never mark partial weights as ready', async () => {
  const cache = memoryCache();
  await assert.rejects(
    downloadModel(model, {
      cache,
      fetchImpl: async () => new Response(new Uint8Array(2)),
    }),
    /incomplete/,
  );
  assert.equal(await cachedModelBytes(model, cache), 2);
  let requests = 0;
  await downloadModel(model, {
    cache,
    fetchImpl: async (url) => {
      requests++;
      assert.match(url, /model.onnx$/);
      return new Response(new Uint8Array(4));
    },
  });
  assert.equal(requests, 1);
  await cache.delete(model.files[1].url);
  assert.equal(await cachedModelBytes(model, cache), 2);
});

test('cancel aborts a streaming response and removes incomplete cache entries', async () => {
  const cache = memoryCache(),
    controller = new AbortController();
  await assert.rejects(
    downloadModel(
      { files: [model.files[1]] },
      {
        cache,
        signal: controller.signal,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new Uint8Array(2));
              },
              cancel() {},
            }),
          ),
        onProgress: ({ loaded }) => {
          if (loaded) controller.abort();
        },
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(await cachedModelBytes(model, cache), 0);
});

test('HTTP errors and oversized files never produce a ready model', async () => {
  const cache = memoryCache();
  await assert.rejects(
    downloadModel(model, {
      cache,
      fetchImpl: async () => new Response('no', { status: 403 }),
    }),
    /403/,
  );
  await assert.rejects(
    downloadModel(model, {
      cache,
      fetchImpl: async () => new Response(new Uint8Array(20)),
    }),
    /size/,
  );
  assert.equal(await cachedModelBytes(model, cache), 0);
});

test('all profiles pin actual browser model revisions including 8B external data shards', () => {
  for (const profile of ['low', 'balance', 'max']) {
    const models = selectedLocalModels({ profile, language: 'ru' });
    assert.deepEqual(
      models.map((item) => item.kind),
      ['chat', 'recognition', 'speech'],
    );
    for (const item of models) {
      assert.match(item.revision, /^[a-f0-9]{40}$/);
      assert.ok(modelBytes(item) > 0);
      assert.ok(
        item.files.every(
          (file) => file.size > 0 && file.url.includes(item.revision),
        ),
      );
    }
  }
  assert.ok(
    selectedLocalModels({ profile: 'max' })[0].files.some((file) =>
      file.url.endsWith('model_q2f16.onnx_data_1'),
    ),
  );
  assert.throws(() => selectedLocalModels({ profile: 'invalid' }));
});

test('tokenizer probes at main resolve to the selected cached revision without network', async () => {
  const cache = memoryCache();
  const model = selectedLocalModels({ profile: 'low' })[0];
  const file = model.files.find((file) =>
    file.url.endsWith('/tokenizer_config.json'),
  );
  await cache.put(
    file.url,
    Response.json(
      { tokenizer_class: 'Qwen2Tokenizer' },
      { headers: { 'X-GEV-Model-Size': String(file.size) } },
    ),
  );
  const reader = modelCacheReader(cache, [model]);
  const probe = file.url.replace(
    `/resolve/${model.revision}/`,
    '/resolve/main/',
  );
  assert.deepEqual(await (await reader.match(probe)).json(), {
    tokenizer_class: 'Qwen2Tokenizer',
  });
  assert.equal(await reader.match('https://example.com/model'), undefined);
});
