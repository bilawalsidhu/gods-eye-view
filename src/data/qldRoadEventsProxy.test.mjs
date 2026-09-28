import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QLDTRAFFIC_PUBLIC_API_KEY,
  QLD_ROAD_EVENTS_POLICY,
  qldRoadEventsProxy,
  qldTrafficApiKey,
} from '../../server/providers/qldRoadEvents.js';

const collection = (id = 1) => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { id, event_type: 'Crash', road_summary: {} },
      geometry: { type: 'Point', coordinates: [153, -27.5] },
    },
  ],
});

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = qldRoadEventsProxy({ env: {}, ...options });
  assert.equal(plugin.name, 'qld-road-events');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/qld-road-events');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

test('the key defaults to the public QLDTraffic key; a sane override wins', () => {
  assert.equal(qldTrafficApiKey({}), QLDTRAFFIC_PUBLIC_API_KEY);
  assert.equal(
    qldTrafficApiKey({ QLDTRAFFIC_API_KEY: '  ' }),
    QLDTRAFFIC_PUBLIC_API_KEY,
  );
  assert.equal(
    qldTrafficApiKey({ QLDTRAFFIC_API_KEY: 'bad key&x=1' }),
    QLDTRAFFIC_PUBLIC_API_KEY,
  );
  assert.equal(
    qldTrafficApiKey({ QLDTRAFFIC_API_KEY: 'abcdef0123456789' }),
    'abcdef0123456789',
  );
});

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: fixed upstream, normalized payload, attribution`, async () => {
    const calls = [];
    const request = install(
      {
        now: () => 1000,
        env: { QLDTRAFFIC_API_KEY: 'registeredkey123' },
        fetchImpl: async (url, options) => {
          calls.push(new URL(url));
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.redirect, 'error');
          return Response.json(collection());
        },
      },
      hook,
    );
    const res = await request('/?url=https://evil.example');
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin, 'https://api.qldtraffic.qld.gov.au');
    assert.equal(calls[0].pathname, '/v2/events');
    assert.equal(calls[0].searchParams.get('apikey'), 'registeredkey123');
    assert.equal(calls[0].searchParams.get('url'), null);
    assert.equal(res.body.stale, false);
    assert.equal(res.body.fetchedAt, 1000);
    assert.match(res.body.attribution, /CC BY 4\.0/);
    assert.equal(res.body.events[0].id, '1');
    assert.equal(res.body.events[0].category, 'crash');
  });
}

test('snapshots are cached for the fresh window and shared by concurrent callers', async () => {
  let clock = 0;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      await gate;
      return Response.json(collection(calls));
    },
  });
  const pending = [request('/', 'GET', 'a'), request('/', 'GET', 'b')];
  release();
  const [a, b] = await Promise.all(pending);
  assert.equal(calls, 1, 'concurrent requests coalesce');
  assert.deepEqual(a.body, b.body);
  clock = QLD_ROAD_EVENTS_POLICY.freshMs - 1;
  await request();
  assert.equal(calls, 1, 'fresh cache is reused');
  clock = QLD_ROAD_EVENTS_POLICY.freshMs;
  const refreshed = await request();
  assert.equal(calls, 2);
  assert.equal(refreshed.body.events[0].id, '2');
});

test('upstream failures serve stale data, back off, then expire', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (fail) return new Response('down', { status: 503 });
      return Response.json(collection());
    },
  });
  await request();
  fail = true;
  clock = QLD_ROAD_EVENTS_POLICY.freshMs;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(calls, 2);
  clock += QLD_ROAD_EVENTS_POLICY.retryAfterFailureMs - 1;
  await request();
  assert.equal(calls, 2, 'no upstream retry inside the backoff window');
  clock = QLD_ROAD_EVENTS_POLICY.staleLimitMs + 1;
  const expired = await request();
  assert.equal(expired.status, 502);
  assert.equal(calls, 3);
});

test('a cold failure is a sanitized 502 and backs off', async () => {
  let calls = 0;
  const request = install({
    now: () => 0,
    fetchImpl: async () => {
      calls++;
      return Response.json({ not: 'geojson' });
    },
  });
  const first = await request();
  assert.equal(first.status, 502);
  assert.deepEqual(first.body, { error: 'qld_road_events_unavailable' });
  await request();
  assert.equal(calls, 1);
});

test('oversized upstream bodies are rejected', async () => {
  const request = install({
    now: () => 0,
    policy: { ...QLD_ROAD_EVENTS_POLICY, maxBytes: 64 },
    fetchImpl: async () => Response.json(collection()),
  });
  assert.equal((await request()).status, 502);
});

test('methods, routes and per-client rate limits are enforced', async () => {
  const request = install({
    now: () => 0,
    fetchImpl: async () => Response.json(collection()),
  });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/other')).status, 404);
  for (let i = 0; i < 30; i++)
    assert.equal((await request('/', 'GET', 'busy')).status, 200);
  const limited = await request('/', 'GET', 'busy');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  assert.equal((await request('/', 'GET', 'other')).status, 200);
});
