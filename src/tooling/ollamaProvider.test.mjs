import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { ollamaProxy } from '../../server/providers/ollama.js';
import { localProviderPlugins } from '../../server/providers/local.js';
import {
  resolveVadAsset,
  createVadAssetHandler,
} from '../../server/providers/ollama/vad-assets.js';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
    restart: async () => {},
  });
  return routes;
}

function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

test('the Ollama proxy installs the local voice routes in dev and preview without an HTTP server', () => {
  for (const preview of [false, true]) {
    const routes = install(ollamaProxy(), preview);
    for (const route of [
      '/api/openai/hud-summary',
      '/api/ollama/hud-summary',
      '/api/realtime/debug-log',
      '/api/voice/config',
      '/vendor/vad',
    ])
      assert.equal(typeof routes.get(route), 'function', route);
  }
});

test('voice config advertises the provider and socket path from the environment', async (t) => {
  env(t, 'AI_PROVIDER', 'ollama');
  env(t, 'VOICE_WS_PATH', '/api/voice/ws');
  const handler = install(ollamaProxy()).get('/api/voice/config');
  const headers = {};
  const body = await new Promise((resolve) =>
    handler(
      { method: 'GET', url: '/' },
      {
        setHeader: (k, v) => (headers[k.toLowerCase()] = v),
        end: (value) => resolve(JSON.parse(value)),
      },
    ),
  );
  assert.deepEqual(body, {
    provider: 'ollama',
    wsPath: '/api/voice/ws',
    wakeWord: null,
  });
  assert.match(headers['content-type'], /json/);
});

test('AI_PROVIDER selects the voice provider in the established plugin slot', (t) => {
  env(t, 'AI_PROVIDER', undefined);
  const names = () => localProviderPlugins().map((plugin) => plugin.name);
  const slot = names().indexOf('openai-realtime-proxy');
  assert.ok(slot > 0);
  assert.equal(names().includes('ollama-local-proxy'), false);
  env(t, 'AI_PROVIDER', 'ollama');
  assert.equal(names()[slot], 'ollama-local-proxy');
  assert.equal(names().includes('openai-realtime-proxy'), false);
  assert.equal(names().length, localProviderPlugins().length);
});

test('VAD runtime assets are whitelisted by name and served from node_modules', async () => {
  const sep = (value) => String(value).split(path.sep).join('/');
  assert.match(
    sep(resolveVadAsset('silero_vad_v5.onnx')),
    /@ricky0123\/vad-web\/dist\/silero_vad_v5\.onnx$/,
  );
  assert.match(
    sep(resolveVadAsset('ort-wasm-simd-threaded.mjs')),
    /onnxruntime-web\/dist\/ort-wasm-simd-threaded\.mjs$/,
  );
  assert.equal(resolveVadAsset('../../package.json'), null);
  assert.equal(resolveVadAsset('ort.min.js'), null);
  const handler = createVadAssetHandler();
  const served = await new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => (headers[k.toLowerCase()] = v),
      end: () => resolve({ status: res.statusCode, headers }),
    };
    handler({ method: 'HEAD', url: '/silero_vad_v5.onnx?import' }, res, () =>
      resolve({ status: 'next' }),
    );
  });
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'application/octet-stream');
  assert.ok(Number(served.headers['content-length']) > 1_000_000);
  const passed = await new Promise((resolve) =>
    createVadAssetHandler()(
      { method: 'GET', url: '/nope.txt' },
      { setHeader() {}, end: () => resolve('ended') },
      () => resolve('next'),
    ),
  );
  assert.equal(passed, 'next');
});

test('voice config refuses foreign origins so the wake-word key stays with served pages', async (t) => {
  env(t, 'AI_PROVIDER', 'ollama');
  env(t, 'HOST', undefined);
  env(t, 'PICOVOICE_ACCESS_KEY', 'secret-key');
  const handler = install(ollamaProxy()).get('/api/voice/config');
  const ask = (headers) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 200,
        setHeader() {},
        end: (value) => resolve({ status: res.statusCode, body: JSON.parse(value) }),
      };
      handler({ method: 'GET', url: '/', headers }, res);
    });
  const foreign = await ask({
    host: 'localhost:4173',
    origin: 'https://evil.example',
  });
  assert.equal(foreign.status, 403);
  assert.equal(JSON.stringify(foreign.body).includes('secret-key'), false);
  const local = await ask({
    host: 'localhost:4173',
    origin: 'http://localhost:4173',
  });
  assert.equal(local.status, 200);
  assert.equal(local.body.wakeWord.accessKey, 'secret-key');
});
