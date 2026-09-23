import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitService } from 'gods-eye-view/sources/transit-service';
import { createTransitSource } from 'gods-eye-view/layers/transit/source';

const GOOGLE_EXAMPLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

const request = (path, method = 'GET') => ({
  url: `https://example.test${path}`,
  method,
});

function routeCatalog() {
  return {
    data: [
      {
        type: 'route_pattern',
        id: 'Red-3-0',
        attributes: { typicality: 1, direction_id: 0, sort_order: 1 },
        relationships: {
          route: { data: { type: 'route', id: 'Red' } },
          representative_trip: { data: { type: 'trip', id: 't1' } },
        },
      },
    ],
    included: [
      {
        type: 'route',
        id: 'Red',
        attributes: { type: 1, color: 'DA291C', long_name: 'Red Line' },
      },
      {
        type: 'trip',
        id: 't1',
        relationships: { shape: { data: { type: 'shape', id: 's1' } } },
      },
      { type: 'shape', id: 's1', attributes: { polyline: GOOGLE_EXAMPLE } },
    ],
  };
}

function alertFeed() {
  return {
    header: { incrementality: 'FULL_DATASET', timestamp: 1_790_000_000 },
    entity: [
      {
        id: '1',
        alert: {
          effect: 'NO_SERVICE',
          effect_detail: 'SUSPENSION',
          header_text: {
            translation: [{ text: 'Red Line suspended', language: 'en' }],
          },
          informed_entity: [{ route_id: 'Red', route_type: 1 }],
        },
      },
    ],
  };
}

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });

test('routes and alerts resolve only for a feed that registers them', async (t) => {
  let calls = 0;
  const service = createTransitService({
    fetchImpl: async () => {
      calls++;
      throw new Error('unexpected');
    },
  });
  t.after(service.close);
  for (const path of [
    '/api/transit/routes/capmetro-austin',
    '/api/transit/alerts/hsl-helsinki',
    '/api/transit/routes/unknown',
    '/api/transit/routes/mbta/extra',
    '/api/transit/alerts/..%2Fmbta',
    '/api/transit/alerts/https%3A%2F%2Fevil.test',
    '/api/transit/routes/%E0%A4%A',
  ]) {
    assert.equal((await service.handle(request(path))).status, 404, path);
  }
  assert.equal(
    (await service.handle(request('/api/transit/routes/mbta', 'POST'))).status,
    405,
  );
  assert.equal(calls, 0);
});

test('only the registered URLs are fetched, JSON is asked for, and answers are cached', async (t) => {
  const seen = [];
  const service = createTransitService({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      if (url.startsWith('https://api-v3.mbta.com/route_patterns?'))
        return json(routeCatalog(), { headers: { ETag: '"r1"' } });
      if (url === 'https://cdn.mbta.com/realtime/Alerts_enhanced.json')
        return json(alertFeed());
      throw new Error(`unexpected ${url}`);
    },
  });
  t.after(service.close);

  const routes = await service.handle(request('/api/transit/routes/mbta'));
  assert.equal(routes.status, 200);
  assert.equal(routes.headers.get('x-gev-cache'), 'MISS');
  assert.equal(routes.headers.get('x-content-type-options'), 'nosniff');
  const routeBody = await routes.json();
  assert.equal(routeBody.count, 1);
  assert.equal(routeBody.routes[0].name, 'Red Line');
  assert.deepEqual(routeBody.routes[0].shapes, [GOOGLE_EXAMPLE]);

  const again = await service.handle(request('/api/transit/routes/mbta'));
  assert.equal(again.headers.get('x-gev-cache'), 'HIT');

  const alerts = await service.handle(request('/api/transit/alerts/mbta'));
  assert.equal(alerts.status, 200);
  const alertBody = await alerts.json();
  assert.equal(alertBody.count, 1);
  assert.equal(alertBody.alerts[0].kind, 'service');

  assert.equal(seen.length, 2, 'the cached route catalog was not re-fetched');
  for (const { init } of seen) {
    assert.equal(init.redirect, 'manual');
    assert.match(init.headers.Accept, /json/);
    assert.match(init.headers['User-Agent'], /gods-eye-view/);
  }
});

test('concurrent requests share one upstream fetch', async (t) => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = createTransitService({
    fetchImpl: async () => {
      calls++;
      await gate;
      return json(alertFeed());
    },
  });
  t.after(service.close);
  const pending = [1, 2, 3].map(() =>
    service.handle(request('/api/transit/alerts/mbta')),
  );
  release();
  const responses = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.deepEqual(responses.map((r) => r.headers.get('x-gev-cache')).sort(), [
    'INFLIGHT',
    'INFLIGHT',
    'MISS',
  ]);
});

test('a redirect off the registered origin is refused before it is followed', async (t) => {
  const seen = [];
  const service = createTransitService({
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.test/alerts.json' },
      });
    },
  });
  t.after(service.close);
  const response = await service.handle(request('/api/transit/alerts/mbta'));
  assert.equal(response.status, 504);
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
  assert.deepEqual(seen, [
    'https://cdn.mbta.com/realtime/Alerts_enhanced.json',
  ]);
});

test('non-JSON bodies and empty catalogs are faults, not answers', async (t) => {
  const bodies = [
    new Response('<html>maintenance</html>', { status: 200 }),
    json({ data: [], included: [] }),
  ];
  const service = createTransitService({
    fetchImpl: async () => bodies.shift(),
  });
  t.after(service.close);
  const notJson = await service.handle(request('/api/transit/alerts/mbta'));
  assert.equal(notJson.status, 502);
  const empty = await service.handle(request('/api/transit/routes/mbta'));
  assert.equal(empty.status, 502, 'no operator runs zero routes');
  const body = await empty.json();
  assert.equal(body.feedId, 'mbta');
  assert.equal('upstream' in body, false);
});

test('a failed refresh backs off and serves the last good copy when stale', async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  let fail = false;
  let calls = 0;
  const service = createTransitService({
    fetchImpl: async () => {
      calls++;
      if (fail) throw new Error('network down');
      return json(alertFeed());
    },
  });
  t.after(service.close);
  assert.equal(
    (await service.handle(request('/api/transit/alerts/mbta'))).status,
    200,
  );
  fail = true;
  now += 61_000;
  const stale = await service.handle(request('/api/transit/alerts/mbta'));
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('x-gev-cache'), 'STALE-ERROR');
  assert.equal(stale.headers.get('cache-control'), 'no-store');
  // Inside the cooldown the operator is not asked again.
  const before = calls;
  await service.handle(request('/api/transit/alerts/mbta'));
  assert.equal(calls, before);
  // Past the serve-stale window the proxy stops presenting old alerts.
  now += 31 * 60_000;
  const expired = await service.handle(request('/api/transit/alerts/mbta'));
  assert.notEqual(expired.status, 200);
});

test('source reads network resources and surfaces the server retry time', async () => {
  const calls = [];
  const source = createTransitSource({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/routes/mbta')) return Response.json({ routes: [] });
      return Response.json(
        { error: 'Transit alerts unavailable', retryInSec: 42 },
        { status: 503 },
      );
    },
  });
  assert.deepEqual(await source.requestNetwork('routes', 'mbta'), {
    routes: [],
  });
  await assert.rejects(source.requestNetwork('alerts', 'mbta'), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.retryInSec, 42);
    return true;
  });
  await assert.rejects(source.requestNetwork('vehicles', 'mbta'), TypeError);
  await assert.rejects(source.requestNetwork('routes', ''), TypeError);
  assert.deepEqual(calls, [
    '/api/transit/routes/mbta',
    '/api/transit/alerts/mbta',
  ]);
});
