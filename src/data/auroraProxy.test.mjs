import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auroraProxy,
  AURORA_CACHE_TTL_MS,
  OVATION_URL,
} from '../../server/providers/aurora.js';

function payload() {
  const coordinates = [];
  for (let lon = 0; lon < 360; lon++)
    for (let lat = -90; lat <= 90; lat++) coordinates.push([lon, lat, 10]);
  return {
    'Observation Time': '2026-09-25T12:00:00Z',
    'Forecast Time': '2026-09-25T13:00:00Z',
    coordinates,
  };
}

function mount(provider) {
  let handler;
  provider.configureServer({
    middlewares: { use(_path, value) { handler = value; } },
  });
  return (url = '/forecast') =>
    new Promise((resolve, reject) => {
      const response = { status: 0, headers: {}, body: '' };
      handler(
        { method: 'GET', url },
        {
          writeHead(status, headers) {
            response.status = status;
            response.headers = headers;
          },
          end(body) {
            response.body = body;
            resolve(response);
          },
        },
      ).catch(reject);
    });
}

test('coalesces and caches the approximately five-minute OVATION generation', async () => {
  let calls = 0;
  let now = 1_000_000;
  const request = mount(
    auroraProxy({
      now: () => now,
      fetchImpl: async (url) => {
        calls += 1;
        assert.equal(url, OVATION_URL);
        return new Response(JSON.stringify(payload()), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    }),
  );
  const [a, b] = await Promise.all([request(), request()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(JSON.parse(a.body).stale, false);
  assert.equal(JSON.parse(b.body).stale, false);
  assert.equal(calls, 1);
  now += AURORA_CACHE_TTL_MS - 1;
  const fresh = await request();
  assert.equal(JSON.parse(fresh.body).stale, false);
  assert.equal(calls, 1);
  now += 1;
  const boundary = await request();
  assert.equal(JSON.parse(boundary.body).stale, false);
  assert.equal(calls, 2);
});

test('marks bounded last-good data stale after a failed refresh', async () => {
  let now = 2_000_000;
  let fail = false;
  const request = mount(
    auroraProxy({
      now: () => now,
      fetchImpl: async () => {
        if (fail) throw new Error('offline');
        return new Response(JSON.stringify(payload()), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    }),
  );
  await request();
  now += AURORA_CACHE_TTL_MS + 1;
  fail = true;
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).stale, true);
  const cooled = await request();
  assert.equal(cooled.status, 200);
  assert.equal(JSON.parse(cooled.body).stale, true);
});

test('returns an explicit unavailable forecast while an initial failure cools down', async () => {
  let calls = 0;
  const request = mount(
    auroraProxy({
      now: () => 3_000_000,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('offline');
      },
    }),
  );
  const first = await request();
  const second = await request();
  assert.equal(first.status, 503);
  assert.equal(second.status, 503);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(second.body), {
    schemaVersion: 1,
    product: 'ovation-aurora',
    unavailable: true,
    stale: true,
    reason: 'NOAA SWPC OVATION forecast unavailable',
  });
});

test('rejects unsupported methods and unknown proxy paths without fetching upstream', async () => {
  let calls = 0;
  const provider = auroraProxy({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(payload()), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  let handler;
  provider.configureServer({
    middlewares: { use(_path, value) { handler = value; } },
  });
  const request = (method, url) => new Promise((resolve, reject) => {
    const response = { status: 0, body: '' };
    handler({ method, url }, {
      writeHead(status) { response.status = status; },
      end(body) { response.body = body; resolve(response); },
    }).catch(reject);
  });
  assert.equal((await request('POST', '/forecast')).status, 405);
  assert.equal((await request('GET', '/unknown?x=1')).status, 404);
  assert.equal(calls, 0);
});