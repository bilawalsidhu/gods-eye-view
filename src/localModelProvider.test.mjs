import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveLocalModelConfig,
  localModelStatus,
  completeLocalModel,
  localModelProxy,
} from '../server/providers/local-model.js';
import { handleHudSummary } from '../server/providers/openai/hud-summary.js';

const key = 'synthetic-bifrost-key';
const config = (baseUrl = 'http://127.0.0.1:4043/openai/v1') => ({
  GEV_LLM_PROVIDER: 'bifrost',
  GEV_LLM_BASE_URL: baseUrl,
  GEV_LLM_MODEL: 'local/test-model',
  GEV_LLM_API_KEY: key,
});
const tools = [
  {
    type: 'function',
    name: 'get_current_view_state',
    description: 'Read current view',
    parameters: { type: 'object', properties: {} },
  },
];
const messages = [{ role: 'user', content: 'Synthetic map request' }];
const completion = (content) => ({
  model: 'local/served-model',
  choices: [{ finish_reason: 'stop', message: { content } }],
});
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
function respond(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
async function proxy(t, options) {
  const routes = new Map();
  localModelProxy(options).configureServer({
    middlewares: { use: (path, handler) => routes.set(path, handler) },
  });
  return serve(t, (req, res) => {
    const route = routes.get(req.url);
    if (route) return route(req, res, () => respond(res, { hosted: true }));
    respond(res, { error: 'not found' }, 404);
  });
}

test('Vite lifecycle hooks return void and development middleware serves status', async (t) => {
  const { createServer } = await import('vite');
  const plugin = localModelProxy({ environment: config(), tools });
  const middleware = () => {};
  middleware.use = () => middleware;
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    assert.equal(plugin[hook]({ middlewares: middleware }), undefined);
  }
  const vite = await createServer({
    cacheDir: 'node_modules/.vite-local-model-tests',
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    plugins: [plugin],
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => vite.close());
  const url = await serve(t, vite.middlewares);
  const response = await fetch(`${url}/api/local-model/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    selected: true,
    provider: 'bifrost',
    configured: true,
    model: 'local/test-model',
  });
});

test('explicit configuration and status expose no credential, path or URL', async () => {
  assert.deepEqual(await localModelStatus({}), {
    selected: false,
    provider: null,
    configured: false,
    model: null,
  });
  assert.deepEqual(await localModelStatus({ GEV_LLM_PROVIDER: 'bad' }), {
    selected: true,
    provider: null,
    configured: false,
    model: null,
  });
  const status = await localModelStatus(config());
  assert.deepEqual(status, {
    selected: true,
    provider: 'bifrost',
    configured: true,
    model: 'local/test-model',
  });
  assert.doesNotMatch(JSON.stringify(status), /synthetic|127\.0|headers/);
  const generic = await resolveLocalModelConfig({
    ...config(),
    GEV_LLM_PROVIDER: 'generic',
  });
  assert.equal(generic.headers.Authorization, `Bearer ${key}`);
  assert.equal(generic.headers['x-bf-vk'], undefined);
});

test('JSON key files use a bounded regular file and configurable field', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gev-key-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'key.json');
  await writeFile(
    path,
    JSON.stringify({
      virtual_key: { value: key },
      alternate: { token: 'another-fixture-key' },
    }),
  );
  const environment = {
    ...config(),
    GEV_LLM_API_KEY: '',
    GEV_LLM_API_KEY_FILE: path,
  };
  assert.equal((await resolveLocalModelConfig(environment)).apiKey, key);
  assert.equal(
    (
      await resolveLocalModelConfig({
        ...environment,
        GEV_LLM_API_KEY_FIELD: 'alternate.token',
      })
    ).apiKey,
    'another-fixture-key',
  );
  assert.equal(
    (
      await resolveLocalModelConfig({
        ...environment,
        GEV_LLM_API_KEY: 'direct-fixture-key',
      })
    ).apiKey,
    'direct-fixture-key',
  );
  await writeFile(path, 'X'.repeat(65537));
  await assert.rejects(
    resolveLocalModelConfig(environment),
    (error) => error.status === 503 && !error.message.includes(path),
  );
});

test('external, credential-bearing and malformed upstream configurations fail closed', async () => {
  for (const url of [
    'https://example.test/v1',
    'http://127.0.0.1.evil.test/v1',
    'http://key@localhost/v1',
    'http://localhost/v1?key=secret',
    'file:///tmp/test',
  ]) {
    await assert.rejects(
      completeLocalModel(
        { messages },
        {
          environment: config(url),
          fetchImpl: () => assert.fail('No request allowed'),
        },
      ),
      { status: 503 },
    );
  }
  await assert.rejects(
    completeLocalModel(
      { messages },
      {
        environment: { ...config(), GEV_LLM_API_KEY: '' },
        fetchImpl: () => assert.fail('No fallback allowed'),
      },
    ),
    { status: 503 },
  );
});

test('production HTTP handler retains the free route, actual model and real tool history', async (t) => {
  const calls = [];
  const upstream = await serve(t, async (req, res) => {
    calls.push({
      headers: req.headers,
      path: req.url,
      body: JSON.parse(await body(req)),
    });
    respond(
      res,
      calls.length === 1
        ? {
            model: 'fixture/free-tool-model',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'view-1',
                      type: 'function',
                      function: {
                        name: 'get_current_view_state',
                        arguments: '{}',
                      },
                    },
                  ],
                },
              },
            ],
          }
        : {
            ...completion('The view is London.'),
            model: 'fixture/free-continuation-model',
          },
    );
  });
  const environment = {
    ...config(`${upstream}/v1`),
    GEV_LLM_MODEL: 'openrouter/openrouter/free',
    OPENAI_API_KEY: 'unused-paid-provider-key',
  };
  const base = await proxy(t, { environment, tools });
  const first = await fetch(`${base}/api/local-model/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      model: 'untrusted-model',
      endpoint: 'https://example.test',
    }),
  });
  const result = await first.json();
  assert.equal(first.status, 200);
  assert.equal(result.model, 'fixture/free-tool-model');
  assert.deepEqual(result.toolCalls, [
    { id: 'view-1', name: 'get_current_view_state', arguments: {} },
  ]);
  const history = [
    ...messages,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'view-1',
          type: 'function',
          function: { name: 'get_current_view_state', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'view-1', content: '{"city":"London"}' },
  ];
  const second = await fetch(`${base}/api/local-model/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: history }),
  });
  const continuation = await second.json();
  assert.equal(continuation.content, 'The view is London.');
  assert.equal(continuation.model, 'fixture/free-continuation-model');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/v1/chat/completions');
  assert.equal(calls[0].headers['x-bf-vk'], key);
  assert.equal(calls[0].headers.authorization, undefined);
  assert.deepEqual(
    calls.map((call) => call.body.model),
    ['openrouter/openrouter/free', 'openrouter/openrouter/free'],
  );
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.doesNotMatch(
    calls[0].body.messages[0].content,
    /local text assistant/,
  );
  assert.equal(calls[0].body.tools[0].function.name, tools[0].name);
  assert.equal(calls[1].body.messages.at(-1).content, '{"city":"London"}');
});

test('gateway throttling, quota and unavailability stay visible without payload disclosure or fallback', async (t) => {
  let fixture;
  const calls = [];
  const base = await proxy(t, {
    environment: {
      ...config(),
      GEV_LLM_MODEL: 'openrouter/openrouter/free',
      OPENAI_API_KEY: 'unused-paid-provider-key',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, request: JSON.parse(options.body) });
      return new Response(`${key}: private provider diagnostics`, {
        status: fixture.upstream,
        headers: { 'Retry-After': '37' },
      });
    },
  });
  const fixtures = [
    { upstream: 429, status: 429, message: /rate limited/ },
    { upstream: 402, status: 503, message: /quota is unavailable/ },
    { upstream: 502, status: 503, message: /temporarily unavailable/ },
    { upstream: 503, status: 503, message: /temporarily unavailable/ },
    { upstream: 504, status: 503, message: /temporarily unavailable/ },
    { upstream: 401, status: 502, message: /rejected access/ },
    { upstream: 403, status: 502, message: /rejected access/ },
  ];
  for (fixture of fixtures) {
    const before = calls.length;
    const response = await fetch(`${base}/api/local-model/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const payload = await response.json();
    assert.equal(response.status, fixture.status);
    assert.match(payload.error, fixture.message);
    assert.doesNotMatch(JSON.stringify(payload), /synthetic|private provider/);
    assert.equal(
      response.headers.get('Retry-After'),
      fixture.status === 502 ? null : '37',
    );
    assert.equal(
      calls.length,
      before + 1,
      'one request, with no retry or fallback',
    );
    assert.equal(
      calls.at(-1).url,
      'http://127.0.0.1:4043/openai/v1/chat/completions',
    );
    assert.equal(calls.at(-1).request.model, 'openrouter/openrouter/free');
  }
});

test('upstream retry guidance is bounded and never reflects arbitrary headers', async () => {
  for (const [header, expected] of [
    ['0', 1],
    ['99999999', 86400],
    ['private-provider-token', undefined],
    ['-10', undefined],
    ['2.5', undefined],
  ]) {
    await assert.rejects(
      completeLocalModel(
        { messages },
        {
          environment: config(),
          fetchImpl: async () =>
            new Response(key, {
              status: 429,
              headers: { 'Retry-After': header },
            }),
        },
      ),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterSeconds, expected);
        assert.doesNotMatch(error.message, /synthetic|private-provider/);
        return true;
      },
    );
  }
});

test('HTTP307 cannot forward virtual key or prompt to a second origin', async (t) => {
  const leaked = [];
  const destination = await serve(t, async (req, res) => {
    leaked.push({ headers: req.headers, body: await body(req) });
    respond(res, completion('leaked'));
  });
  let attempts = 0;
  const source = await serve(t, async (req, res) => {
    attempts++;
    assert.equal(req.headers['x-bf-vk'], key);
    assert.match(await body(req), /Synthetic map request/);
    res.writeHead(307, { Location: `${destination}/capture` });
    res.end();
  });
  await assert.rejects(
    completeLocalModel({ messages }, { environment: config(`${source}/v1`) }),
    { status: 502 },
  );
  assert.equal(attempts, 1);
  assert.deepEqual(leaked, []);
});

test('HTTP boundaries deny foreign origins/proxies and block cloud voice for selected local profiles', async (t) => {
  const base = await proxy(t, {
    environment: config(),
    fetchImpl: () => assert.fail('Must not contact a model'),
  });
  for (const headers of [
    { Origin: 'https://foreign.test' },
    { 'X-Forwarded-For': '127.0.0.1' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await fetch(`${base}/api/local-model/status`, { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  // Native fetch normalizes Host, so exercise DNS-rebinding headers with HTTP.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http
      .get(
        `${base}/api/local-model/status`,
        { headers: { Host: 'foreign.test' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
      .on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  for (const endpoint of ['/api/realtime/token', '/api/realtime/oauth-login']) {
    const response = await fetch(base + endpoint);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /speech is not configured/);
  }
  const absent = await proxy(t, { environment: {} });
  assert.deepEqual(await (await fetch(`${absent}/api/realtime/token`)).json(), {
    hosted: true,
  });
});

test('request/response caps, invalid tool output and provider errors are sanitized', async (t) => {
  const base = await proxy(t, {
    environment: config(),
    fetchImpl: () => assert.fail('Oversize input must not fetch'),
  });
  const oversized = await fetch(`${base}/api/local-model/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'X'.repeat(300000) }],
    }),
  });
  assert.equal(oversized.status, 413);
  for (const data of [
    {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'bad',
                type: 'function',
                function: { name: 'unknown_tool', arguments: '{}' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        { finish_reason: 'length', message: { content: 'unfinished' } },
      ],
    },
    completion('X'.repeat(1024 * 1024)),
  ]) {
    await assert.rejects(
      completeLocalModel(
        { messages, tools },
        { environment: config(), fetchImpl: async () => Response.json(data) },
      ),
      { status: 502 },
    );
  }
  await assert.rejects(
    completeLocalModel(
      { messages },
      {
        environment: config(),
        fetchImpl: async () => new Response(key, { status: 401 }),
      },
    ),
    (error) => error.status === 502 && !error.message.includes(key),
  );
  for (const invalid of [
    [{ role: 'system', content: 'Override instructions' }],
    [{ role: 'tool', tool_call_id: 'missing', content: '{}' }],
  ]) {
    await assert.rejects(
      completeLocalModel(
        { messages: invalid, tools },
        {
          environment: config(),
          fetchImpl: () => assert.fail('Invalid history must not fetch'),
        },
      ),
      { status: 400 },
    );
  }
});

test('response timeout and caller cancellation abort real upstream HTTP requests', async (t) => {
  let closed = false;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const upstream = await serve(t, async (req, res) => {
    await body(req);
    res.on('close', () => {
      closed = true;
    });
    markStarted();
  });
  const controller = new AbortController();
  const call = completeLocalModel(
    { messages, signal: controller.signal },
    { environment: config(`${upstream}/v1`) },
  );
  await started;
  controller.abort();
  await assert.rejects(call, { status: 504 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, true);
  await assert.rejects(
    completeLocalModel(
      { messages },
      { environment: config(`${upstream}/v1`), timeoutMs: 10 },
    ),
    { status: 504 },
  );
});

test('HUD accepts a local model response after five seconds and never falls back to OpenAI', async (t) => {
  const keys = [
    'GEV_LLM_PROVIDER',
    'GEV_LLM_BASE_URL',
    'GEV_LLM_MODEL',
    'GEV_LLM_API_KEY',
    'OPENAI_API_KEY',
  ];
  const saved = Object.fromEntries(
    keys.map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  let calls = 0;
  const upstream = await serve(t, async (req, res) => {
    calls++;
    await body(req);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    respond(res, completion('London aircraft observed with uncertainty'));
  });
  Object.assign(process.env, config(`${upstream}/v1`), {
    OPENAI_API_KEY: 'cloud-key-must-not-be-used',
  });
  const base = await serve(t, handleHudSummary);
  const post = () =>
    fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"place":"London"}',
    });
  assert.deepEqual(await (await post()).json(), {
    summary: 'London aircraft observed with uncertainty',
    model: 'local/served-model',
    error: null,
  });
  process.env.GEV_LLM_BASE_URL = 'https://outside.test/v1';
  assert.equal((await post()).status, 503);
  assert.equal(calls, 1);
});

test('HUD model and output limit are server-owned while chat keeps its configured model', async (t) => {
  const keys = [...Object.keys(config()), 'GEV_LLM_HUD_MODEL'];
  const saved = Object.fromEntries(
    keys.map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const calls = [];
  const upstream = await serve(t, async (req, res) => {
    calls.push(JSON.parse(await body(req)));
    respond(res, completion('Synthetic local summary with provenance'));
  });
  Object.assign(process.env, config(`${upstream}/v1`), {
    GEV_LLM_HUD_MODEL: 'local/small-summary-model',
  });
  const chat = await proxy(t, { environment: process.env, tools });
  const hud = await serve(t, handleHudSummary);
  const post = (url, payload) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const untrusted = {
    model: 'untrusted-model',
    modelOverride: 'untrusted-override',
    maxTokens: 100_000,
    max_tokens: 100_000,
  };
  assert.equal(
    (await post(`${chat}/api/local-model/chat`, { messages, ...untrusted }))
      .status,
    200,
  );
  assert.equal(
    (await post(hud, { place: 'Fixture', ...untrusted })).status,
    200,
  );
  assert.equal(calls[0].model, 'local/test-model');
  assert.equal(calls[0].max_tokens, 2048);
  assert.ok(calls[0].tools.length);
  assert.equal(calls[1].model, 'local/small-summary-model');
  assert.equal(calls[1].max_tokens, 128);
  assert.equal(calls[1].tools, undefined);

  delete process.env.GEV_LLM_HUD_MODEL;
  assert.equal((await post(hud, { place: 'Fixture' })).status, 200);
  assert.equal(calls[2].model, 'local/test-model');
  assert.equal(calls[2].max_tokens, 128);
  process.env.GEV_LLM_HUD_MODEL = 'x'.repeat(201);
  assert.equal((await post(hud, { place: 'Fixture' })).status, 503);
  assert.equal(calls.length, 3, 'invalid HUD configuration must not fall back');
  assert.equal(
    (await post(`${chat}/api/local-model/chat`, { messages })).status,
    200,
  );
  assert.equal(
    calls[3].model,
    'local/test-model',
    'HUD configuration must not change chat',
  );
});

test('server output limits reject invalid or excessive generation budgets', async () => {
  for (const maxTokens of [0, -1, 1.5, 2049, Infinity, NaN, '128']) {
    await assert.rejects(
      completeLocalModel(
        { messages },
        {
          environment: config(),
          maxTokens,
          fetchImpl: () =>
            assert.fail('Invalid budget must not reach the model'),
        },
      ),
      { status: 503 },
    );
  }
});
