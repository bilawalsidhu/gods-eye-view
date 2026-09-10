import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './firms.js';

const url = (query = '') => `https://example.com/api/firms${query}`;
const ctx = (request, env = {}) => ({ request, env });

/** Mirror of the handler's Cache API key (CACHE_VERSION + mode). */
const PUBLIC_CACHE_URL = 'https://example.com/api/firms?v2-contract&mode=public';

/**
 * Minimal Cache API stand-in: Node does not expose `caches` (and Workers
 * implementations differ), so the cache-path tests inject this explicitly and
 * every test restores the original global afterwards.
 */
class FakeCache {
  constructor() { this.map = new Map(); }
  async put(request, response) { this.map.set(request.url, response.clone()); }
  async match(request) { return this.map.get(request.url) ?? null; }
}

const ORIGINAL_CACHES = globalThis.caches;
function setCache(fake) { globalThis.caches = fake ? { default: fake } : undefined; }

test.after(() => { globalThis.caches = ORIGINAL_CACHES; });

/** Replace global fetch, route every call through `impl`, restore afterwards. */
function stubFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (fetchUrl, init) => {
    const entry = { url: String(fetchUrl), init };
    calls.push(entry);
    return impl(entry);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// --- Fixtures ---------------------------------------------------------------
// VIIRS NRT header order (column order differs between products — the parser
// indexes by header name, so a shuffled order here also exercises that).

const FIRMS_STAMP = (hoursAgo) => {
  const d = new Date(Date.now() - hoursAgo * 3600_000);
  const hhmm = String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0');
  // acq_time is unpadded upstream ("45" = 00:45Z) — mimic that.
  return { date: d.toISOString().slice(0, 10), time: String(Number(hhmm)) };
};

const FIRMS_ROW = ({ lat = 30.25, lon = -97.75, hoursAgo = 1, sat = 'SUOMI-VIIRS', conf = 'nominal', frp = 12.5 } = {}) => {
  const stamp = FIRMS_STAMP(hoursAgo);
  return [
    lat.toFixed(4), lon.toFixed(4), '341.2', '1.2', '1.1',
    stamp.date, stamp.time, sat, 'viirs', conf, '2.0NRT', '312.0', frp.toFixed(1), 'D',
  ].join(',');
};

const FIRMS_CSV = (...rows) =>
  `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n${rows.join('\n')}\n`;

// --- Method routing ---------------------------------------------------------

test('OPTIONS answers 204 with the CORS preflight headers', async () => {
  setCache(null);
  const res = await onRequest(ctx(new Request(url(), { method: 'OPTIONS' })));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});

test('POST gets the shared _lib 405 shape', async () => {
  setCache(null);
  const res = await onRequest(ctx(new Request(url(), { method: 'POST', body: '{}' })));
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: 'Method not allowed' });
});

// --- Keyless (public source) ------------------------------------------------

test('keyless request serves the public CSV in the client payload contract', async () => {
  setCache(null);
  const stub = stubFetch(({ url: fetchUrl }) => {
    assert.equal(fetchUrl, 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv');
    return new Response(FIRMS_CSV(FIRMS_ROW({ lat: 30.25, lon: -97.75 }), FIRMS_ROW({ lat: -13.1, lon: 131.5, frp: 40 })), { status: 200 });
  });
  try {
    const res = await onRequest(ctx(new Request(url())));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const payload = await res.json();
    assert.equal(payload.stale, false);
    assert.equal(payload.ttlMs, 30 * 60_000);
    assert.deepEqual(payload.sources, [
      { source: 'VIIRS_SNPP_24h_public', count: 2, ok: true, keyless: true },
    ]);
    assert.equal(payload.count, 2);
    assert.equal(payload.fires.length, 2);
    assert.deepEqual(payload.fires[0], {
      lat: 30.25, lon: -97.75, frp: 12.5, confidence: 'nominal', brightness: 341.2,
      brightnessTi5: 312, daynight: 'D', acqDate: FIRMS_STAMP(1).date, acqTime: FIRMS_STAMP(1).time,
      satellite: 'SUOMI-VIIRS', instrument: 'viirs',
    });
    assert.ok(Number.isFinite(payload.fetchedAt));
    assert.ok(res.headers.get('x-gev-fetched-at'));
  } finally {
    stub.restore();
  }
});

test('keyless detections older than the trailing 24h window are dropped at serve time', async () => {
  setCache(null);
  const stub = stubFetch(() => new Response(
    FIRMS_CSV(FIRMS_ROW({ hoursAgo: 1 }), FIRMS_ROW({ hoursAgo: 30, lat: 1 })),
    { status: 200 },
  ));
  try {
    const res = await onRequest(ctx(new Request(url())));
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.fires.length, 1);
    assert.equal(body.sources[0].count, 1, 'the source tally is post-filter, matching the fires array');
  } finally {
    stub.restore();
  }
});

test('an HTML upstream page is a failed source, never "no fires" — 503 no_key', async () => {
  setCache(null);
  const stub = stubFetch(() => new Response('<html>Maintenance</html>', { status: 200 }));
  try {
    const res = await onRequest(ctx(new Request(url())));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'no_key' });
  } finally {
    stub.restore();
  }
});

test('a header-only public CSV (zero rows) also degrades to 503 no_key', async () => {
  setCache(null);
  const stub = stubFetch(() => new Response(FIRMS_CSV(), { status: 200 }));
  try {
    const res = await onRequest(ctx(new Request(url())));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'no_key' });
  } finally {
    stub.restore();
  }
});

// --- Keyed (three NRT area feeds) ------------------------------------------

test('keyed mode sweeps the three NRT feeds sequentially, merging survivors', async () => {
  setCache(null);
  const env = { FIRMS_MAP_KEY: 'sekrit-map-key' };
  const stub = stubFetch(({ url: fetchUrl }) => {
    if (fetchUrl.includes('/VIIRS_NOAA20_NRT/')) {
      assert.equal(fetchUrl, 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/sekrit-map-key/VIIRS_NOAA20_NRT/world/2');
      return new Response(FIRMS_CSV(FIRMS_ROW({ lat: 30.25 }), FIRMS_ROW({ lat: 31.5 })), { status: 200 });
    }
    if (fetchUrl.includes('/VIIRS_NOAA21_NRT/')) return new Response('<html>err</html>', { status: 200 });
    if (fetchUrl.includes('/VIIRS_SNPP_NRT/')) return new Response(FIRMS_CSV(FIRMS_ROW({ lat: -13.1 })), { status: 200 });
    assert.fail(`unexpected upstream call: ${fetchUrl}`);
  });
  try {
    const res = await onRequest(ctx(new Request(url()), env));
    assert.equal(res.status, 200);
    assert.deepEqual(
      stub.calls.map((c) => c.url.match(/\/api\/area\/csv\/[^/]+\/([^/]+)\//)[1]),
      ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'],
      'sources are fetched one at a time, in registry order (quota courtesy)',
    );
    const body = await res.json();
    assert.deepEqual(body.sources, [
      { source: 'VIIRS_NOAA20_NRT', count: 2, ok: true },
      { source: 'VIIRS_NOAA21_NRT', count: 0, ok: false },
      { source: 'VIIRS_SNPP_NRT', count: 1, ok: true },
    ]);
    assert.equal(body.count, 3);
    assert.deepEqual(body.fires.map((f) => f.lat).sort((a, b) => a - b), [-13.1, 30.25, 31.5]);
    assert.equal(JSON.stringify(body).includes('sekrit-map-key'), false, 'the MAP_KEY stays in the upstream URL, never the payload');
  } finally {
    stub.restore();
  }
});

test('NASA_FIRMS_API_KEY is accepted as the key when FIRMS_MAP_KEY is unset', async () => {
  setCache(null);
  const stub = stubFetch(({ url: fetchUrl }) => {
    assert.ok(fetchUrl.startsWith('https://firms.modaps.eosdis.nasa.gov/api/area/csv/alt-key/'), fetchUrl);
    return new Response(FIRMS_CSV(FIRMS_ROW()), { status: 200 });
  });
  try {
    const res = await onRequest(ctx(new Request(url()), { NASA_FIRMS_API_KEY: 'alt-key' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sources[0].source, 'VIIRS_NOAA20_NRT');
  } finally {
    stub.restore();
  }
});

test('keyed mode with every row outside the 24h window answers 200 with count 0', async () => {
  setCache(null);
  const stub = stubFetch(() => new Response(FIRMS_CSV(FIRMS_ROW({ hoursAgo: 30 })), { status: 200 }));
  try {
    const res = await onRequest(ctx(new Request(url()), { FIRMS_MAP_KEY: 'k' }));
    assert.equal(res.status, 200, 'a healthy source with stale rows is an empty payload, not an error');
    const body = await res.json();
    assert.equal(body.count, 0);
    assert.deepEqual(body.fires, []);
    assert.equal(body.stale, false);
  } finally {
    stub.restore();
  }
});

test('keyed mode with all three sources failed answers the dev 502 shape', async () => {
  setCache(null);
  const stub = stubFetch(() => new Response('Invalid MAP_KEY', { status: 200 }));
  try {
    const res = await onRequest(ctx(new Request(url()), { FIRMS_MAP_KEY: 'k' }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'firms fetch failed and no cache available' });
  } finally {
    stub.restore();
  }
});

// --- Cache API paths (fake cache; Node has no `caches` global) --------------

test('a fresh cache hit is served verbatim and burns no upstream call', async () => {
  const cache = new FakeCache();
  setCache(cache);
  let upstream = 0;
  const stub = stubFetch(() => {
    upstream += 1;
    return new Response(FIRMS_CSV(FIRMS_ROW()), { status: 200 });
  });
  try {
    const first = await onRequest(ctx(new Request(url())));
    assert.equal(upstream, 1);
    const second = await onRequest(ctx(new Request(url())));
    assert.equal(upstream, 1, 'the second request within the TTL is answered from the Cache API');
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(second.headers.get('x-gev-fetched-at'), first.headers.get('x-gev-fetched-at'));
  } finally {
    stub.restore();
    setCache(null);
  }
});

test('when upstream fails, a cache entry older than the TTL is served stale', async () => {
  const cache = new FakeCache();
  setCache(cache);
  const stub = stubFetch(() => new Response(FIRMS_CSV(FIRMS_ROW()), { status: 200 }));
  try {
    await onRequest(ctx(new Request(url())));
    // Age the primed entry past the 30 min TTL by swapping in a response that
    // carries an old x-gev-fetched-at (Response headers are immutable).
    const primed = cache.map.get(PUBLIC_CACHE_URL);
    assert.ok(primed, 'the success primed the cache');
    cache.map.set(PUBLIC_CACHE_URL, new Response(await primed.text(), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-gev-fetched-at': String(Date.now() - 31 * 60_000),
      },
    }));

    stub.restore();
    const failing = stubFetch(() => new Response('<html>down</html>', { status: 200 }));
    try {
      const res = await onRequest(ctx(new Request(url())));
      assert.equal(res.status, 200, 'stale data beats an error');
      const body = await res.json();
      assert.equal(body.stale, true);
      assert.ok(body.fires.length >= 1);
    } finally {
      failing.restore();
    }
  } finally {
    stub.restore();
    setCache(null);
  }
});
