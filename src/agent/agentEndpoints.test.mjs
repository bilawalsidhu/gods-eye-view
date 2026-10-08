import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { typedAgentProxy } from '../../server/providers/agent.js';
import { localProviderPlugins } from '../../server/providers/local.js';
import {
  AGENT_DEFAULT_PER_MIN,
  agentRateLimiter,
} from '../../server/providers/agent/rate-limit.js';
import { resolvePerMinuteCap } from '../../server/providers/common/rate-limit.js';

/** Install a plugin and return the routes it registered. */
function install(plugin, hook = 'configureServer') {
  const routes = new Map();
  plugin[hook]({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
    httpServer: { once: () => {} },
  });
  return routes;
}

function request({
  method = 'GET',
  url = '/',
  headers = {},
  body = null,
} = {}) {
  const stream = Readable.from(body === null ? [] : [Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = { host: 'localhost:4173', ...headers };
  stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
    },
    end(payload) {
      this.body = payload ?? '';
    },
  };
}

test('the plugin registers the three endpoints on dev and on preview', () => {
  const expected = [
    '/api/agent/config',
    '/api/agent/models',
    '/api/agent/command',
  ];
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const routes = install(typedAgentProxy(), hook);
    assert.deepEqual([...routes.keys()], expected, `missing routes on ${hook}`);
  }
});

test('the app server composes the typed agent alongside the other providers', () => {
  const plugins = localProviderPlugins({ realtime: {} });
  const names = plugins.map((plugin) => plugin.name);
  assert.ok(names.includes('typed-agent-proxy'));
  // Registered before the API 404 plugin, which the standalone config installs
  // last; nothing here depends on ordering against the other providers.
  assert.equal(
    new Set(names).size,
    names.length,
    'a plugin name is duplicated',
  );
});

test('every endpoint refuses a cross-site browser request', async () => {
  const routes = install(typedAgentProxy());
  for (const [route, handler] of routes) {
    const res = response();
    await handler(
      request({
        url: route,
        method: route.endsWith('command') ? 'POST' : 'GET',
        headers: {
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
        body: '{}',
      }),
      res,
      () => assert.fail(`${route} passed a cross-site request through`),
    );
    assert.equal(res.statusCode, 403, `${route} admitted a cross-site request`);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

test('a same-origin browser request reaches the handler', async () => {
  const routes = install(typedAgentProxy());
  const res = response();
  await routes.get('/api/agent/config')(
    request({
      headers: {
        origin: 'http://localhost:4173',
        'sec-fetch-site': 'same-origin',
      },
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).providers.length >= 3);
});

test('the agent throttle defaults on, and only an explicit 0 disables it', () => {
  assert.equal(AGENT_DEFAULT_PER_MIN, 60);
  assert.equal(resolvePerMinuteCap(undefined, AGENT_DEFAULT_PER_MIN), 60);
  assert.equal(resolvePerMinuteCap('', AGENT_DEFAULT_PER_MIN), 60);
  assert.equal(resolvePerMinuteCap('120', AGENT_DEFAULT_PER_MIN), 120);
  // A typo must not quietly disarm the guard on an exposed server.
  assert.equal(resolvePerMinuteCap('6O', AGENT_DEFAULT_PER_MIN), 60);
  assert.equal(resolvePerMinuteCap('-5', AGENT_DEFAULT_PER_MIN), 60);
  assert.equal(resolvePerMinuteCap('0', AGENT_DEFAULT_PER_MIN), 0);
});

test('the limiter is built once and keeps its per-IP window across requests', () => {
  const first = agentRateLimiter({});
  assert.equal(agentRateLimiter({ GEV_RATELIMIT_AGENT_PER_MIN: '1' }), first);
  assert.equal(typeof first, 'function');
  assert.equal(first('127.0.0.1'), true);
});
