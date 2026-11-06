import test from 'node:test';
import assert from 'node:assert/strict';
import { acartiaProxy, acartiaRetryCooldownMs } from './acartia.js';

const NOW = Date.parse('2026-11-04T18:05:00Z');
const sighting = (id = 'synthetic-1') => ({
  entry_id: id,
  latitude: 48.12345,
  longitude: -123.12345,
  created: '2026-11-04 17:00:00',
  type: 'Orca',
  no_sighted: '5',
  photo_url: 'https://provider.example/photos/synthetic.jpg',
  data_source_name: 'Synthetic Whale Network',
  data_source_entity: 'Community reports',
  trusted: true,
  data_source_comments: 'private-observer@example.test +1-555-000-0000',
});

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = acartiaProxy({ now: () => NOW, warn() {}, ...options });
  assert.equal(plugin.name, 'acartia');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(mount, callback) {
        assert.equal(mount, '/api/acartia');
        handler = callback;
      },
    },
  });
  return async (
    url = '/sightings',
    { method = 'GET', peer = 'local', headers = {} } = {},
  ) => {
    const res = {
      headers: {},
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      setHeader(key, value) {
        this.headers[key] = value;
      },
      end(value) {
        this.status ??= this.statusCode;
        this.body = JSON.parse(value);
      },
    };
    await handler(
      { url, method, headers, socket: { remoteAddress: peer } },
      res,
    );
    return res;
  };
}

test('cache stores only supported marine mammals inside the coverage box', async () => {
  const cache = new Map();
  const request = install({
    cache,
    fetchImpl: async () =>
      Response.json([
        sighting('orca'),
        { ...sighting('seal'), type: 'Harbor seal' },
        { ...sighting('unknown'), type: 'Unknown' },
        { ...sighting('fish'), type: 'Whale shark' },
        { ...sighting('outside'), latitude: 37.8 },
        { ...sighting('rounded-edge'), latitude: 45.49999 },
      ]),
  });
  const result = await request();
  assert.equal(result.status, 200);
  for (const rows of [result.body.rows, cache.get('sightings').value.rows]) {
    assert.deepEqual(
      rows.map((row) => [row.stableId, row.cetacean]),
      [
        ['acartia:orca', true],
        ['acartia:seal', false],
      ],
    );
  }
});

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: documented array is normalized and coarsened before caching`, async () => {
    const cache = new Map();
    let calls = 0;
    const request = install(
      {
        cache,
        fetchImpl: async (url, options) => {
          calls += 1;
          assert.equal(url, 'https://acartia.io/api/v1/sightings/current');
          assert.equal(options.redirect, 'error');
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.headers.Accept, 'application/json');
          assert.equal(
            options.headers['User-Agent'],
            'gods-eye-view-wildlife-sightings-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
          );
          return Response.json([sighting()]);
        },
      },
      hook,
    );
    assert.equal(calls, 0);
    assert.equal(cache.size, 0);
    const result = await request(
      '/sightings?url=https://attacker.example&latitude=1',
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.body.fetchedAt, NOW);
    assert.equal(result.body.rows[0].stableId, 'acartia:synthetic-1');
    assert.equal(result.body.rows[0].lat, 48.12);
    assert.equal(result.body.rows[0].lon, -123.12);
    assert.equal(result.body.rows[0].provider.name, 'Synthetic Whale Network');
    const retained = cache.get('sightings');
    assert.equal(retained.value.rows[0].lat, 48.12);
    assert.equal(retained.value.rows[0].lon, -123.12);
    for (const value of [result.body, [...cache.values()]])
      assert.doesNotMatch(
        JSON.stringify(value),
        /private-observer|555|data_source_comments|48\.12345|123\.12345/,
      );
    assert.equal(calls, 1);
  });
}

test('gate, method and fixed route run before cache or upstream', async () => {
  const cache = new Map();
  let calls = 0;
  const request = install({
    cache,
    fetchImpl: async () => {
      calls += 1;
      return Response.json([sighting()]);
    },
  });
  for (let i = 0; i < 65; i += 1) {
    assert.equal(
      (
        await request('/sightings', {
          headers: {
            host: 'localhost:5173',
            origin: 'https://foreign.example',
            'sec-fetch-site': 'cross-site',
          },
        })
      ).status,
      403,
    );
  }
  const method = await request('/sightings', { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.Allow, 'GET');
  for (const route of ['/', '/unknown', '/sightings/extra']) {
    const result = await request(route);
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'unknown_route');
  }
  assert.equal(calls, 0);
  assert.equal(cache.size, 0);
  const sameOrigin = await request('/sightings', {
    headers: {
      host: 'gev.example',
      origin: 'https://gev.example',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.9',
    },
  });
  assert.equal(sameOrigin.status, 200);
});

test('request 61 is locally limited even with a fresh cache', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls += 1;
      return Response.json([sighting()]);
    },
  });
  for (let i = 0; i < 60; i += 1) assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.equal(limited.headers['Retry-After'], '60');
  assert.equal(calls, 1);
});

test('one global snapshot single-flights and stays fresh for ten minutes', async () => {
  let at = NOW;
  let calls = 0;
  let release;
  const request = install({
    now: () => at,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return Response.json([sighting()]);
    },
  });
  const first = request();
  const concurrent = request();
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  release();
  assert.deepEqual((await first).body, (await concurrent).body);
  at += 599_999;
  await request();
  assert.equal(calls, 1);
  at += 1;
  await request();
  assert.equal(calls, 2);
});

test('a valid empty or fully filtered snapshot is a fresh success that clears old rows', async () => {
  for (const quiet of [
    [],
    [null],
    [{ ...sighting(), data_source_name: '' }],
    [{ ...sighting(), latitude: 37.8 }],
    [{ ...sighting(), type: 'Unknown' }],
  ]) {
    let at = NOW;
    let calls = 0;
    let empty = false;
    const cache = new Map();
    const request = install({
      cache,
      now: () => at,
      fetchImpl: async () => {
        calls += 1;
        return Response.json(empty ? quiet : [sighting()]);
      },
    });
    assert.equal((await request()).body.rows.length, 1);
    empty = true;
    at += 600_001;
    const result = await request();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { fetchedAt: at, rows: [] });
    assert.equal(result.headers['X-Data-Stale'], undefined);
    assert.equal(result.headers['Retry-After'], undefined);
    assert.deepEqual(cache.get('sightings').value.rows, []);
    // The quiet feed keeps the normal ten-minute cadence, not a failure retry.
    at += 599_999;
    assert.equal((await request()).status, 200);
    assert.equal(calls, 2);
    at += 1;
    await request();
    assert.equal(calls, 3);
    const cold = install({ fetchImpl: async () => Response.json(quiet) });
    const coldResult = await cold();
    assert.equal(coldResult.status, 200);
    assert.deepEqual(coldResult.body, { fetchedAt: NOW, rows: [] });
  }
});

test('an invented wrapped snapshot never replaces the cache', async () => {
  const bad = { results: [sighting()] };
  let at = NOW;
  let fail = false;
  const cache = new Map();
  const request = install({
    cache,
    now: () => at,
    fetchImpl: async () => Response.json(fail ? bad : [sighting()]),
  });
  const fresh = await request();
  const retained = cache.get('sightings');
  fail = true;
  at += 600_001;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, fresh.body.fetchedAt);
  assert.equal(cache.get('sightings'), retained);
  const coldCache = new Map();
  const cold = install({
    cache: coldCache,
    fetchImpl: async () => Response.json(bad),
  });
  const result = await cold();
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'acartia_unavailable');
  assert.equal(result.headers['Retry-After'], '15');
  assert.equal(coldCache.size, 0);
});

test('failure serves stale for at most 24 hours and never reports a cold success', async () => {
  let at = NOW;
  let fail = false;
  const request = install({
    now: () => at,
    fetchImpl: async () => {
      if (fail) throw new Error('private upstream detail');
      return Response.json([sighting()]);
    },
  });
  const first = await request();
  fail = true;
  at += 23 * 60 * 60_000 + 59 * 60_000;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  at += 2 * 60_000;
  const expired = await request();
  assert.equal(expired.status, 502);
  assert.deepEqual(expired.body, { error: 'acartia_unavailable' });
});

test('upstream 429 honors Retry-After, caps it, and spends no requests while cooling down', async () => {
  assert.equal(acartiaRetryCooldownMs('2', NOW), 5000);
  assert.equal(acartiaRetryCooldownMs('999999', NOW), 3_600_000);
  assert.equal(
    acartiaRetryCooldownMs(new Date(NOW + 120_000).toUTCString(), NOW),
    120_000,
  );
  assert.equal(acartiaRetryCooldownMs(null, NOW), 60_000);
  let at = NOW;
  let calls = 0;
  const warnings = [];
  const request = install({
    now: () => at,
    warn: (message) => warnings.push(message),
    fetchImpl: async () => {
      calls += 1;
      return new Response('limit', {
        status: 429,
        headers: { 'Retry-After': '999999' },
      });
    },
  });
  const first = await request();
  assert.equal(first.status, 429);
  assert.equal(first.body.error, 'acartia_unavailable');
  assert.equal(first.headers['Retry-After'], '3600');
  at += 5000;
  const cooling = await request();
  assert.equal(cooling.headers['Retry-After'], '3595');
  assert.equal(calls, 1);
  assert.equal(
    warnings.filter((message) => message.includes('capped')).length,
    1,
  );
  at += 3_600_000;
  await request();
  assert.equal(calls, 2);
  assert.equal(
    warnings.filter((message) => message.includes('capped')).length,
    1,
  );
});

test('upstream 429 also serves a prior snapshot stale', async () => {
  let at = NOW;
  let fail = false;
  let calls = 0;
  const request = install({
    now: () => at,
    fetchImpl: async () => {
      calls += 1;
      return fail
        ? new Response('limit', { status: 429 })
        : Response.json([sighting()]);
    },
  });
  const first = await request();
  fail = true;
  at += 600_001;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  at += 1000;
  assert.equal((await request()).body.stale, true);
  assert.equal(calls, 2);
});

test('bad JSON, 5xx and capped bodies start a 15 second failure cooldown', async () => {
  for (const bad of [
    () => new Response('{malformed'),
    () => new Response('private upstream message', { status: 503 }),
    () =>
      new Response('{}', {
        headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
      }),
  ]) {
    let at = NOW;
    let calls = 0;
    const request = install({
      now: () => at,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? bad() : Response.json([sighting()]);
      },
    });
    const first = await request();
    assert.equal(first.status, 502);
    assert.deepEqual(first.body, { error: 'acartia_unavailable' });
    assert.equal(first.headers['Retry-After'], '15');
    at += 14_999;
    assert.equal((await request()).headers['Retry-After'], '1');
    assert.equal(calls, 1);
    at += 1;
    assert.equal((await request()).status, 200);
    assert.equal(calls, 2);
  }
});
