import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import Fastify from 'fastify';
import {
  COMPATIBILITY_ROUTE_CONTRACTS,
  registerCompatibilityRoutes,
} from '../dist/compatibility.js';
import { createConnectCompatibilityBridge } from '../compat/connect-adapter.mjs';
import {
  createCompatibilityBridge,
  RETAINED_CONTRACT_IDS,
} from '../compat/retained-api.mjs';

function compatibilityRequest(overrides = {}) {
  return {
    contractId: 'overpass',
    method: 'POST',
    url: '/api/overpass?test=1',
    query: { test: '1' },
    params: {},
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'data=node%281%2C2%2C3%2C4%29%3Bout%3B',
    correlationId: 'compat-test',
    remoteAddress: '192.0.2.10',
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('Fastify compatibility routing forwards headers/body and emits binary bridge responses', async (context) => {
  const app = Fastify();
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );
  await registerCompatibilityRoutes(app, {
    async handle(request) {
      assert.equal(request.contractId, 'overpass');
      assert.equal(request.body, 'data=forwarded');
      assert.equal(request.headers['x-compat-test'], 'yes');
      return {
        status: 207,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Upstream': 'mock',
          Connection: 'close',
        },
        body: Buffer.from([4, 3, 2, 1]),
      };
    },
  });
  await app.ready();
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/overpass',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-compat-test': 'yes',
    },
    payload: 'data=forwarded',
  });
  assert.equal(response.statusCode, 207);
  assert.equal(response.headers['x-upstream'], 'mock');
  assert.notEqual(response.headers.connection, 'close');
  assert.deepEqual(response.rawPayload, Buffer.from([4, 3, 2, 1]));
});

test('Connect adapter forwards request bodies and preserves status, headers, and bytes', async () => {
  const plugin = {
    configureServer(server) {
      server.middlewares.use('/api/overpass', async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        assert.equal(request.url, '/?test=1');
        assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
        response.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'X-Body': Buffer.concat(chunks).toString(),
          Connection: 'close',
        });

        test('CCTV media responses stream without compatibility buffering', async () => {
          const bridge = createConnectCompatibilityBridge({
            plugins: [{
              configureServer(server) {
                server.middlewares.use('/api/cctv', (_request, response) => {
                  response.writeHead(200, {
                    'Content-Type': 'video/mp4',
                    'Cache-Control': 'no-store',
                  });
                  response.write(Buffer.alloc(32, 1));
                  setTimeout(() => response.end(Buffer.alloc(32, 2)), 5);
                });
              },
            }],
            responseLimitBytes: 16,
            contractIds: ['cctv'],
          });

          const response = await bridge.handle(compatibilityRequest({
            contractId: 'cctv',
            method: 'GET',
            url: '/api/cctv/media/demo-camera',
            body: undefined,
          }));
          assert.equal(response.status, 200);
          assert.equal(response.headers['content-type'], 'video/mp4');
          const chunks = [];
          for await (const chunk of response.body) chunks.push(chunk);
          assert.equal(Buffer.concat(chunks).byteLength, 64);
        });
        Readable.from([Buffer.from([0, 1]), Buffer.from([2, 255])]).pipe(response);
      });
    },
  };
  const bridge = createConnectCompatibilityBridge({
    plugins: [plugin],
    responseLimitBytes: 1024,
    contractIds: ['overpass'],
  });

  const response = await bridge.handle(compatibilityRequest({ body: 'forwarded=yes' }));
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-type'], 'application/octet-stream');
  assert.equal(response.headers['x-body'], 'forwarded=yes');
  assert.equal(response.headers.connection, undefined);
  assert.deepEqual(response.body, Buffer.from([0, 1, 2, 255]));
});

test('retained production module covers every compatibility route and nothing removed', () => {
  assert.deepEqual(
    [...RETAINED_CONTRACT_IDS].sort(),
    COMPATIBILITY_ROUTE_CONTRACTS.map(({ id }) => id).sort(),
  );
  for (const removed of ['ais', 'radio', 'gbfs', 'launches', 'google-places', 'openai', 'key-setup']) {
    assert.equal(RETAINED_CONTRACT_IDS.includes(removed), false);
  }
});

test('retained bridge routes representative proxies with mocked upstreams only', async (context) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://api.adsb.lol/v2/mil') {
      return new Response(JSON.stringify({ ac: [{ hex: 'abc123' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith('https://api.open-meteo.com/v1/forecast?')) {
      return new Response(JSON.stringify({
        current: {
          time: '2026-09-04T10:00',
          temperature_2m: 20,
          apparent_temperature: 19,
          precipitation: 0,
          weather_code: 1,
          cloud_cover: 15,
          wind_speed_10m: 8,
          wind_direction_10m: 270,
          visibility: 24000,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected live-network attempt: ${url}`);
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const bridge = createCompatibilityBridge({ responseLimitBytes: 1024 * 1024 });
  const military = await bridge.handle(compatibilityRequest({
    contractId: 'adsblol-military',
    method: 'GET',
    url: '/api/adsblol/mil',
    body: undefined,
  }));
  assert.equal(military.status, 200);
  assert.equal(military.headers['x-ads-b-cache'], 'MISS');
  assert.deepEqual(JSON.parse(military.body.toString()), { ac: [{ hex: 'abc123' }] });

  const weather = await bridge.handle(compatibilityRequest({
    contractId: 'weather-effects',
    method: 'GET',
    url: '/api/weather-effects?latitude=60.1&longitude=24.9',
    body: undefined,
  }));
  assert.equal(weather.status, 200);
  assert.equal(weather.headers['x-weather-effects'], 'MISS');
  assert.equal(JSON.parse(weather.body.toString()).weather.weatherCode, 1);

  const rejected = await bridge.handle(compatibilityRequest({
    body: 'data=node%3Bout%3B',
  }));
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.toString(), /unbounded selector/);
  assert.equal(calls.length, 2);
});

test('Connect adapter enforces the configured response cap', async () => {
  const bridge = createConnectCompatibilityBridge({
    plugins: [{
      configureServer(server) {
        server.middlewares.use('/api/overpass', (_request, response) => {
          response.end(Buffer.alloc(32));
        });
      },
    }],
    responseLimitBytes: 16,
    contractIds: ['overpass'],
  });
  await assert.rejects(
    bridge.handle(compatibilityRequest()),
    (error) => error?.code === 'RESPONSE_TOO_LARGE',
  );
});

test('Connect adapter rejects promptly when the Fastify request aborts', async () => {
  const controller = new AbortController();
  const bridge = createConnectCompatibilityBridge({
    plugins: [{
      configureServer(server) {
        server.middlewares.use('/api/overpass', async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        });
      },
    }],
    responseLimitBytes: 1024,
    contractIds: ['overpass'],
  });
  const startedAt = Date.now();
  const pending = bridge.handle(compatibilityRequest({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.ok(Date.now() - startedAt < 250);
});
