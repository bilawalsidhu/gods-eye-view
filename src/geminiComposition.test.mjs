import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { localProviderPlugins } from '../server/providers/local.js';
import { standaloneVoiceTools } from '../server/standalone/voiceTools.js';
import {
  KEY_SETUP_KEYS,
  keySetupStatus,
  validateKeySetupUpdates,
  upsertDotenvValues,
} from './keySetupCore.mjs';

test('local hosts opt into Gemini explicitly and retain the default plugin order', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const defaults = localProviderPlugins().map((plugin) => plugin.name);
  assert.ok(!defaults.includes('gemini-live-proxy'));
  const enabled = localProviderPlugins({ gemini: {} }).map(
    (plugin) => plugin.name,
  );
  assert.equal(
    enabled.filter((name) => name === 'gemini-live-proxy').length,
    1,
  );
  assert.deepEqual(
    enabled.filter((name) => name !== 'gemini-live-proxy'),
    defaults,
  );
});

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`opted-in ${hook} locks the standalone catalog into the Gemini token`, async () => {
    const tools = standaloneVoiceTools();
    const calls = [];
    const plugin = localProviderPlugins({
      gemini: {
        tools,
        resolveApiKey: () => 'fixture-key',
        resolveModel: () => 'gemini-3.8-live',
        resolveHost: () => '',
        resolveAllowedHosts: () => '',
        resolveRateLimit: () => '0',
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          return Response.json({ name: 'auth_tokens/fixture' });
        },
      },
    }).find((entry) => entry.name === 'gemini-live-proxy');
    let handler;
    plugin[hook]({
      middlewares: {
        use(route, value) {
          assert.equal(route, '/api/gemini/token');
          handler = value;
        },
      },
    });
    const req = new PassThrough();
    req.method = 'POST';
    req.headers = {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'content-type': 'application/json',
    };
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = new EventEmitter();
    res.setHeader = () => {};
    res.end = (body) => {
      res.body = JSON.parse(body);
      res.writableEnded = true;
    };
    req.end('{}');
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    const locked = JSON.parse(calls[0].options.body).bidiGenerateContentSetup
      .tools[0].functionDeclarations;
    assert.deepEqual(
      locked.map(({ name }) => name),
      tools.map(({ name }) => name),
    );
    assert.deepEqual(
      locked.map(({ parametersJsonSchema }) => parametersJsonSchema),
      tools.map(({ parameters }) => parameters),
    );
    assert.ok(locked.every(({ behavior }) => behavior === 'BLOCKING'));
    assert.deepEqual(res.body.config.tools[0].functionDeclarations, locked);
    assert.ok(!JSON.stringify(res.body).includes('fixture-key'));
  });
}

test('Gemini key setup uses the existing server-only status and save contract', () => {
  const entry = KEY_SETUP_KEYS.find(({ id }) => id === 'gemini');
  assert.deepEqual(entry.envVars, ['GEMINI_API_KEY']);
  assert.ok(!entry.clientExposed);
  assert.equal(
    keySetupStatus({}).keys.find(({ id }) => id === 'gemini').set,
    false,
  );
  const env = { GEMINI_API_KEY: 'fixture-private-key' };
  const status = keySetupStatus(env);
  assert.equal(status.keys.find(({ id }) => id === 'gemini').set, true);
  assert.ok(!JSON.stringify(status).includes(env.GEMINI_API_KEY));
  assert.equal(validateKeySetupUpdates(env).ok, true);
  assert.match(
    upsertDotenvValues('GEMINI_API_KEY=old\n', env),
    /^GEMINI_API_KEY=fixture-private-key\n$/,
  );
  assert.equal(
    validateKeySetupUpdates({ VITE_GEMINI_API_KEY: 'fixture-private-key' }).ok,
    false,
  );
});
