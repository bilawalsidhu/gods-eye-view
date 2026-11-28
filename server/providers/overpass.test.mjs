// OVERPASS PROXY. Giant `out geom` payloads (region/state boundary pivots,
// multi-MB coastline geometry) are simplified server-side before caching and
// serving, and boundary-class queries (is_in / pivot) get a longer disk TTL.
// One predicate governs which upstream answers count as an answer, for cache
// reads, writes and stale fallback: a configured upstream's refusal is never
// data, and only operator-supplied alternatives may be tried. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import createViteConfig from '../standalone/vite.config.js';
import { isOverpassBoundaryQuery } from './overpass/query.js';
import { simplifyOverpassPayloadBody } from './overpass/geometry.js';
import { readOverpassDisk, resolveOverpassPreflight } from './overpass/cache.js';
import { fetchOverpassPayload, overpassPayloadIsData } from './overpass/transport.js';
import { resolveOverpassUpstreamTag } from './overpass/constants.js';

test('preflight checks memory, in-flight, then disk before consuming limiter quota', async () => {
  const key = 'normalized query';
  const fresh = { id: 'memory', status: 200, cachedAt: 900 };
  const joined = { id: 'inflight', status: 200, cachedAt: 950 };
  const disk = { id: 'disk', status: 200, cachedAt: 975 };
  let diskReads = 0;
  let limiterCalls = 0;
  const allowUpstream = () => { limiterCalls += 1; return true; };

  const memoryHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map([[key, fresh]]),
    inFlight: new Map([[key, Promise.resolve({ source: 'UPSTREAM', payload: joined })]]),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
    now: 1000,
    cacheMs: 200,
  });
  assert.equal(memoryHit.source, 'HIT');
  assert.equal(memoryHit.payload, fresh);
  assert.equal(diskReads, 0, 'memory hit must short-circuit before disk');
  assert.equal(limiterCalls, 0, 'memory hit must not consume limiter quota');

  const inFlightHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map([[key, { id: 'stale', status: 200, cachedAt: 0 }]]),
    inFlight: new Map([[key, Promise.resolve({ source: 'UPSTREAM', payload: joined })]]),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
    now: 1000,
    cacheMs: 200,
  });
  assert.equal(inFlightHit.source, 'INFLIGHT');
  assert.equal(inFlightHit.payload, joined);
  assert.equal(diskReads, 0, 'in-flight join must short-circuit before disk');
  assert.equal(limiterCalls, 0, 'in-flight join must not consume limiter quota');

  const diskMemory = new Map();
  const diskHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: diskMemory,
    inFlight: new Map(),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
  });
  assert.equal(diskHit.source, 'DISK');
  assert.equal(diskHit.payload, disk);
  assert.equal(diskReads, 1);
  assert.equal(limiterCalls, 0, 'disk hit must not consume limiter quota');
  const publishedDisk = await resolveOverpassPreflight({ cacheKey: key, memoryCache: diskMemory, inFlight: new Map(), now: 1000, readDisk: async () => { throw new Error('disk result was not published'); }, allowUpstream });
  assert.equal(publishedDisk.source, 'HIT');

  const upstreamMiss = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => { diskReads += 1; return null; },
    allowUpstream,
  });
  assert.equal(upstreamMiss.source, 'UPSTREAM');
  assert.equal(diskReads, 2, 'disk must be checked before upstream admission');
  assert.equal(limiterCalls, 1, 'only a complete cache miss consumes quota');

  const denied = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => null,
    allowUpstream: () => false,
  });
  assert.equal(denied.source, 'RATE_LIMITED');
});

test('preflight treats cached refusals as misses without spending extra quota', async () => {
  for (const invalid of [{ status: 406 }, { status: 200, runtimeError: true }]) {
    let admissions = 0;
    const result = await resolveOverpassPreflight({
      cacheKey: 'refused',
      memoryCache: new Map([['refused', { ...invalid, cachedAt: Date.now() }]]),
      inFlight: new Map(),
      readDisk: async () => ({ ...invalid, cachedAt: Date.now() }),
      allowUpstream: () => { admissions++; return true; },
    });
    assert.equal(result.source, 'UPSTREAM');
    assert.equal(admissions, 1);
  }
});

/** Synthetic dense ring: N points on a circle with sub-tolerance jitter. */
function denseRing(n, { latC = 37.5, lonC = 14.2, radiusDeg = 0.5 } = {}) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    // Jitter far below the simplification tolerance so the ring is genuinely
    // redundant — a correct simplifier should collapse most of it.
    const jitter = (i % 7) * 0.000004;
    pts.push({
      lat: latC + Math.sin(a) * (radiusDeg + jitter),
      lon: lonC + Math.cos(a) * (radiusDeg + jitter),
    });
  }
  pts.push({ ...pts[0] }); // closed ring
  return pts;
}

const TEST_OPTS = { minBytes: 0, minPoints: 200, toleranceDeg: 0.0004 };

test('simplify: giant way geometry is decimated, endpoints preserved', () => {
  const ring = denseRing(4000);
  const body = JSON.stringify({ elements: [{ type: 'way', id: 1, geometry: ring }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  const g = out.elements[0].geometry;
  assert.ok(g.length < ring.length * 0.5, `should shed most redundant points, got ${g.length}/${ring.length}`);
  assert.ok(g.length >= 16, `must keep enough points to stay a ring, got ${g.length}`);
  assert.deepEqual(g[0], ring[0]);
  assert.deepEqual(g[g.length - 1], ring[ring.length - 1]);
});

test('simplify: relation member geometries are decimated too', () => {
  const ring = denseRing(3000);
  const body = JSON.stringify({
    elements: [{
      type: 'relation',
      id: 2,
      members: [
        { type: 'way', role: 'outer', geometry: ring },
        { type: 'node', role: 'admin_centre' }, // no geometry — must survive untouched
      ],
    }],
  });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  assert.ok(out.elements[0].members[0].geometry.length < ring.length * 0.5);
  assert.equal(out.elements[0].members[1].geometry, undefined);
});

test('simplify: small geometries (building footprints) pass through untouched', () => {
  const square = [
    { lat: 30.27, lon: -97.74 }, { lat: 30.271, lon: -97.74 },
    { lat: 30.271, lon: -97.741 }, { lat: 30.27, lon: -97.741 },
    { lat: 30.27, lon: -97.74 },
  ];
  const body = JSON.stringify({ elements: [{ type: 'way', id: 3, geometry: square }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  assert.deepEqual(out.elements[0].geometry, square);
});

test('simplify: geometry stays within tolerance of the original shape', () => {
  const ring = denseRing(4000);
  const body = JSON.stringify({ elements: [{ type: 'way', id: 4, geometry: ring }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  const g = out.elements[0].geometry;
  // Every original vertex must lie near SOME kept vertex — a circle of kept
  // points at spacing s has every dropped point within ~s/2 along the arc, and
  // DP guarantees perpendicular deviation ≤ tolerance. Loose sanity bound: no
  // original point farther than 8× tolerance from the nearest kept point pair
  // is possible for a smooth ring; check a sampled subset for speed.
  for (let i = 0; i < ring.length; i += 97) {
    const p = ring[i];
    let best = Infinity;
    for (let j = 1; j < g.length; j++) {
      const d = pointSegDistDeg(p, g[j - 1], g[j]);
      if (d < best) best = d;
    }
    assert.ok(best <= TEST_OPTS.toleranceDeg * 1.01, `vertex ${i} deviates ${best} deg`);
  }
});

test('simplify: sub-threshold bodies and non-JSON pass through byte-identical', () => {
  const tiny = JSON.stringify({ elements: [{ type: 'way', geometry: denseRing(3000) }] });
  assert.equal(simplifyOverpassPayloadBody(tiny, { ...TEST_OPTS, minBytes: tiny.length + 1 }), tiny);
  const junk = 'this is not json {';
  assert.equal(simplifyOverpassPayloadBody(junk, TEST_OPTS), junk);
});

test('boundary-class queries detected for the long disk TTL', () => {
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];is_in(37.5,14.2)->.a;area.a["boundary"="administrative"]["admin_level"];out tags;',
  ), true);
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];area(3600039152)->.x;rel(pivot.x);out geom;',
  ), true);
  // The enclosing-compound sweep and road fetches keep the default TTL.
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];( way(around:1200,30.27,-97.74)["leisure"]["name"]; );out geom;',
  ), false);
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:12];way["highway"~"motorway|trunk"](30.1,-97.9,30.5,-97.5);out geom;',
  ), false);
});

/** Perpendicular distance (deg, planar approx) from p to segment a-b. */
function pointSegDistDeg(p, a, b) {
  const vx = b.lon - a.lon;
  const vy = b.lat - a.lat;
  const wx = p.lon - a.lon;
  const wy = p.lat - a.lat;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(wx, wy);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p.lon - b.lon, p.lat - b.lat);
  const t = c1 / c2;
  return Math.hypot(wx - t * vx, wy - t * vy);
}


test('cold disk lookup is single-flight through upstream publication and quota admission', async () => {
  const inFlight = new Map();
  let release;
  const disk = new Promise((resolve) => { release = resolve; });
  let reads = 0, admissions = 0, upstreams = 0;
  const payload = { status: 200, body: '{"elements":[]}' };
  const options = {
    cacheKey: 'cold', memoryCache: new Map(), inFlight,
    readDisk: () => { reads++; return disk; },
    allowUpstream: () => { admissions++; return true; },
    loadUpstream: async () => { upstreams++; return payload; },
  };
  const pending = Array.from({ length: 4 }, () => resolveOverpassPreflight(options));
  await Promise.resolve();
  assert.equal(inFlight.size, 1);
  release(null);
  const results = await Promise.all(pending);
  assert.equal(reads, 1);
  assert.equal(admissions, 1);
  assert.equal(upstreams, 1);
  assert.ok(results.every((result) => result.payload === payload));
  assert.deepEqual(results.map((result) => result.source), ['UPSTREAM', 'INFLIGHT', 'INFLIGHT', 'INFLIGHT']);
  assert.equal(inFlight.size, 0);
  const failed = { ...options, readDisk: async () => { throw new Error('disk failed'); } };
  const rejected = await Promise.allSettled([resolveOverpassPreflight(failed), resolveOverpassPreflight(failed)]);
  assert.ok(rejected.every((result) => result.status === 'rejected'));
  assert.equal(inFlight.size, 0);
  await resolveOverpassPreflight({ ...options, readDisk: async () => null });
  assert.equal(upstreams, 2, 'a rejected reservation does not poison the next retry');
});

test('a joined client retries admission with its own quota after another client is rate limited', async () => {
  const inFlight = new Map();
  let release;
  const disk = new Promise((resolve) => { release = resolve; });
  let reads = 0, upstreams = 0;
  const admissions = { a: 0, b: 0, c: 0 };
  const quota = { a: false, b: true, c: false };
  const payload = { status: 200, body: '{"elements":[]}' };
  const client = (name) => resolveOverpassPreflight({
    cacheKey: 'quota', memoryCache: new Map(), inFlight,
    readDisk: () => { reads++; return reads === 1 ? disk : null; },
    allowUpstream: () => { admissions[name]++; return quota[name]; },
    loadUpstream: async () => { upstreams++; return payload; },
  });
  // A (quota exhausted) owns the cold reservation; B (quota available) and
  // C (quota exhausted) join it while the disk lookup is pending.
  const pending = [client('a'), client('b'), client('c')];
  await Promise.resolve();
  assert.equal(inFlight.size, 1);
  release(null);
  const [a, b, c] = await Promise.all(pending);
  assert.equal(a.source, 'RATE_LIMITED', "A's own quota still rejects A");
  assert.equal(b.source, 'UPSTREAM', 'B is admitted on its own quota');
  assert.equal(b.payload, payload);
  assert.equal(c.source, 'INFLIGHT', "C coalesces onto B's admitted fetch");
  assert.equal(c.payload, payload);
  assert.deepEqual(admissions, { a: 1, b: 1, c: 0 });
  assert.equal(upstreams, 1);
  assert.equal(inFlight.size, 0);
});

const DATA = { status: 200, body: '{"elements":[]}' };

test('disk cache rejects old refusals for fresh and stale reads but preserves last-good data', async () => {
  const key = `overpass-cache-regression-${randomUUID()}`;
  const directory = path.join(process.cwd(), '.gev-cache', 'overpass');
  const file = path.join(
    directory,
    `${createHash('sha1').update(key).digest('hex')}.json`,
  );
  await mkdir(directory, { recursive: true });
  try {
    for (const refusal of [
      { status: 406 },
      { status: 429 },
      { status: 503 },
      { status: 200, rateLimited: true },
      { status: 200, runtimeError: true },
    ]) {
      await writeFile(
        file,
        JSON.stringify({ ...DATA, cachedAt: Date.now(), ...refusal }),
      );
      assert.equal(
        await readOverpassDisk(key, 60000),
        null,
        `fresh ${JSON.stringify(refusal)}`,
      );
      assert.equal(
        await readOverpassDisk(key, Infinity),
        null,
        `stale ${JSON.stringify(refusal)}`,
      );
    }
    const good = { ...DATA, cachedAt: Date.now() - 120000 };
    await writeFile(file, JSON.stringify(good));
    assert.equal(
      await readOverpassDisk(key, 60000),
      null,
      'expired good data misses normal TTL',
    );
    assert.deepEqual(
      await readOverpassDisk(key, Infinity),
      good,
      'last-good data survives an outage',
    );
    await writeFile(file, '{invalid');
    assert.equal(
      await readOverpassDisk(key, Infinity),
      null,
      'corrupt cache is ignored',
    );
  } finally {
    await unlink(file);
  }
});

// ── The predicate ────────────────────────────────────────────────────────────

test('only a 2xx that is neither rate-limited nor a runtime error is data', () => {
  assert.equal(overpassPayloadIsData({ status: 200 }), true);
  assert.equal(overpassPayloadIsData({ status: 204 }), true);

  // The measured refusal, and its neighbours. `< 500` admitted every one.
  for (const status of [400, 403, 406, 410, 429]) {
    assert.equal(
      overpassPayloadIsData({ status }),
      false,
      `${status} is not data`,
    );
  }
  assert.equal(overpassPayloadIsData({ status: 502 }), false);
  // A 200 can still not be data: Overpass reports runtime failures in the body.
  assert.equal(
    overpassPayloadIsData({ status: 200, runtimeError: true }),
    false,
  );
  assert.equal(
    overpassPayloadIsData({ status: 200, rateLimited: true }),
    false,
  );
  assert.equal(overpassPayloadIsData({}), false);
  assert.equal(overpassPayloadIsData(null), false);
});

// Configured endpoints replace defaults; refusals are sanitized and cooled down.
test('configured failover accepts empty data and keeps the application identity', async () => {
  const endpoints = [
    'https://first.example/query?secret=one',
    'http://localhost:12345/api',
  ];
  const seen = [];
  const payload = await fetchOverpassPayload('data=x', 1024, {
    endpoints,
    fetchImpl: async (url, options) => {
      seen.push(url);
      assert.equal(
        options.headers['User-Agent'],
        'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
      );
      assert.equal(options.redirect, 'error');
      return new Response(seen.length === 1 ? url : DATA.body, {
        status: seen.length === 1 ? 406 : 200,
      });
    },
  });
  assert.deepEqual(seen, endpoints);
  assert.equal(payload.body, DATA.body);
  assert.equal(payload.endpoint, 'configured');
});

test('406 and 429 honor Retry-After across different queries without more egress', async () => {
  for (const status of [406, 429]) {
    const endpoint = `https://cooldown-${status}.example/private?token=secret`;
    let count = 0,
      now = 1_000_000;
    const options = {
      endpoints: [endpoint],
      now: () => now,
      fetchImpl: async () => {
        count++;
        return new Response(`Refused ${endpoint}`, {
          status,
          headers: { 'Retry-After': '90' },
        });
      },
    };
    const first = await fetchOverpassPayload('first', 1024, options);
    assert.equal(first.status, status);
    assert.equal(first.retryAfterMs, 90_000);
    assert.doesNotMatch(JSON.stringify(first), /secret|https:/);
    now += 30_000;
    const next = await fetchOverpassPayload('different', 1024, options);
    assert.equal(count, 1);
    assert.equal(next.retryAfterMs, 60_000);
    now += 60_001;
    await fetchOverpassPayload('third', 1024, options);
    assert.equal(count, 2);
  }
});

test('HTTP-date Retry-After is respected, and absent delays use bounded backoff', async () => {
  let now = Date.parse('2026-09-23T12:00:00Z');
  const endpoint = 'https://dated.example/api';
  const payload = await fetchOverpassPayload('x', 1024, {
    endpoints: [endpoint],
    now: () => now,
    fetchImpl: async () =>
      new Response('busy', {
        status: 429,
        headers: { 'Retry-After': 'Wed, 23 Sep 2026 12:02:00 GMT' },
      }),
  });
  assert.equal(payload.retryAfterMs, 120_000);
  const options = {
    endpoints: ['https://bounded.example'],
    now: () => now,
    fetchImpl: async () => {
      throw new Error('https://bounded.example/secret');
    },
  };
  for (let i = 0; i < 8; i++) {
    const reply = await fetchOverpassPayload('x', 1024, options);
    assert.ok(reply.retryAfterMs <= 300_000);
    assert.doesNotMatch(reply.body, /secret|https:/);
    now += reply.retryAfterMs + 1;
  }
});

test('production reader rejects oversized, malformed and runtime-failure bodies', async () => {
  for (const [i, body] of [
    'x'.repeat(200),
    '{"remark":"runtime error: timed out","elements":[]}',
    'rate_limited',
    '{}',
    'not json',
  ].entries()) {
    const endpoints = [
      `https://bad-${i}.example/`,
      `https://good-${i}.example/`,
    ];
    const seen = [];
    const payload = await fetchOverpassPayload('data=x', 100, {
      endpoints,
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response(seen.length === 1 ? body : DATA.body);
      },
    });
    assert.equal(payload.body, DATA.body);
    assert.deepEqual(seen, endpoints);
  }
});

test('element data that mentions a failure phrase is data, and sets no cooldown', async () => {
  const names = ['Timed Out Escape Rooms', 'Runtime Error Bar', 'Out of Memory Lane', 'Too Many Requests Cafe', 'rate_limited'];
  for (const [i, name] of names.entries()) {
    const body = JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 1, lon: 2, tags: { name } }] });
    let count = 0;
    const options = { endpoints: [`https://phrase-${i}.example/`], fetchImpl: async () => {
      count++; return new Response(body);
    } };
    const payload = await fetchOverpassPayload('first', 1024, options);
    assert.equal(payload.status, 200, name);
    assert.ok(overpassPayloadIsData(payload), name);
    assert.ok(payload.body.includes(name), name);
    await fetchOverpassPayload('different', 1024, options);
    assert.equal(count, 2, name);
  }
  const remark = JSON.stringify({ elements: [], remark: 'runtime error: rate_limited' });
  const limited = await fetchOverpassPayload('x', 1024, { endpoints: ['https://remark.example/'],
    fetchImpl: async () => new Response(remark, { headers: { 'Retry-After': '90' } }) });
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfterMs, 90_000);
  const error = await fetchOverpassPayload('x', 1024, { endpoints: ['https://error.example/'],
    fetchImpl: async () => new Response('{"error":"rate_limited"}', { headers: { 'Retry-After': '120' } }) });
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 120_000);
});

test('caller cancellation aborts transport without cooling down the upstream', async () => {
  const endpoint = `https://cancelled-${randomUUID()}.example/api`;
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const first = fetchOverpassPayload('data=x', 1024, {
    endpoints: [endpoint],
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => {
      entered.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(first);

  let retried = 0;
  const next = await fetchOverpassPayload('data=y', 1024, {
    endpoints: [endpoint],
    fetchImpl: async () => {
      retried += 1;
      return new Response(DATA.body, { status: 200 });
    },
  });
  assert.equal(
    retried,
    1,
    'the next live caller is not held behind a cooldown',
  );
  assert.equal(next.body, DATA.body);
});

function proxyHandler() {
  const plugin = createViteConfig({ mode: 'test' }).plugins.find(
    (p) => p.name === 'overpass-proxy',
  );
  const routes = new Map();
  plugin.configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return routes.get('/api/overpass');
}

function invoke(handler, body) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  });
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({ status: this.status, headers: this.headers, body });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('coalesced outage callers both receive last-good data, never a cached refusal', async (t) => {
  const handler = proxyHandler();
  const prior = process.env.OVERPASS_UPSTREAMS;
  t.after(() => {
    if (prior === undefined) delete process.env.OVERPASS_UPSTREAMS;
    else process.env.OVERPASS_UPSTREAMS = prior;
  });
  for (const status of [406, 503, 429]) {
    process.env.OVERPASS_UPSTREAMS = `https://outage-${status}.example/api`;
    const query = `[out:json][timeout:12];node(around:10,30.27,-97.74)["name"="${randomUUID()}"];out;`;
    const body = `data=${encodeURIComponent(query)}`;
    const directory = path.join(process.cwd(), '.gev-cache', 'overpass');
    const file = path.join(
      directory,
      `${createHash('sha1').update(body).digest('hex')}.json`,
    );
    await mkdir(directory, { recursive: true });
    // Last-good data was fetched from the instance configured above, so it
    // carries that instance's tag the way the transport now writes it.
    const stale = {
      ...DATA,
      cachedAt: Date.now() - 40 * 86400000,
      upstreams: resolveOverpassUpstreamTag(),
    };
    await writeFile(file, JSON.stringify(stale));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let fetches = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      fetches++;
      entered.resolve();
      await release.promise;
      return new Response('upstream unavailable', { status });
    });
    try {
      const first = invoke(handler, body);
      await entered.promise;
      const second = invoke(handler, body);
      // The second request consumes its in-memory stream and joins the pending
      // promise before releasing upstream. No network or elapsed-time sleep.
      await new Promise((resolve) => setImmediate(resolve));
      release.resolve();
      for (const response of await Promise.all([first, second])) {
        assert.equal(
          response.status,
          200,
          `${status}: both callers use last-good data`,
        );
        assert.equal(response.body, DATA.body);
        assert.equal(response.headers['X-Overpass-Cache'], 'STALE');
      }
      assert.equal(fetches, 1, 'one shared configured request');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), stale);
    } finally {
      release.resolve();
      mock.mock.restore();
      await unlink(file);
    }
  }
});

test('a disk entry is not served after OVERPASS_UPSTREAMS is repointed', async (t) => {
  const prior = process.env.OVERPASS_UPSTREAMS;
  t.after(() => {
    if (prior === undefined) delete process.env.OVERPASS_UPSTREAMS;
    else process.env.OVERPASS_UPSTREAMS = prior;
  });
  const key = `overpass-upstream-switch-${randomUUID()}`;
  const directory = path.join(process.cwd(), '.gev-cache', 'overpass');
  const file = path.join(
    directory,
    `${createHash('sha1').update(key).digest('hex')}.json`,
  );
  await mkdir(directory, { recursive: true });
  try {
    // Written while one instance was configured...
    process.env.OVERPASS_UPSTREAMS = 'https://first.example/api/interpreter';
    const first = resolveOverpassUpstreamTag();
    await writeFile(
      file,
      JSON.stringify({ ...DATA, cachedAt: Date.now(), upstreams: first }),
    );
    assert.ok(await readOverpassDisk(key, 60000), 'its own entry is a hit');

    // ...is not an answer once the operator points at a different one, on the
    // stale path either: the key is the query alone, so it would otherwise hit.
    process.env.OVERPASS_UPSTREAMS = 'https://second.example/api/interpreter';
    assert.notEqual(resolveOverpassUpstreamTag(), first, 'tag follows the env');
    assert.equal(await readOverpassDisk(key, 60000), null, 'fresh read refused');
    assert.equal(
      await readOverpassDisk(key, Infinity),
      null,
      'stale read refused',
    );

    // With nothing configured there is no instance to contradict, and serving
    // last-good data is what the not-configured path exists for.
    delete process.env.OVERPASS_UPSTREAMS;
    assert.ok(await readOverpassDisk(key, Infinity), 'unconfigured still serves');
  } finally {
    await unlink(file);
  }
});
