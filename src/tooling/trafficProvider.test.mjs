// server/providers/traffic.js — the TomTom proxy's structured provider status.
//
// The serverless preview had the DATA LAYERS row read "Street Traffic — OFF"
// with nothing explaining why: the deployment has no TOMTOM_API_KEY and the
// proxy only knew how to say `hasKey:false` / a raw 502. Every route now
// answers with the shared provider status (server/providers/common/
// upstream.js) — `degraded` keyless, `stale` from last-good, `unavailable`
// with a reason, never a bare upstream code — and a Flow Segment probe proves
// the key (and samples live speed) without spending a tile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tomtomProxy } from '../../server/providers/traffic.js';

const KEY = 'fixture-key-9f3a';
const TILE = new Uint8Array([1, 2, 3, 4]);
const SEGMENT = {
  frc: 'FRC0',
  currentSpeed: 37,
  freeFlowSpeed: 55,
  currentTravelTime: 120,
  freeFlowTravelTime: 81,
  confidence: 0.9,
  roadClosure: false,
  coordinates: { coordinate: [{ latitude: 30.27, longitude: -97.74 }] },
};

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.ok(routes.has('/api/tomtom'));
  return async (url = '/', method = 'GET') => {
    const response = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get('/api/tomtom')({ url, method }, response);
    return response;
  };
}

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
}

/** No disk cache, no budget file, no real waits, a frozen (advanceable) clock. */
function isolate(t, env = {}) {
  environment(t, {
    TOMTOM_API_KEY: undefined,
    TOMTOM_DAILY_TILE_BUDGET: undefined,
    TOMTOM_DAILY_REQUEST_BUDGET: undefined,
    ...env,
  });
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(console, 'warn', () => {});
  const clock = { now: Date.UTC(2026, 8, 18, 12) };
  t.mock.method(Date, 'now', () => clock.now);
  return clock;
}

const json = (res) => JSON.parse(res.body);
const timeoutError = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  });
const proxy = () => tomtomProxy({ sleep: async () => {}, random: () => 0.5 });

test('keyless status reports a degraded TomTom provider with the key reason and touches nothing upstream', async (t) => {
  isolate(t);
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('keyless status must not fetch');
  });
  const request = install(proxy());
  const res = await request('/status?point=30.2672,-97.7431');
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.hasKey, false);
  assert.equal(body.budget, 40000);
  assert.equal(body.requestBudget, 2000);
  assert.equal(body.dailyCount, 0);
  assert.equal(body.requestCount, 0);
  assert.equal(body.date, '2026-09-18');
  assert.equal(body.flowSegment, undefined);
  assert.equal(body.provider.status, 'degraded');
  assert.equal(body.provider.source, 'TomTom');
  assert.equal(
    body.provider.error,
    'TOMTOM_API_KEY not set — flow colours are simulated on live OSM roads',
  );
  assert.equal(res.headers['x-provider-status'], 'degraded');
  assert.equal(res.headers['x-provider-source'], 'TomTom');
  assert.match(res.headers['x-provider-error'], /^TOMTOM_API_KEY not set/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-type'], /application\/json/);
  // The preview server mounts the same handler.
  const preview = install(proxy(), true);
  assert.equal(json(await preview('/status')).provider.status, 'degraded');
});

test('a keyed status with a scene point attaches the flow-segment probe and reuses its 60 s cache', async (t) => {
  const clock = isolate(t, { TOMTOM_API_KEY: KEY });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ flowSegmentData: SEGMENT });
  });
  const request = install(proxy());
  const res = await request('/status?point=30.2672,-97.7431');
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.hasKey, true);
  assert.deepEqual(body.flowSegment, {
    ok: true,
    currentSpeed: 37,
    freeFlowSpeed: 55,
    confidence: 0.9,
    roadClosure: false,
    fetchedAt: '2026-09-18T12:00:00.000Z',
    stale: false,
  });
  assert.equal(body.provider.status, 'live');
  assert.equal(body.provider.error, null);
  assert.equal(body.requestCount, 1);
  assert.equal(body.dailyCount, 0, 'a probe is not a tile');
  assert.equal(res.headers['x-provider-status'], 'live');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(calls.length, 1);
  const upstream = new URL(calls[0].url);
  assert.equal(upstream.origin, 'https://api.tomtom.com');
  assert.equal(
    upstream.pathname,
    '/traffic/services/4/flowSegmentData/absolute/10/json',
  );
  assert.equal(upstream.searchParams.get('point'), '30.27,-97.74');
  assert.equal(upstream.searchParams.get('unit'), 'KMPH');
  assert.equal(upstream.searchParams.get('key'), KEY);
  assert.match(calls[0].options.headers['User-Agent'], /ondemand-spatial/);
  // Status polls and the data route share one cached probe per 0.01° point.
  clock.now += 30_000;
  await request('/status?point=30.2699,-97.7401');
  const segment = await request('/flow-segment?point=30.2672,-97.7431');
  assert.equal(segment.statusCode, 200);
  assert.equal(segment.headers['x-tomtom-cache'], 'HIT');
  assert.equal(calls.length, 1, 'one upstream request for three answers');
  // A status without a point never probes; a nonsense point is ignored.
  assert.equal(json(await request('/status')).flowSegment, undefined);
  assert.equal(json(await request('/status?point=abc')).flowSegment, undefined);
  assert.equal(calls.length, 1);
  // Past the TTL the next status spends one request.
  clock.now += 31_000;
  assert.equal(json(await request('/status?point=30.2672,-97.7431')).requestCount, 2);
  assert.equal(calls.length, 2);
});

test('flow-segment: keyless is a structured 503, bad input is a 400, and a hit carries edge cache headers', async (t) => {
  const clock = isolate(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ flowSegmentData: SEGMENT });
  });
  const request = install(proxy());
  const keyless = await request('/flow-segment?point=30.2672,-97.7431');
  assert.equal(keyless.statusCode, 503);
  assert.deepEqual(json(keyless), {
    error: 'TOMTOM_API_KEY not set',
    provider: {
      status: 'unavailable',
      source: 'TomTom',
      fetchedAt: null,
      ageSec: null,
      error: 'TOMTOM_API_KEY not set — set it in Vercel to enable live traffic',
      count: null,
      detail: null,
    },
  });
  assert.equal(keyless.headers['x-provider-status'], 'unavailable');
  assert.equal(keyless.headers['cache-control'], 'no-store');
  assert.equal(calls, 0);
  process.env.TOMTOM_API_KEY = KEY;
  assert.equal((await request('/flow-segment')).statusCode, 400);
  assert.equal((await request('/flow-segment?point=91,0')).statusCode, 400);
  assert.equal((await request('/flow-segment?point=30,-97&zoom=x')).statusCode, 400);
  assert.equal((await request('/flow-segment?point=30,-97&unit=knots')).statusCode, 400);
  assert.equal(calls, 0);
  const live = await request('/flow-segment?point=30.2672,-97.7431&zoom=12&unit=mph');
  assert.equal(live.statusCode, 200);
  assert.deepEqual(json(live).flowSegmentData, SEGMENT);
  assert.equal(json(live).provider.status, 'live');
  assert.equal(json(live).provider.fetchedAt, '2026-09-18T12:00:00.000Z');
  assert.equal(live.headers['x-provider-status'], 'live');
  assert.equal(live.headers['x-provider-source'], 'TomTom');
  assert.equal(live.headers['x-provider-fetched-at'], '2026-09-18T12:00:00.000Z');
  assert.equal(
    live.headers['cache-control'],
    'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  );
  assert.equal(live.headers['x-tomtom-cache'], 'MISS');
  clock.now += 5_000;
  const again = await request('/flow-segment?point=30.2672,-97.7431&zoom=12&unit=MPH');
  assert.equal(again.headers['x-tomtom-cache'], 'HIT');
  assert.equal(json(again).provider.ageSec, 5);
  assert.equal(calls, 1, 'the second call is served from the point cache');
  // zoom / unit are part of the cache key.
  await request('/flow-segment?point=30.2672,-97.7431');
  assert.equal(calls, 2);
});

test('flow-segment: TomTom rate limits → last-good stale with Retry-After, or a structured 503 when nothing is cached', async (t) => {
  const clock = isolate(t, { TOMTOM_API_KEY: KEY });
  let mode = 'ok';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (mode === 'ok') return Response.json({ flowSegmentData: SEGMENT });
    return new Response('{"detailedError":{"code":"TooManyRequests"}}', {
      status: 429,
      headers: { 'Retry-After': '30' },
    });
  });
  const request = install(proxy());
  assert.equal((await request('/flow-segment?point=30.27,-97.74')).statusCode, 200);
  assert.equal(calls, 1);
  clock.now += 61_000;
  mode = 'limited';
  const stale = await request('/flow-segment?point=30.27,-97.74');
  assert.equal(stale.statusCode, 200);
  assert.deepEqual(json(stale).flowSegmentData, SEGMENT);
  assert.equal(json(stale).provider.status, 'stale');
  assert.equal(json(stale).provider.error, 'TomTom rate limited (retry in 30s)');
  assert.equal(json(stale).provider.ageSec, 61);
  assert.equal(stale.headers['x-provider-status'], 'stale');
  assert.equal(stale.headers['x-provider-age-sec'], '61');
  assert.equal(stale.headers['retry-after'], '30');
  assert.equal(stale.headers['cache-control'], 'no-store');
  assert.equal(stale.headers['x-tomtom-cache'], 'STALE');
  assert.equal(calls, 2, 'a 429 with a long Retry-After is not retried');
  const empty = await request('/flow-segment?point=48.85,2.35');
  assert.equal(empty.statusCode, 503);
  assert.equal(json(empty).error, 'TomTom rate limited (retry in 30s)');
  assert.equal(json(empty).provider.status, 'unavailable');
  assert.equal(empty.headers['retry-after'], '30');
  assert.equal(empty.headers['x-provider-status'], 'unavailable');
  // The status probe reports the same stale sample rather than a fault.
  const status = json(await request('/status?point=30.27,-97.74'));
  assert.equal(status.flowSegment.ok, true);
  assert.equal(status.flowSegment.stale, true);
  assert.equal(status.provider.status, 'stale');
  assert.equal(calls, 4);
});

test('flow-segment: an upstream timeout with nothing cached is a structured 503 — never a 502', async (t) => {
  isolate(t, { TOMTOM_API_KEY: KEY });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw timeoutError();
  });
  const request = install(proxy());
  const res = await request('/flow-segment?point=30.27,-97.74');
  assert.equal(res.statusCode, 503);
  assert.notEqual(res.statusCode, 502);
  assert.equal(
    json(res).error,
    'TomTom flow segment unreachable (timed out after 10 s)',
  );
  assert.equal(json(res).provider.status, 'unavailable');
  assert.equal(json(res).provider.source, 'TomTom');
  assert.equal(res.headers['x-provider-status'], 'unavailable');
  assert.match(res.headers['x-provider-error'], /timed out/);
  assert.equal(res.headers['retry-after'], undefined);
  assert.equal(calls, 2, 'one retry on a timeout');
  assert.equal(json(await request('/status')).requestCount, 2);
  // 5xx reads the same way, naming the code.
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 502 }));
  const gateway = await request('/flow-segment?point=48.85,2.35');
  assert.equal(gateway.statusCode, 503);
  assert.equal(gateway.headers['x-provider-status'], 'unavailable');
  assert.equal(json(gateway).error, 'TomTom flow segment unreachable (HTTP 502)');
  // A rejected point (no road nearby) is the caller's problem, not an outage.
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 400 }));
  const refused = await request('/flow-segment?point=0,0');
  assert.equal(refused.statusCode, 400);
  assert.equal(
    json(refused).error,
    'TomTom rejected the flow segment request (HTTP 400)',
  );
  const status = json(await request('/status?point=0,0'));
  assert.equal(status.flowSegment.ok, false);
  assert.equal(status.provider.status, 'live', 'a refused point does not degrade the feed');
});

test('a rejected key surfaces as a structured 503 from the probe, the segment route and the tiles', async (t) => {
  isolate(t, { TOMTOM_API_KEY: KEY });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{"detailedError":{"code":"Unauthorized"}}', {
      status: 401,
    });
  });
  const request = install(proxy());
  const status = json(await request('/status?point=30.27,-97.74'));
  assert.equal(status.hasKey, true);
  assert.deepEqual(status.flowSegment, {
    ok: false,
    error: 'TomTom rejected TOMTOM_API_KEY',
  });
  assert.equal(status.provider.status, 'degraded');
  assert.equal(status.provider.error, 'TomTom rejected TOMTOM_API_KEY');
  assert.equal(calls, 1, 'auth failures are never retried');
  const segment = await request('/flow-segment?point=48.85,2.35');
  assert.equal(segment.statusCode, 503);
  assert.equal(json(segment).error, 'TomTom rejected TOMTOM_API_KEY');
  assert.equal(json(segment).provider.status, 'unavailable');
  const tile = await request('/flow/12/935/1686.pbf');
  assert.equal(tile.statusCode, 503);
  assert.equal(json(tile).error, 'bad_key');
  assert.equal(json(tile).provider.status, 'unavailable');
  assert.equal(json(tile).provider.error, 'TomTom rejected TOMTOM_API_KEY');
  assert.equal(tile.headers['x-provider-status'], 'unavailable');
  assert.equal(tile.headers['x-provider-error'], 'TomTom rejected TOMTOM_API_KEY');
  assert.equal(calls, 3);
});

test('tiles: fresh tiles are live, a failed refresh serves last-good as stale, nothing cached is a structured 503', async (t) => {
  const clock = isolate(t, { TOMTOM_API_KEY: KEY });
  let mode = 'ok';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (mode === 'ok') return new Response(TILE);
    if (mode === 'timeout') throw timeoutError();
    return new Response('upstream down', { status: 502 });
  });
  const request = install(proxy());
  const miss = await request('/flow/12/935/1686.pbf');
  assert.equal(miss.statusCode, 200);
  assert.equal(miss.headers['x-tomtom-cache'], 'MISS');
  assert.equal(miss.headers['x-provider-status'], 'live');
  assert.equal(miss.headers['x-provider-source'], 'TomTom');
  assert.equal(miss.headers['x-provider-fetched-at'], '2026-09-18T12:00:00.000Z');
  assert.equal(
    miss.headers['cache-control'],
    'public, max-age=0, s-maxage=60, stale-while-revalidate=120',
  );
  assert.equal(miss.headers['content-type'], 'application/x-protobuf');
  assert.deepEqual([...miss.body], [...TILE]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.tomtom\.com\/traffic\/map\/4\/tile\/flow\/relative\/12\/935\/1686\.pbf\?key=/);
  const hit = await request('/flow/12/935/1686.pbf');
  assert.equal(hit.headers['x-tomtom-cache'], 'HIT');
  assert.equal(hit.headers['x-provider-status'], 'live');
  assert.equal(calls.length, 1);
  // Refresh fails with a 5xx (retried once) → the cached tile, marked stale.
  clock.now += 121_000;
  mode = 'down';
  const stale = await request('/flow/12/935/1686.pbf');
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.headers['x-tomtom-cache'], 'STALE-ERROR');
  assert.equal(stale.headers['x-provider-status'], 'stale');
  assert.equal(stale.headers['x-provider-age-sec'], '121');
  assert.equal(
    stale.headers['x-provider-error'],
    'TomTom flow tile unreachable (HTTP 502)',
  );
  assert.equal(stale.headers['cache-control'], 'no-store');
  assert.deepEqual([...stale.body], [...TILE]);
  assert.equal(calls.length, 3, 'one retry on a 5xx');
  // Nothing cached for a new tile → 503 with the reason, not the raw 502.
  const empty = await request('/flow/12/936/1686.pbf');
  assert.equal(empty.statusCode, 503);
  assert.deepEqual(json(empty).error, 'upstream');
  assert.equal(json(empty).provider.status, 'unavailable');
  assert.equal(json(empty).provider.source, 'TomTom');
  assert.equal(
    json(empty).provider.error,
    'TomTom flow tile unreachable (HTTP 502)',
  );
  assert.equal(empty.headers['x-provider-status'], 'unavailable');
  assert.equal(empty.headers['cache-control'], 'no-store');
  mode = 'timeout';
  const timedOut = await request('/flow/12/937/1686.pbf');
  assert.equal(timedOut.statusCode, 503);
  assert.equal(
    json(timedOut).provider.error,
    'TomTom flow tile unreachable (timed out after 10000 ms)',
  );
  assert.equal(calls.length, 7);
  // Every attempt was billed to the tile budget; none to the request budget.
  const status = json(await request('/status'));
  assert.equal(status.dailyCount, 7);
  assert.equal(status.requestCount, 0);
  assert.equal((await request('/flow/7/1/1.pbf')).statusCode, 400);
  assert.equal((await request('/nope')).statusCode, 404);
});

test('tiles: keyless is 503 no_key with the structured reason and never touches upstream', async (t) => {
  isolate(t);
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('keyless tiles must not fetch');
  });
  const request = install(proxy());
  const res = await request('/flow/12/935/1686.pbf');
  assert.equal(res.statusCode, 503);
  assert.equal(json(res).error, 'no_key');
  assert.equal(json(res).provider.status, 'unavailable');
  assert.equal(json(res).provider.source, 'TomTom');
  assert.equal(
    json(res).provider.error,
    'TOMTOM_API_KEY not set — set it in Vercel to enable live traffic',
  );
  assert.equal(res.headers['x-provider-status'], 'unavailable');
  assert.match(res.headers['x-provider-error'], /^TOMTOM_API_KEY not set/);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('budgets: the request cap serves last-good or a structured 503 and both counters reset at UTC midnight', async (t) => {
  const clock = isolate(t, {
    TOMTOM_API_KEY: KEY,
    TOMTOM_DAILY_REQUEST_BUDGET: '2',
    TOMTOM_DAILY_TILE_BUDGET: '1',
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    return String(url).includes('flowSegmentData')
      ? Response.json({ flowSegmentData: SEGMENT })
      : new Response(TILE);
  });
  const request = install(proxy());
  assert.equal(json(await request('/status')).requestBudget, 2);
  assert.equal(json(await request('/status')).budget, 1);
  assert.equal((await request('/flow-segment?point=30.27,-97.74')).statusCode, 200);
  assert.equal((await request('/flow-segment?point=48.85,2.35')).statusCode, 200);
  assert.equal(calls, 2);
  const capped = await request('/flow-segment?point=51.5,-0.12');
  assert.equal(capped.statusCode, 503);
  assert.equal(json(capped).error, 'TomTom daily request budget reached');
  assert.equal(json(capped).provider.status, 'unavailable');
  assert.equal(capped.headers['retry-after'], String(12 * 3600));
  assert.equal(calls, 2, 'over the cap nothing is fetched');
  clock.now += 61_000;
  const lastGood = await request('/flow-segment?point=30.27,-97.74');
  assert.equal(lastGood.statusCode, 200);
  assert.equal(lastGood.headers['x-provider-status'], 'stale');
  assert.equal(json(lastGood).provider.error, 'TomTom daily request budget reached');
  assert.equal(calls, 2);
  // Tiles keep their own governor: one fetch allowed, then 429 for a cold tile.
  assert.equal((await request('/flow/12/935/1686.pbf')).statusCode, 200);
  const tileCapped = await request('/flow/12/936/1686.pbf');
  assert.equal(tileCapped.statusCode, 429);
  assert.equal(json(tileCapped).error, 'budget');
  assert.equal(json(tileCapped).provider.error, 'TomTom daily tile budget reached');
  assert.equal(tileCapped.headers['x-provider-status'], 'unavailable');
  assert.ok(Number(tileCapped.headers['retry-after']) > 0);
  const status = json(await request('/status'));
  assert.equal(status.dailyCount, 1);
  assert.equal(status.requestCount, 2);
  // UTC rollover resets both counters.
  clock.now += 24 * 3600_000;
  const rolled = json(await request('/status'));
  assert.equal(rolled.dailyCount, 0);
  assert.equal(rolled.requestCount, 0);
  assert.equal(rolled.date, '2026-09-19');
  assert.equal((await request('/flow-segment?point=51.5,-0.12')).statusCode, 200);
  assert.equal(calls, 4);
});

test('no response ever echoes the key or an upstream URL', async (t) => {
  isolate(t, { TOMTOM_API_KEY: KEY });
  let mode = 'ok';
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'ok') return Response.json({ flowSegmentData: SEGMENT });
    if (mode === 'auth')
      return new Response(`unauthorized key ${KEY}`, { status: 401 });
    throw Object.assign(new Error(`connect ECONNREFUSED api.tomtom.com key=${KEY}`), {
      cause: { code: 'ECONNREFUSED' },
    });
  });
  const request = install(proxy());
  const responses = [await request('/status?point=30.27,-97.74')];
  mode = 'auth';
  responses.push(await request('/flow-segment?point=48.85,2.35'));
  responses.push(await request('/flow/12/935/1686.pbf'));
  mode = 'network';
  responses.push(await request('/flow-segment?point=51.5,-0.12'));
  responses.push(await request('/flow/12/936/1686.pbf'));
  for (const res of responses) {
    const surface = JSON.stringify([res.headers, String(res.body)]);
    assert.doesNotMatch(surface, new RegExp(KEY));
    assert.doesNotMatch(surface, /api\.tomtom\.com/);
  }
});
