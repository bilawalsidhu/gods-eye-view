import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HUD_SUMMARY_UNCONFIGURED_CODE,
  isHudSummaryUnconfigured,
  keylessHudSummaryResponse,
} from './hudSummaryResponse.js';
import { openAiRealtimeProxy } from '../vite.config.js';

const UNCONFIGURED_PAYLOAD = {
  configured: false,
  code: HUD_SUMMARY_UNCONFIGURED_CODE,
  error: null,
  summary: null,
};

function installOpenAiRoutes() {
  const routes = new Map();
  openAiRealtimeProxy().configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes;
}

function invokeRoute(handler, { method = 'GET', url = '/', remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = {
      method,
      url,
      headers: {},
      socket: { remoteAddress },
    };
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: body ? JSON.parse(String(body)) : null,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('builds an HTTP-success capability response only for a blank key', () => {
  assert.deepEqual(keylessHudSummaryResponse(undefined), {
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.deepEqual(keylessHudSummaryResponse('  '), {
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.equal(keylessHudSummaryResponse('configured-key'), null);
});

test('recognizes only the exact deliberate no-key fallback response', () => {
  assert.equal(isHudSummaryUnconfigured(200, UNCONFIGURED_PAYLOAD), true);
  assert.equal(isHudSummaryUnconfigured(503, UNCONFIGURED_PAYLOAD), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    ...UNCONFIGURED_PAYLOAD,
    error: 'provider failed',
  }), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    ...UNCONFIGURED_PAYLOAD,
    summary: 'Unexpected provider output',
  }), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    ...UNCONFIGURED_PAYLOAD,
    configured: true,
  }), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    ...UNCONFIGURED_PAYLOAD,
    unexpected: true,
  }), false);
  assert.equal(isHudSummaryUnconfigured(200, {
    code: HUD_SUMMARY_UNCONFIGURED_CODE,
  }), false);
});

test('does not hide real provider and HTTP failures', () => {
  assert.equal(isHudSummaryUnconfigured(502, {
    code: HUD_SUMMARY_UNCONFIGURED_CODE,
  }), false);
  assert.equal(isHudSummaryUnconfigured(503, UNCONFIGURED_PAYLOAD), false);
  assert.equal(isHudSummaryUnconfigured(200, { error: 'provider failed' }), false);
});

test('the installed keyless HUD route stays successful after the voice quota is exhausted', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousLimit = process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
  process.env.OPENAI_API_KEY = '';
  process.env.GEV_RATELIMIT_OPENAI_PER_MIN = '1';
  try {
    const routes = installOpenAiRoutes();
    const token = routes.get('/api/realtime/token');
    const hud = routes.get('/api/openai/hud-summary');
    assert.equal(typeof token, 'function');
    assert.equal(typeof hud, 'function');

    const firstToken = await invokeRoute(token);
    const secondToken = await invokeRoute(token);
    assert.equal(firstToken.statusCode, 503);
    assert.deepEqual(firstToken.body, { error: 'OPENAI_API_KEY is not set' });
    assert.equal(secondToken.statusCode, 429);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await invokeRoute(hud, { method: 'POST' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.body, UNCONFIGURED_PAYLOAD);
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousLimit === undefined) delete process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
    else process.env.GEV_RATELIMIT_OPENAI_PER_MIN = previousLimit;
  }
});
