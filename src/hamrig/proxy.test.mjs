import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HAMRIG_CACHE_TTL_MS,
  HAMRIG_DIRECT_SOURCES,
  HAMRIG_FORBIDDEN_KEYS,
  HAMRIG_PROXY_USER_AGENT,
  createHamrigProxyMiddleware,
  scrubForbiddenKeys,
} from './proxy.js';
import { HAMRIG_MOUNT_PATH, hamrigProxyPlugin, parseHamrigEnv } from './plugin.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-09-12T16:00:00Z');

function fixture(name) {
  return JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
}

const FIX = {
  callsignDb: fixture('hamrig-callsign-db-dh5dax.json'),
  wwff: fixture('hamrig-wwff.json'),
  bota: fixture('hamrig-bota.json'),
  dxOps: fixture('hamrig-dx-operations.json'),
  mostWanted: fixture('hamrig-mostwanted.json'),
  conditions: fixture('hamrig-propagation-conditions.json'),
  solarExtended: fixture('hamrig-solar-extended.json'),
  iono: fixture('hamrig-iono.json'),
  aurora: fixture('hamrig-overlay-aurora.json'),
  voacap: fixture('hamrig-overlay-voacap.json'),
  fm: fixture('hamrig-fm-repeaters-nearby.json'),
  dstar: fixture('hamrig-dstar-repeaters-nearby.json'),
  psk: fixture('hamrig-pskreporter.json'),
  wspr: fixture('hamrig-wspr.json'),
  rotators: fixture('hamrig-rotators.json'),
  pota: fixture('pota-spot-activator.json'),
  sota: fixture('sota-spots.json'),
  sotaSummit: fixture('sota-summit.json'),
  kc2g: fixture('kc2g-stations.json'),
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function createClock(start = T0) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; };
  return now;
}

function createLog() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level}: ${args.map(String).join(' ')}`);
  return { lines, warn: push('warn'), info: push('info'), error: push('error') };
}

/**
 * Fake HamRig client. `routes` maps `/api/...` paths to a payload, a function
 * `(query, opts) => payload|{status,json}`, or an Error to throw (network).
 */
function fakeClient(routes = {}, { canAuthenticate = false, configured = true, authenticated = false } = {}) {
  const calls = [];
  const answer = async (method, pathName, query, opts) => {
    calls.push({ method, path: pathName, query: query ?? null, auth: Boolean(opts?.auth) });
    if (!(pathName in routes)) return { status: 404, json: { error: 'no such route' }, text: '' };
    let entry = routes[pathName];
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') entry = entry(query, opts);
    if (entry instanceof Error) throw entry;
    if (entry && typeof entry === 'object' && 'status' in entry && 'json' in entry) return { text: '', ...entry };
    return { status: 200, json: entry, text: JSON.stringify(entry) };
  };
  return {
    calls,
    configured,
    canAuthenticate,
    get: (pathName, opts = {}) => answer('GET', pathName, opts.query, opts),
    post: (pathName, body, opts = {}) => answer('POST', pathName, body, opts),
    status: () => ({ baseUrl: 'https://test.hamrig.com', configured, canAuthenticate, authenticated, tokenExpiresAt: null }),
    invalidateToken() {},
  };
}

const CTY_TABLE = {
  DH5DAX: { entity: 'Fed. Rep. of Germany', primaryPrefix: 'DL', cq: 14, itu: 28, continent: 'EU', lat: 51.0, lon: 10.0, matchType: 'prefix', waeOnly: false, precision: 'entity' },
  TF: { entity: 'Iceland', primaryPrefix: 'TF', cq: 40, itu: 17, continent: 'EU', lat: 65.0, lon: -18.0, matchType: 'prefix', waeOnly: false, precision: 'entity' },
  J3: { entity: 'Grenada', primaryPrefix: 'J3', cq: 8, itu: 11, continent: 'NA', lat: 12.13, lon: -61.68, matchType: 'prefix', waeOnly: false, precision: 'entity' },
  W1AW: { entity: 'United States', primaryPrefix: 'K', cq: 5, itu: 8, continent: 'NA', lat: 43.0, lon: -71.5, matchType: 'prefix', waeOnly: false, precision: 'area' },
};

function fakeCty(table = CTY_TABLE) {
  let readyCalls = 0;
  return {
    get readyCalls() { return readyCalls; },
    ready: async () => { readyCalls += 1; return { entities: Object.values(table) }; },
    resolve: (call) => table[String(call).toUpperCase()] ?? null,
    status: () => ({ ready: true, loaded: true, entities: Object.keys(table).length }),
  };
}

function locFromTable(call, precision = null) {
  const hit = CTY_TABLE[String(call).toUpperCase()];
  if (!hit) return null;
  return { lat: hit.lat, lon: hit.lon, precision: precision ?? hit.precision, entity: hit.entity, continent: hit.continent, adif: null, cq: hit.cq };
}

function fakeGeolocator({ station = undefined } = {}) {
  const calls = [];
  return {
    calls,
    locateEntity: (call) => { calls.push(['locateEntity', call]); return locFromTable(call); },
    locateMany: async (calls_, opts) => {
      calls.push(['locateMany', calls_, opts]);
      const out = new Map();
      for (const call of calls_) out.set(call, locFromTable(call, opts?.precise ? 'exact' : null));
      return out;
    },
    locatePrecise: async (call) => locFromTable(call, 'exact'),
    stationFor: async (call) => {
      calls.push(['stationFor', call]);
      if (station !== undefined) return typeof station === 'function' ? station(call) : station;
      return null;
    },
    stats: () => ({ cached: 0 }),
  };
}

const SPOTS = [
  { id: 's1', dx: 'S79/DL2SBY', spotter: 'CT7AUT', spotterCall: 'CT7AUT', freqHz: 24915000, band: '12m', mode: 'FT8', comment: 'FT8 +9 dB', timeIso: '2026-09-12T15:58:00.000Z', dxLoc: locFromTable('J3'), spotterLoc: null, source: 'ws' },
  { id: 's2', dx: 'TF3XYZ', spotter: 'DL8LAS-#', spotterCall: 'DL8LAS', freqHz: 14025000, band: '20m', mode: 'CW', comment: 'CW 22 dB 24 WPM', timeIso: '2026-09-12T15:50:00.000Z', dxLoc: locFromTable('TF'), spotterLoc: locFromTable('DH5DAX'), source: 'ws' },
  { id: 's3', dx: 'W1AW', spotter: 'DH5DAX', spotterCall: 'DH5DAX', freqHz: 14074000, band: '20m', mode: 'FT8', comment: 'FT8', timeIso: '2026-09-12T15:00:00.000Z', dxLoc: locFromTable('W1AW'), spotterLoc: locFromTable('DH5DAX'), source: 'rest' },
  { id: 's4', dx: 'J3ABC', spotter: 'W3LPL-2', spotterCall: 'W3LPL', freqHz: 7074000, band: '40m', mode: 'FT8', comment: '', timeIso: '2026-09-12T15:20:00.000Z', dxLoc: locFromTable('J3'), spotterLoc: null, source: 'rest' },
];

function fakeSpotFeed({ spots = SPOTS, live = true, throws = null } = {}) {
  const calls = [];
  return {
    calls,
    getSpots: (query) => {
      calls.push(query);
      if (throws) throw throws;
      return { spots, live, updatedAt: '2026-09-12T15:59:30.000Z' };
    },
    status: () => ({ live, updatedAt: '2026-09-12T15:59:30.000Z' }),
    ensureStarted() {},
    stop() {},
  };
}

/** Recording fetch for the direct feeds. `map[url]` → payload | Error | () => Response. */
function fakeFetch(map) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(map).find((candidate) => String(url) === candidate || String(url).startsWith(candidate));
    if (!key) return new Response('not found', { status: 404 });
    const entry = map[key];
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') return entry(String(url));
    return new Response(JSON.stringify(entry), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const DIRECT = {
  [HAMRIG_DIRECT_SOURCES.pota]: FIX.pota,
  [HAMRIG_DIRECT_SOURCES.sota]: FIX.sota,
  [HAMRIG_DIRECT_SOURCES.sotaSummit]: FIX.sotaSummit,
  [HAMRIG_DIRECT_SOURCES.kc2g]: FIX.kc2g,
};

const HAMRIG_ROUTES = {
  '/api/wwff': FIX.wwff,
  '/api/bota': FIX.bota,
  '/api/dx-operations': FIX.dxOps,
  '/api/mostwanted': FIX.mostWanted,
  '/api/propagation/conditions': FIX.conditions,
  '/api/solar-extended': FIX.solarExtended,
  '/api/iono': FIX.iono,
  '/api/overlay/aurora': FIX.aurora,
  '/api/overlay/voacap': FIX.voacap,
  '/api/fm/repeaters/nearby': FIX.fm,
  '/api/dstar/repeaters/nearby': FIX.dstar,
  '/api/pskreporter': FIX.psk,
  '/api/wspr': FIX.wspr,
  '/api/beacons/vhf': { success: true, beacons: [{ call: 'DB0AAT', freq_khz: 144412, band: '2m', locator: 'JN68NX', lat: 48.9, lon: 12.5, location: 'Bavaria', last_heard: { at: '2026-09-12T15:00:00Z', spotter: 'DH5DAX', snr: 12 } }] },
  '/api/rotators': FIX.rotators.list,
  '/api/rotators/7/status': FIX.rotators.statuses['7'],
  '/api/map/data/dxcc-status': { success: true, worked: 1, total: 2, scoped: 'all', entities: [{ adif: 230, name: 'Germany', prefix: 'DL', cont: 'EU', cqz: 14, lat: 51, lon: 10, worked: true, bands: ['20m'] }, { adif: 1, name: 'Canada', prefix: 'VE', cont: 'NA', cqz: 5, lat: 60, lon: -100, worked: false, bands: [] }] },
  '/api/map/data/worked-grids': { success: true, total: 1, grids: [{ grid: 'JO32', qsos: 12, lat: 52.5, lon: 7 }] },
  '/api/public/callsign-db/DH5DAX': FIX.callsignDb,
};

function fakeReq(method, url, body = null) {
  const req = Readable.from(body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

function fakeRes() {
  const res = { status: 0, headers: null, body: '', ended: false };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (body = '') => { res.body = body; res.ended = true; };
  res.json = () => JSON.parse(res.body);
  return res;
}

function harness(overrides = {}) {
  const now = overrides.now ?? createClock();
  const log = overrides.log ?? createLog();
  const client = overrides.client ?? fakeClient(HAMRIG_ROUTES);
  const cty = overrides.cty === null ? null : (overrides.cty ?? fakeCty());
  const geolocator = overrides.geolocator === null ? null : (overrides.geolocator ?? fakeGeolocator());
  const spotFeed = overrides.spotFeed === null ? null : (overrides.spotFeed ?? fakeSpotFeed());
  const fetch = overrides.fetch ?? fakeFetch(DIRECT);
  const middleware = createHamrigProxyMiddleware({
    client, cty, geolocator, spotFeed, fetchImpl: fetch.fetchImpl, now, log,
    config: { enabled: true, homeGrid: 'JO32me', ...(overrides.config ?? {}) },
  });
  const call = async (url, { method = 'GET', body = null } = {}) => {
    const res = fakeRes();
    let nextCalled = false;
    await middleware(fakeReq(method, url, body), res, () => { nextCalled = true; });
    assert.equal(res.ended, true, `response for ${method} ${url} must be ended`);
    assert.equal(nextCalled, false);
    return res;
  };
  return { now, log, client, cty, geolocator, spotFeed, fetch, middleware, call };
}

function assertEnvelope(res, status = 200) {
  assert.equal(res.status, status, res.body);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(res.headers['Content-Type'], /application\/json/);
  const body = res.json();
  assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(body.sources), 'sources must be an array');
  assertNoPii(res.body);
  return body;
}

/** Deep scan: no forbidden key may appear anywhere in the serialized response. */
function assertNoPii(text) {
  const forbidden = ['email', 'addr1', 'zip', 'county', 'gateway_key', ...HAMRIG_FORBIDDEN_KEYS];
  for (const key of new Set(forbidden)) {
    assert.equal(text.includes(`"${key}"`), false, `response leaks key "${key}": ${text.slice(0, 300)}`);
  }
  // The DH5DAX fixture's street and postcode must never appear as values either.
  assert.equal(text.includes('Hoher Weg'), false, 'street address leaked');
  assert.equal(text.includes('48599'), false, 'postcode leaked');
  assert.equal(text.includes('gk_SEC'), false, 'gateway key leaked');
}

// ---------------------------------------------------------------------------
// Envelope, routing, disabled state
// ---------------------------------------------------------------------------

test('unknown routes answer 404, wrong methods 405, every answer is no-store JSON with generatedAt/sources', async () => {
  const h = harness();
  const missing = await h.call('/nope');
  assertEnvelope(missing, 404);
  assert.match(missing.json().error, /Unknown HamRig route/);
  const nested = await h.call('/status/extra');
  assert.equal(nested.status, 404);
  const post = await h.call('/status', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal(post.headers['Cache-Control'], 'no-store');
  // Mounted without the Connect prefix strip the full path still routes.
  const full = await h.call('/api/hamrig/status');
  assertEnvelope(full, 200);
  // Trailing slash tolerated.
  const slash = await h.call('/api/hamrig/status/');
  assert.equal(slash.status, 200);
});

test('config.enabled=false answers 503 for every path without touching upstreams', async () => {
  const h = harness({ config: { enabled: false } });
  for (const url of ['/status', '/spots', '/station/DH5DAX', '/my/rotators']) {
    const res = await h.call(url);
    const body = assertEnvelope(res, 503);
    assert.equal(body.error, 'HamRig integration disabled');
  }
  const locate = await h.call('/locate', { method: 'POST', body: { calls: ['DH5DAX'] } });
  assert.equal(locate.status, 503);
  assert.equal(h.client.calls.length, 0);
  assert.equal(h.fetch.calls.length, 0);
  assert.equal(h.spotFeed.calls.length, 0);
});

test('/status reports configuration, auth state, home grid and features', async () => {
  const h = harness({ client: fakeClient(HAMRIG_ROUTES, { canAuthenticate: true, authenticated: true }) });
  const body = assertEnvelope(await h.call('/status'));
  assert.equal(body.enabled, true);
  assert.equal(body.configured, true);
  assert.equal(body.baseUrl, 'https://test.hamrig.com');
  assert.equal(body.authenticated, true);
  assert.equal(body.homeGrid, 'JO32me');
  assert.deepEqual(body.features, { spotsLive: true, myStation: true, sota: false });
  assert.equal(body.spotFeed.live, true);
  assert.deepEqual(body.cty, { loaded: true, entities: Object.keys(CTY_TABLE).length });

  const bare = harness({ client: fakeClient({}, { canAuthenticate: false, configured: false }), spotFeed: null, cty: null, geolocator: null });
  const bareBody = assertEnvelope(await bare.call('/status'));
  assert.equal(bareBody.configured, false);
  assert.deepEqual(bareBody.features, { spotsLive: false, myStation: false, sota: false });
  assert.equal(bareBody.cty, null);
});

// ---------------------------------------------------------------------------
// Stations and locate
// ---------------------------------------------------------------------------

const STATION_DH5DAX = {
  callsign: 'DH5DAX', name: 'Michael Beck', country: 'Germany',
  dxcc: { adif: 230, name: 'Germany', prefix: 'DL', continent: 'EU', cqZone: 14, ituZone: 28 },
  lat: 52.186667, lon: 7.04, precision: 'exact', grid: 'JO32me', city: 'Gronau', state: null,
  imageUrl: null, licenseClass: 'A', qslManager: null, lotw: null, eqsl: null, hamrigUser: null,
  sources: ['hamrig:callsign-db', 'cty.dat'],
};

test('/station/:callsign returns the geolocator station and 404/400/502 on miss/invalid/failure', async () => {
  const h = harness({ geolocator: fakeGeolocator({ station: (call) => (call === 'DH5DAX' ? STATION_DH5DAX : null) }) });
  const body = assertEnvelope(await h.call('/station/dh5dax'));
  assert.equal(body.station.callsign, 'DH5DAX');
  assert.equal(body.station.precision, 'exact');
  assert.deepEqual(body.sources, ['hamrig:callsign-db', 'cty.dat']);
  assert.deepEqual(h.geolocator.calls.filter((c) => c[0] === 'stationFor'), [['stationFor', 'DH5DAX']]);
  assert.equal(h.cty.readyCalls, 1, 'cty.ready() awaited before lookup');

  const miss = await h.call('/station/ZZ9ZZZ');
  assertEnvelope(miss, 404);
  assert.match(miss.json().error, /ZZ9ZZZ/);

  for (const bad of ['/station/DL', '/station/DL1%20ABC', '/station/ABCDEFGHIJKLMNOP', '/station/DL1AB%3Fx=1']) {
    const res = await h.call(bad);
    assert.equal(res.status, 400, bad);
    assert.match(res.json().error, /not a valid callsign/);
  }
  const slashed = await h.call('/station/S79%2FDL2SBY');
  assert.equal(slashed.status, 404);
  assert.deepEqual(h.geolocator.calls.at(-1), ['stationFor', 'S79/DL2SBY']);

  const boom = harness({ geolocator: { ...fakeGeolocator(), stationFor: async () => { throw new Error('socket hang up'); } } });
  const failed = await boom.call('/station/DH5DAX');
  assertEnvelope(failed, 502);
  assert.match(failed.json().error, /socket hang up/);
});

test('/station/:callsign without a geolocator falls back to callsign-db + cty and strips PII', async () => {
  const h = harness({ geolocator: null });
  const raw = JSON.stringify(FIX.callsignDb);
  assert.ok(raw.includes('"addr1"') && raw.includes('"zip"') && raw.includes('"trustee"'), 'fixture carries PII');
  const body = assertEnvelope(await h.call('/station/DH5DAX'));
  assert.equal(body.station.callsign, 'DH5DAX');
  assert.equal(body.station.lat, 52.186667);
  assert.equal(body.station.precision, 'exact');
  assert.equal(body.station.grid, 'JO32me');
  assert.deepEqual(h.client.calls, [{ method: 'GET', path: '/api/public/callsign-db/DH5DAX', query: null, auth: false }]);

  // Unknown call with no cty match → 404 even though HamRig answers 200 with a stub.
  const stub = harness({ geolocator: null, client: fakeClient({ '/api/public/callsign-db/ZZ9ZZZ': { success: true, callsign: { callsign: 'NOT_FOUND', name: 'NOT_FOUND' }, source: 'hamdb' } }) });
  assert.equal((await stub.call('/station/ZZ9ZZZ')).status, 404);
  // Prefix-only cty hit still yields a station (entity precision).
  const ctyOnly = harness({ geolocator: null, client: fakeClient({}) });
  const tf = assertEnvelope(await ctyOnly.call('/station/TF'), 400);
  assert.match(tf.error, /not a valid callsign/);
  const w1 = assertEnvelope(await ctyOnly.call('/station/W1AW'));
  assert.equal(w1.station.precision, 'area');
  assert.equal(w1.station.country, 'United States');
  // A thrown client error becomes 502.
  const net = harness({ geolocator: null, client: fakeClient({ '/api/public/callsign-db/DH5DAX': new Error('ECONNRESET') }) });
  assert.equal((await net.call('/station/DH5DAX')).status, 502);
});

test('POST /locate validates the body and maps callsigns to Loc|null', async () => {
  const h = harness();
  const body = assertEnvelope(await h.call('/locate', { method: 'POST', body: { calls: ['dh5dax', 'TF', 'zz9zzz', 'bad call!', 'DH5DAX'], precise: true } }));
  assert.equal(body.located.DH5DAX.precision, 'exact');
  assert.equal(body.located.TF.entity, 'Iceland');
  assert.equal(body.located.ZZ9ZZZ, null);
  assert.equal(body.located['BAD CALL!'], null);
  assert.equal(body.precise, true);
  const locateCall = h.geolocator.calls.find((c) => c[0] === 'locateMany');
  assert.deepEqual(locateCall[1], ['DH5DAX', 'TF', 'ZZ9ZZZ'], 'invalid entries never reach the geolocator; duplicates collapse');
  assert.deepEqual(locateCall[2], { precise: true });

  for (const bad of [{}, { calls: 'DH5DAX' }, { calls: Array.from({ length: 301 }, (_, i) => `DL${i}AA`) }]) {
    const res = await h.call('/locate', { method: 'POST', body: bad });
    assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await h.call('/locate', { method: 'POST', body: '{not json' })).status, 400);
  const get = await h.call('/locate');
  assert.equal(get.status, 405);
  assert.equal(get.headers.Allow, 'POST');

  const noGeo = harness({ geolocator: null });
  const fallback = assertEnvelope(await noGeo.call('/locate', { method: 'POST', body: { calls: ['J3', 'ZZ9ZZZ'] } }));
  assert.equal(fallback.located.J3.precision, 'entity');
  assert.equal(fallback.located.ZZ9ZZZ, null);

  const boom = harness({ geolocator: { ...fakeGeolocator(), locateMany: async () => { throw new Error('queue exploded'); } } });
  assert.equal((await boom.call('/locate', { method: 'POST', body: { calls: ['DH5DAX'] } })).status, 502);
});

// ---------------------------------------------------------------------------
// Spots
// ---------------------------------------------------------------------------

test('/spots forwards the window to the feed and filters band/mode/dx/limit locally', async () => {
  const h = harness();
  const all = assertEnvelope(await h.call('/spots'));
  assert.equal(all.spots.length, 4);
  assert.equal(all.live, true);
  assert.equal(all.updatedAt, '2026-09-12T15:59:30.000Z');
  assert.deepEqual(all.sources, ['hamrig:spots-ws', 'cty.dat']);
  assert.equal(h.spotFeed.calls[0].sinceMs, T0 - 60 * 60 * 1000);
  assert.equal(h.spotFeed.calls[0].mode, null);

  const twenty = assertEnvelope(await h.call('/spots?band=20m&mode=cw'));
  assert.deepEqual(twenty.spots.map((s) => s.id), ['s2']);
  assert.equal(h.spotFeed.calls[1].band, '20m');
  assert.equal(h.spotFeed.calls[1].mode, 'CW');

  const digi = assertEnvelope(await h.call('/spots?mode=DIGI'));
  assert.deepEqual(digi.spots.map((s) => s.id), ['s1', 's3', 's4'], 'DIGI matches every digital mode');

  const recent = assertEnvelope(await h.call('/spots?minutes=15'));
  assert.deepEqual(recent.spots.map((s) => s.id), ['s1', 's2'], 'older spots dropped locally');
  const limited = assertEnvelope(await h.call('/spots?limit=1'));
  assert.deepEqual(limited.spots.map((s) => s.id), ['s1'], 'limit applied after filtering');
  const stale = harness({ now: createClock(T0 + 3 * 60 * 60 * 1000) });
  assert.equal(assertEnvelope(await stale.call('/spots')).spots.length, 0, 'spots older than the window are dropped even when the feed returns them');

  const dx = assertEnvelope(await h.call('/spots?dx=tf3xyz'));
  assert.deepEqual(dx.spots.map((s) => s.id), ['s2']);

  for (const bad of ['/spots?band=11m', '/spots?mode=MORSE', '/spots?minutes=0', '/spots?limit=5000', '/spots?dx=bad%20call']) {
    assert.equal((await h.call(bad)).status, 400, bad);
  }
});

test('/spots answers 502 when the feed throws or is missing, without crashing', async () => {
  const boom = harness({ spotFeed: fakeSpotFeed({ throws: new Error('ws down') }) });
  const res = await boom.call('/spots');
  assertEnvelope(res, 502);
  assert.match(res.json().error, /ws down/);
  const none = harness({ spotFeed: null });
  assert.equal((await none.call('/spots')).status, 502);
  // The middleware is still healthy afterwards.
  assert.equal((await boom.call('/status')).status, 200);
});

// ---------------------------------------------------------------------------
// Activations
// ---------------------------------------------------------------------------

test('/activations merges POTA/SOTA (direct, with User-Agent) and WWFF/BOTA (via HamRig), newest first', async () => {
  const h = harness({ config: { sotaEnabled: true } });
  const body = assertEnvelope(await h.call('/activations'));
  const programs = new Set(body.activations.map((a) => a.program));
  assert.deepEqual([...programs].sort(), ['BOTA', 'POTA', 'SOTA', 'WWFF']);
  assert.deepEqual(body.errors, {});
  assert.deepEqual(body.programs, ['POTA', 'SOTA', 'WWFF', 'BOTA']);
  assert.equal(body.sources.length, 4);
  for (let i = 1; i < body.activations.length; i += 1) {
    assert.ok(Date.parse(body.activations[i - 1].timeIso) >= Date.parse(body.activations[i].timeIso), 'sorted newest first');
  }
  for (const activation of body.activations) {
    assert.ok(Number.isFinite(activation.lat) && Number.isFinite(activation.lon), 'rows without coordinates are dropped');
  }
  const direct = h.fetch.calls.map((c) => c.url);
  assert.ok(direct.includes(HAMRIG_DIRECT_SOURCES.pota));
  assert.ok(direct.includes(HAMRIG_DIRECT_SOURCES.sota));
  for (const c of h.fetch.calls) assert.equal(c.init.headers['User-Agent'], HAMRIG_PROXY_USER_AGENT);
  assert.deepEqual(h.client.calls.map((c) => c.path).sort(), ['/api/bota', '/api/wwff']);
  // WWFF rows with '-' / JJ00AA / 2-char locators are dropped, EN91HA-style locators become grid positions.
  const wwff = body.activations.filter((a) => a.program === 'WWFF');
  assert.ok(wwff.length > 0 && wwff.length < FIX.wwff.spots.length);
  assert.ok(wwff.every((a) => a.precision === 'grid'));
});

test('/activations honours programs/limit, caches 60 s, and reports per-program errors', async () => {
  const routes = { ...HAMRIG_ROUTES, '/api/wwff': new Error('wwff timeout') };
  const h = harness({ client: fakeClient(routes) });
  const body = assertEnvelope(await h.call('/activations?programs=pota,wwff&limit=3'));
  assert.equal(body.activations.length, 3);
  assert.ok(body.activations.every((a) => a.program === 'POTA'));
  assert.deepEqual(body.errors, { WWFF: 'HamRig wwff failed: wwff timeout' });
  assert.deepEqual(body.sources, ['pota:api.pota.app']);
  const fetches = h.fetch.calls.length;
  await h.call('/activations?programs=pota');
  assert.equal(h.fetch.calls.length, fetches, 'served from cache');
  h.now.advance(HAMRIG_CACHE_TTL_MS.activations + 1);
  await h.call('/activations?programs=pota');
  assert.equal(h.fetch.calls.length, fetches + 1, 'refetched after the TTL');

  assert.equal((await h.call('/activations?programs=iota')).status, 400);
  assert.equal((await h.call('/activations?limit=0')).status, 400);

  const dead = harness({ client: fakeClient({ '/api/wwff': new Error('down'), '/api/bota': new Error('down') }), fetch: fakeFetch({ [HAMRIG_DIRECT_SOURCES.pota]: new Error('pota down'), [HAMRIG_DIRECT_SOURCES.sota]: () => new Response('nope', { status: 500 }) }) });
  const res = await dead.call('/activations');
  assertEnvelope(res, 502);
  assert.deepEqual(res.json().activations, []);
  assert.equal(Object.keys(res.json().errors).length, 4);
});

test('/activations SOTA rows without coordinates fall back to the summit record (cached 30 d)', async () => {
  const rows = FIX.sota.map((row) => ({ ...row, latitude: null, longitude: null }));
  const fetch = fakeFetch({ ...DIRECT, [HAMRIG_DIRECT_SOURCES.sota]: rows });
  const h = harness({ fetch, config: { sotaEnabled: true } });
  const body = assertEnvelope(await h.call('/activations?programs=sota'));
  const madonna = body.activations.filter((a) => a.reference === 'W0C/SP-051');
  assert.ok(madonna.length >= 1);
  assert.equal(madonna[0].lat, FIX.sotaSummit.latitude);
  assert.equal(madonna[0].name, 'Madonna Dome');
  const summitFetches = h.fetch.calls.filter((c) => c.url.startsWith(HAMRIG_DIRECT_SOURCES.sotaSummit));
  const uniqueCodes = new Set(rows.map((r) => r.summitCode));
  assert.equal(summitFetches.length, uniqueCodes.size, 'one summit fetch per distinct code, results memoised');
  assert.ok(summitFetches.every((c) => /summits\/[A-Z0-9]+%2F[A-Z]{2}-\d{3}$/.test(c.url)), 'summit code is path-encoded');
});

// ---------------------------------------------------------------------------
// DXpeditions
// ---------------------------------------------------------------------------

test('/dxpeditions joins NG3K + most wanted, locates prefixes via cty and caches 30 min', async () => {
  const h = harness();
  const body = assertEnvelope(await h.call('/dxpeditions'));
  assert.equal(body.operations.length, FIX.dxOps.operations.length);
  const tf = body.operations.find((op) => op.callsign === 'TF');
  assert.equal(tf.lat, 65);
  assert.equal(tf.precision, 'entity');
  assert.equal(tf.mostWantedRank, null, 'TF carries no Club Log rank in the fixture');
  const vp5 = body.operations.find((op) => op.callsign === 'VP5');
  assert.equal(vp5.mostWantedRank, 70, 'most-wanted rank joined by callsign');
  assert.ok(body.sources.includes('cty.dat'));
  assert.ok(body.sources.some((s) => s.startsWith('hamrig:mostwanted')));
  assert.ok(['active', 'upcoming', 'ended'].includes(tf.status));
  const calls = h.client.calls.length;
  await h.call('/dxpeditions');
  assert.equal(h.client.calls.length, calls, 'cached');
  h.now.advance(HAMRIG_CACHE_TTL_MS.dxpeditions + 1);
  await h.call('/dxpeditions');
  assert.equal(h.client.calls.length, calls + 2, 'both feeds refetched after 30 min');

  const noWanted = harness({ client: fakeClient({ ...HAMRIG_ROUTES, '/api/mostwanted': new Error('clublog down') }) });
  const partial = assertEnvelope(await noWanted.call('/dxpeditions'));
  assert.equal(partial.operations.length, FIX.dxOps.operations.length, 'most-wanted failure is tolerated');
  assert.ok(!partial.sources.some((s) => s.startsWith('hamrig:mostwanted')));

  const dead = harness({ client: fakeClient({ ...HAMRIG_ROUTES, '/api/dx-operations': { status: 500, json: null } }) });
  assert.equal((await dead.call('/dxpeditions')).status, 502);
});

test('/dxpeditions serves a stale cached copy when the upstream fails later', async () => {
  const routes = { ...HAMRIG_ROUTES };
  const h = harness({ client: fakeClient(routes) });
  assert.equal((await h.call('/dxpeditions')).status, 200);
  routes['/api/dx-operations'] = new Error('ng3k unreachable');
  h.now.advance(HAMRIG_CACHE_TTL_MS.dxpeditions + 1);
  const stale = assertEnvelope(await h.call('/dxpeditions'));
  assert.equal(stale.stale, true);
  assert.equal(stale.operations.length, FIX.dxOps.operations.length);
  assert.ok(h.log.lines.some((line) => line.includes('serving cached copy')));
});

// ---------------------------------------------------------------------------
// Propagation, aurora, VOACAP, ionosondes
// ---------------------------------------------------------------------------

test('/propagation merges conditions + solar-extended + iono for the grid (default = home grid)', async () => {
  const h = harness();
  const body = assertEnvelope(await h.call('/propagation'));
  assert.equal(body.grid, 'JO32');
  assert.equal(body.solar.sfi, FIX.conditions.solarData.sfi);
  assert.equal(body.solar.kIndex, FIX.conditions.solarData.kIndex);
  assert.equal(body.solar.ssn, FIX.iono.essn.ssn);
  assert.equal(typeof body.solar.xrayClass, 'string');
  assert.equal(body.bands['20m'], FIX.conditions.conditions['20m']);
  assert.equal(body.ionosonde.nearest.name, 'Dourbes, Belgium');
  assert.deepEqual(body.errors, []);
  assert.ok(body.sources.length >= 3);
  const ionoCall = h.client.calls.find((c) => c.path === '/api/iono');
  assert.deepEqual(ionoCall.query, { grid: 'JO32' });

  const other = assertEnvelope(await h.call('/propagation?grid=fn20kp'));
  assert.equal(other.grid, 'FN20');
  assert.equal((await h.call('/propagation?grid=ZZ99')).status, 400);
  assert.equal((await h.call('/propagation?grid=JJ00AA')).status, 400);

  const calls = h.client.calls.length;
  await h.call('/propagation');
  assert.equal(h.client.calls.length, calls, 'cached per grid');

  const noHome = harness({ config: { homeGrid: null } });
  assert.equal(assertEnvelope(await noHome.call('/propagation')).grid, 'JO32');
});

test('/propagation tolerates partial upstream failures but answers 502 when every feed fails', async () => {
  const partial = harness({ client: fakeClient({ ...HAMRIG_ROUTES, '/api/solar-extended': new Error('swpc down'), '/api/iono': { status: 503, json: null } }) });
  const body = assertEnvelope(await partial.call('/propagation'));
  assert.equal(body.solar.sfi, FIX.conditions.solarData.sfi);
  assert.equal(body.solar.ssn, null);
  assert.equal(body.errors.length, 2);
  const dead = harness({ client: fakeClient({}) });
  const res = await dead.call('/propagation');
  assertEnvelope(res, 502);
  assert.match(res.json().error, /Propagation feeds unavailable/);
});

test('/aurora normalises the OVATION grid, drops faint cells and caches 10 min', async () => {
  const rows = [...FIX.aurora.points, { lat: 60, lon: 10, value: 5 }, { lat: 61, lon: 10, value: 0 }];
  const h = harness({ client: fakeClient({ ...HAMRIG_ROUTES, '/api/overlay/aurora': { ...FIX.aurora, points: rows } }) });
  const body = assertEnvelope(await h.call('/aurora'));
  assert.equal(body.points.length, FIX.aurora.points.length, 'value ≤ 5 dropped');
  assert.ok(body.points.every((p) => p.value > 5));
  assert.equal(body.unit, '%');
  assert.equal(typeof body.forecastIso, 'string');
  assert.deepEqual(body.sources, ['hamrig:overlay-aurora (NOAA SWPC OVATION)']);
  await h.call('/aurora');
  assert.equal(h.client.calls.length, 1);
  const dead = harness({ client: fakeClient({ '/api/overlay/aurora': new Error('boom') }) });
  assert.equal((await dead.call('/aurora')).status, 502);
});

test('/voacap validates every parameter, whitelists the resolution and caches per key', async () => {
  const h = harness();
  const body = assertEnvelope(await h.call('/voacap?lat=52.19&lon=7.04&frequencyMhz=14.1&hour=15&resolution=15'));
  assert.equal(body.points.length, FIX.voacap.points.length);
  assert.equal(body.txLat, 52.19);
  assert.equal(body.frequencyMhz, 14.1);
  assert.equal(body.utcHour, 15);
  assert.equal(body.resolution, 15);
  const upstream = h.client.calls[0];
  assert.equal(upstream.path, '/api/overlay/voacap');
  assert.deepEqual(upstream.query, { tx_lat: '52.1900', tx_lon: '7.0400', frequency: 14.1, hour: 15, resolution: 15 });

  await h.call('/voacap?lat=52.191&lon=7.041&frequencyMhz=14.1&hour=15&resolution=15');
  assert.equal(h.client.calls.length, 1, 'nearby tx position hits the same cache key');

  const nowHour = assertEnvelope(await h.call('/voacap?lat=52.19&lon=7.04'));
  assert.equal(h.client.calls.at(-1).query.hour, new Date(T0).getUTCHours(), 'omitted hour = current UTC hour, sent explicitly');
  assert.equal(h.client.calls.at(-1).query.resolution, 10);
  assert.equal(h.client.calls.at(-1).query.frequency, 14.1);
  assert.equal(nowHour.resolution, 10);

  for (const bad of [
    '/voacap?lon=7', '/voacap?lat=52&lon=7&resolution=0', '/voacap?lat=52&lon=7&resolution=12', '/voacap?lat=52&lon=7&frequencyMhz=1.5',
    '/voacap?lat=52&lon=7&frequencyMhz=31', '/voacap?lat=91&lon=7', '/voacap?lat=52&lon=181', '/voacap?lat=52&lon=7&hour=24', '/voacap?lat=52&lon=7&hour=1.5', '/voacap?lat=abc&lon=7',
  ]) {
    assert.equal((await h.call(bad)).status, 400, bad);
  }
  assert.equal(h.client.calls.length, 2, 'invalid requests never reach the upstream');
  const dead = harness({ client: fakeClient({ '/api/overlay/voacap': { success: false, error: 'voacapl crashed' } }) });
  const res = await dead.call('/voacap?lat=52&lon=7');
  assertEnvelope(res, 502);
  assert.match(res.json().error, /voacapl crashed/);
});

test('/ionosondes fetches KC2G directly with a User-Agent and normalises the stations', async () => {
  const now = createClock(Date.parse('2026-03-19T22:30:00Z'));
  const h = harness({ now });
  const body = assertEnvelope(await h.call('/ionosondes'));
  assert.ok(body.stations.length > 0);
  const austin = body.stations.find((s) => s.code === 'AU930');
  assert.equal(austin.lon, 262.3 - 360);
  assert.equal(austin.stale, false);
  assert.equal(austin.highestBand, '10m');
  assert.equal(h.fetch.calls[0].url, HAMRIG_DIRECT_SOURCES.kc2g);
  assert.equal(h.fetch.calls[0].init.headers['User-Agent'], HAMRIG_PROXY_USER_AGENT);
  assert.deepEqual(body.sources, ['kc2g:prop.kc2g.com (GIRO)']);
  await h.call('/ionosondes');
  assert.equal(h.fetch.calls.length, 1, 'cached 10 min');
  const dead = harness({ fetch: fakeFetch({ [HAMRIG_DIRECT_SOURCES.kc2g]: new Error('dns failure') }) });
  const res = await dead.call('/ionosondes');
  assertEnvelope(res, 502);
  assert.match(res.json().error, /dns failure/);
  const html = harness({ fetch: fakeFetch({ [HAMRIG_DIRECT_SOURCES.kc2g]: () => new Response('<html>', { status: 200 }) }) });
  assert.equal((await html.call('/ionosondes')).status, 502);
});

// ---------------------------------------------------------------------------
// Login-gated routes
// ---------------------------------------------------------------------------

test('/beacons/vhf answers 403 with beacons:[] without credentials and proxies with auth otherwise', async () => {
  const anon = harness();
  const denied = assertEnvelope(await anon.call('/beacons/vhf'), 403);
  assert.equal(denied.error, 'HamRig login not configured');
  assert.deepEqual(denied.beacons, []);
  assert.equal(anon.client.calls.length, 0);

  const h = harness({ client: fakeClient(HAMRIG_ROUTES, { canAuthenticate: true }) });
  const body = assertEnvelope(await h.call('/beacons/vhf'));
  assert.equal(body.beacons.length, 1);
  assert.equal(body.beacons[0].call, 'DB0AAT');
  assert.equal(body.beacons[0].freqHz, 144412000);
  assert.equal(body.beacons[0].lastHeard.spotter, 'DH5DAX');
  assert.deepEqual(h.client.calls, [{ method: 'GET', path: '/api/beacons/vhf', query: null, auth: true }]);
  await h.call('/beacons/vhf');
  assert.equal(h.client.calls.length, 1, 'cached 5 min');

  const loginFailed = harness({ client: fakeClient({ '/api/beacons/vhf': { status: 401, json: null, error: 'HamRig login failed (HTTP 401)' } }, { canAuthenticate: true }) });
  const res = await loginFailed.call('/beacons/vhf');
  assertEnvelope(res, 502);
  assert.match(res.json().error, /login failed/);
});

test('/my/* answers 403 when login is not configured and never leaks gateway keys', async () => {
  const anon = harness();
  for (const url of ['/my/dxcc-status', '/my/worked-grids', '/my/rotators']) {
    const res = assertEnvelope(await anon.call(url), 403);
    assert.equal(res.error, 'HamRig login not configured');
  }
  assert.equal(anon.client.calls.length, 0);
  assert.equal((await anon.call('/my/unknown')).status, 403, 'auth gate runs before route matching');

  const h = harness({ client: fakeClient(HAMRIG_ROUTES, { canAuthenticate: true, authenticated: true }) });
  assert.equal((await h.call('/my/unknown')).status, 404);

  const dxcc = assertEnvelope(await h.call('/my/dxcc-status'));
  assert.equal(dxcc.entities.length, 2);
  assert.equal(dxcc.worked, 1);
  assert.equal(dxcc.entities[0].worked, true);
  const grids = assertEnvelope(await h.call('/my/worked-grids'));
  assert.deepEqual(grids.grids, [{ grid: 'JO32', qsos: 12, lat: 52.5, lon: 7 }]);

  assert.ok(JSON.stringify(FIX.rotators.list).includes('gateway_key'), 'fixture carries the secret');
  const rotators = assertEnvelope(await h.call('/my/rotators'));
  assert.equal(rotators.rotators.length, FIX.rotators.list.length);
  const tower = rotators.rotators.find((r) => r.id === 7);
  assert.equal(tower.name, 'Tower rotor');
  assert.equal(tower.azimuth, 120, 'live status wins over the list snapshot');
  assert.equal(tower.targetAzimuth, 180);
  assert.equal(tower.isMoving, true);
  assert.equal(tower.lat, 52.186667);
  assert.equal(Object.keys(tower).includes('gateway_key'), false);
  const statusCalls = h.client.calls.filter((c) => c.path.endsWith('/status'));
  assert.equal(statusCalls.length, FIX.rotators.list.length, 'one /status call per rotator');
  assert.ok(h.client.calls.filter((c) => c.path.startsWith('/api/rotators')).every((c) => c.auth === true));

  const before = h.client.calls.length;
  await h.call('/my/rotators');
  assert.equal(h.client.calls.length, before, 'cached 10 s');
  h.now.advance(HAMRIG_CACHE_TTL_MS.rotators + 1);
  await h.call('/my/rotators');
  assert.ok(h.client.calls.length > before, 'refetched after 10 s');

  const dead = harness({ client: fakeClient({ '/api/rotators': new Error('timeout') }, { canAuthenticate: true }) });
  assert.equal((await dead.call('/my/rotators')).status, 502);
  assert.equal((await dead.call('/my/dxcc-status')).status, 502);
});

// ---------------------------------------------------------------------------
// Repeaters and reception
// ---------------------------------------------------------------------------

test('/repeaters validates the search, queries FM + D-STAR and caches on a 0.1° key', async () => {
  const h = harness();
  const body = assertEnvelope(await h.call('/repeaters?lat=52.19&lon=7.04&radiusKm=80'));
  assert.ok(body.repeaters.length >= FIX.fm.data.length + FIX.dstar.data.length);
  assert.ok(body.repeaters.some((r) => r.kind === 'FM' && r.callsign === 'PI2NON'));
  assert.ok(body.repeaters.some((r) => r.kind === 'D-STAR'));
  assert.deepEqual(body.search, { lat: 52.19, lon: 7.04, radiusKm: 80, band: 'all', kind: 'all', limit: 200 });
  assert.deepEqual(body.sources, ['hamrig:fm-repeaters', 'hamrig:dstar-repeaters']);
  const fm = h.client.calls.find((c) => c.path === '/api/fm/repeaters/nearby');
  assert.deepEqual(fm.query, { lat: '52.1900', lng: '7.0400', radius: 80, limit: 200 });
  const dstar = h.client.calls.find((c) => c.path === '/api/dstar/repeaters/nearby');
  assert.equal(dstar.query.limit, 100, 'D-STAR upstream caps limit at 100');

  await h.call('/repeaters?lat=52.21&lon=7.01&radiusKm=80');
  assert.equal(h.client.calls.length, 2, 'positions rounding to the same 0.1° cell share a cache entry');

  const fmOnly = assertEnvelope(await h.call('/repeaters?lat=52.19&lon=7.04&kind=fm&band=70cm&limit=3'));
  assert.ok(fmOnly.repeaters.every((r) => r.kind === 'FM' && r.outputHz >= 420e6 && r.outputHz < 450e6));
  assert.ok(fmOnly.repeaters.length <= 3);
  assert.equal(h.client.calls.at(-1).query.band, '70cm');
  assert.deepEqual(fmOnly.sources, ['hamrig:fm-repeaters']);

  for (const bad of ['/repeaters', '/repeaters?lat=52&lon=7&radiusKm=600', '/repeaters?lat=52&lon=7&band=11m', '/repeaters?lat=52&lon=7&kind=dmr', '/repeaters?lat=52&lon=7&limit=201', '/repeaters?lat=95&lon=7']) {
    assert.equal((await h.call(bad)).status, 400, bad);
  }
  const half = harness({ client: fakeClient({ ...HAMRIG_ROUTES, '/api/dstar/repeaters/nearby': new Error('dstar down') }) });
  const partial = assertEnvelope(await half.call('/repeaters?lat=52.19&lon=7.04'));
  assert.ok(partial.repeaters.every((r) => r.kind === 'FM'));
  assert.deepEqual(Object.keys(partial.errors), ['D-STAR']);
  const dead = harness({ client: fakeClient({}) });
  assert.equal((await dead.call('/repeaters?lat=52.19&lon=7.04')).status, 502);
});

test('/reception requires call or grid, passes warmingUp through and caches 20 s', async () => {
  const h = harness();
  assert.equal((await h.call('/reception')).status, 400);
  assert.equal((await h.call('/reception?call=bad%20call')).status, 400);
  assert.equal((await h.call('/reception?grid=ZZ')).status, 400);
  assert.equal((await h.call('/reception?call=DL2SBY&minutes=0')).status, 400);

  const body = assertEnvelope(await h.call('/reception?call=dl2sby&grid=JO32me&minutes=30'));
  assert.equal(body.psk.call, 'DL2SBY');
  assert.equal(body.psk.warmingUp, true);
  assert.equal(body.warmingUp, true);
  assert.deepEqual(body.psk.bands, {});
  assert.equal(body.wspr.field, 'JO');
  assert.equal(body.wspr.bands.length, FIX.wspr.bands.length);
  assert.ok(body.wspr.bounds && body.wspr.bounds.south === 50 && body.wspr.bounds.west === 0);
  assert.deepEqual(body.query, { call: 'DL2SBY', grid: 'JO32me', minutes: 30 });
  assert.equal(body.sources.length, 2);
  assert.deepEqual(h.client.calls.map((c) => [c.path, c.query]), [
    ['/api/pskreporter', { call: 'DL2SBY', minutes: 30 }],
    ['/api/wspr', { grid: 'JO32me', minutes: 30 }],
  ]);
  await h.call('/reception?call=DL2SBY&grid=JO32me');
  assert.equal(h.client.calls.length, 2, 'cached');
  h.now.advance(HAMRIG_CACHE_TTL_MS.reception + 1);
  await h.call('/reception?call=DL2SBY&grid=JO32me');
  assert.equal(h.client.calls.length, 4, 'refetched after 20 s');

  const callOnly = assertEnvelope(await h.call('/reception?call=DL2SBY'));
  assert.equal(callOnly.wspr, null);
  assert.equal(callOnly.psk.call, 'DL2SBY');
  const gridOnly = assertEnvelope(await h.call('/reception?grid=JO32'));
  assert.equal(gridOnly.psk, null);
  assert.equal(gridOnly.warmingUp, false);

  const dead = harness({ client: fakeClient({ '/api/pskreporter': new Error('mqtt down') }) });
  assert.equal((await dead.call('/reception?call=DL2SBY')).status, 502);
  const half = harness({ client: fakeClient({ ...HAMRIG_ROUTES, '/api/wspr': new Error('wspr.live down') }) });
  const partial = assertEnvelope(await half.call('/reception?call=DL2SBY&grid=JO32'));
  assert.equal(partial.wspr, null);
  assert.equal(partial.errors.wspr, 'HamRig wspr failed: wspr.live down');
});

// ---------------------------------------------------------------------------
// Cross-cutting: PII and crash safety
// ---------------------------------------------------------------------------

test('no route ever serialises PII or secrets, even with a leaky geolocator station', async () => {
  const leakyStation = { ...STATION_DH5DAX, email: 'x@example.org', addr1: 'Hoher Weg 32a', zip: '48599', county: 'Borken', gateway_key: 'gk_SECRET' };
  const h = harness({
    client: fakeClient(HAMRIG_ROUTES, { canAuthenticate: true, authenticated: true }),
    geolocator: fakeGeolocator({ station: leakyStation }),
  });
  const urls = [
    '/status', '/spots', '/activations', '/dxpeditions', '/propagation', '/aurora', '/voacap?lat=52&lon=7', '/ionosondes',
    '/beacons/vhf', '/repeaters?lat=52.19&lon=7.04', '/reception?call=DL2SBY&grid=JO32', '/my/dxcc-status', '/my/worked-grids', '/my/rotators',
  ];
  for (const url of urls) {
    const res = await h.call(url);
    assert.equal(res.status, 200, `${url}: ${res.body.slice(0, 200)}`);
    assertNoPii(res.body);
  }
  const locate = await h.call('/locate', { method: 'POST', body: { calls: ['DH5DAX'] } });
  assertNoPii(locate.body);
  // A geolocator that hands back extra keys is the one place the proxy trusts a
  // sibling module; the station route must still scrub those keys.
  const station = await h.call('/station/DH5DAX');
  assert.equal(station.status, 200);
  assertNoPii(station.body);
  assert.equal(station.json().station.name, 'Michael Beck');
});

test('scrubForbiddenKeys removes PII and secrets at any depth without touching other keys', () => {
  const input = { a: 1, email: 'x', nested: [{ zip: '1', keep: true, deeper: new Map([['gateway_key', 's'], ['ok', 2]]) }], addr1: null };
  assert.deepEqual(scrubForbiddenKeys(input), { a: 1, nested: [{ keep: true, deeper: { ok: 2 } }] });
  assert.equal(scrubForbiddenKeys(null), null);
  assert.equal(scrubForbiddenKeys('email'), 'email', 'values are not keys');
});

test('a throwing upstream yields 502 and the middleware keeps serving', async () => {
  const explode = new Error('kaboom');
  const client = fakeClient(Object.fromEntries(Object.keys(HAMRIG_ROUTES).map((k) => [k, explode])), { canAuthenticate: true });
  const h = harness({
    client,
    fetch: fakeFetch(Object.fromEntries(Object.keys(DIRECT).map((k) => [k, explode]))),
    spotFeed: fakeSpotFeed({ throws: explode }),
    geolocator: { ...fakeGeolocator(), stationFor: async () => { throw explode; }, locateMany: async () => { throw explode; } },
  });
  const urls = [
    '/spots', '/activations', '/dxpeditions', '/propagation', '/aurora', '/voacap?lat=52&lon=7', '/ionosondes',
    '/beacons/vhf', '/repeaters?lat=52.19&lon=7.04', '/reception?call=DL2SBY', '/my/dxcc-status', '/my/worked-grids', '/my/rotators', '/station/DH5DAX',
  ];
  for (const url of urls) {
    const res = await h.call(url);
    const body = assertEnvelope(res, 502);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
  }
  assert.equal((await h.call('/locate', { method: 'POST', body: { calls: ['DH5DAX'] } })).status, 502);
  assert.equal((await h.call('/status')).status, 200, 'still alive');
  assert.ok(h.log.lines.every((line) => !line.includes('password')));
});

test('a synchronously throwing dependency (non-Error) still maps to 502', async () => {
  const h = harness({ spotFeed: { getSpots: () => { throw 'string failure'; }, status: () => { throw new Error('nope'); } } });
  const res = await h.call('/spots');
  assertEnvelope(res, 502);
  assert.match(res.json().error, /string failure/);
  const status = assertEnvelope(await h.call('/status'));
  assert.equal(status.spotFeed, null);
});

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

test('parseHamrigEnv applies defaults, boolean words and grid validation', () => {
  const defaults = parseHamrigEnv({});
  assert.deepEqual(defaults, {
    enabled: true,
    baseUrl: 'https://hamrig.com',
    username: '',
    password: '',
    spotsWsUrl: 'wss://hamrig.com:8777',
    ctyUrl: 'https://www.country-files.com/bigcty/cty.dat',
    homeGrid: null,
    sotaEnabled: false,
  });
  const custom = parseHamrigEnv({
    HAMRIG_ENABLED: 'false', HAMRIG_BASE_URL: ' https://test.hamrig.com ', HAMRIG_USERNAME: ' dh5dax ', HAMRIG_PASSWORD: ' secret ',
    HAMRIG_SPOTS_WS_URL: 'wss://test.hamrig.com:8777', HAMRIG_CTY_URL: 'https://hamrig.com/big-cty.dat', HAMRIG_HOME_GRID: 'jo32ME',
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.baseUrl, 'https://test.hamrig.com');
  assert.equal(custom.username, 'dh5dax');
  assert.equal(custom.password, ' secret ', 'passwords are never trimmed');
  assert.equal(custom.homeGrid, 'JO32me');
  assert.equal(custom.ctyUrl, 'https://hamrig.com/big-cty.dat');
  for (const word of ['0', 'no', 'off', 'FALSE', 'disabled']) assert.equal(parseHamrigEnv({ HAMRIG_ENABLED: word }).enabled, false, word);
  for (const word of ['1', 'yes', 'true', 'on', '']) assert.equal(parseHamrigEnv({ HAMRIG_ENABLED: word }).enabled, true, word);
  assert.equal(parseHamrigEnv({ HAMRIG_HOME_GRID: 'nope' }).homeGrid, null);
  assert.equal(parseHamrigEnv({ HAMRIG_HOME_GRID: 'JJ00AA' }).homeGrid, null);
  for (const word of ['1', 'yes', 'true', 'on']) assert.equal(parseHamrigEnv({ HAMRIG_SOTA_ENABLED: word }).sotaEnabled, true, word);
  for (const word of ['', '0', 'no', 'off', 'false']) assert.equal(parseHamrigEnv({ HAMRIG_SOTA_ENABLED: word }).sotaEnabled, false, `sota ${word || '(unset)'}`);
});

test('/activations leaves SOTA out until HAMRIG_SOTA_ENABLED opts in (SOTA API terms need prior approval)', async () => {
  const h = harness();
  const body = assertEnvelope(await h.call('/activations'));
  assert.deepEqual(body.programs, ['POTA', 'WWFF', 'BOTA']);
  assert.ok(!body.activations.some((a) => a.program === 'SOTA'), 'no SOTA rows when disabled');
  assert.match(body.errors.SOTA, /disabled by configuration.*HAMRIG_SOTA_ENABLED=1/);
  assert.ok(!h.fetch.calls.some((url) => String(url).includes('sota.org.uk')), 'SOTA must not be contacted');
  const only = await h.call('/activations?programs=sota');
  assert.equal(only.status, 200);
  assert.deepEqual(only.json().activations, []);
  assert.match(only.json().errors.SOTA, /disabled by configuration/);
  const opted = harness({ config: { sotaEnabled: true } });
  const optedBody = assertEnvelope(await opted.call('/activations?programs=sota'));
  assert.ok(optedBody.activations.length > 0 && optedBody.activations.every((a) => a.program === 'SOTA'));
  assert.equal(optedBody.errors.SOTA, undefined);
});

function fakeServer() {
  const uses = [];
  return { uses, middlewares: { use: (mount, handler) => uses.push({ mount, handler }) } };
}

test('hamrigProxyPlugin installs on dev + preview servers, builds the runtime once and lazily', async () => {
  const log = createLog();
  let builds = 0;
  const runtime = { client: fakeClient(HAMRIG_ROUTES), cty: fakeCty(), geolocator: fakeGeolocator(), spotFeed: fakeSpotFeed() };
  const plugin = hamrigProxyPlugin({ HAMRIG_HOME_GRID: 'JO32' }, { log, now: createClock(), buildRuntimeImpl: async () => { builds += 1; return runtime; } });
  assert.equal(plugin.name, 'hamrig-proxy');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  assert.equal(plugin.hamrigConfig.homeGrid, 'JO32');
  assert.equal(plugin.hamrigConfig.enabled, true);

  const dev = fakeServer();
  const preview = fakeServer();
  plugin.configureServer(dev);
  plugin.configurePreviewServer(preview);
  assert.equal(dev.uses[0].mount, HAMRIG_MOUNT_PATH);
  assert.equal(preview.uses[0].mount, '/api/hamrig');
  assert.equal(builds, 0, 'nothing built until the first request');

  const res1 = fakeRes();
  const res2 = fakeRes();
  await Promise.all([
    dev.uses[0].handler(fakeReq('GET', '/status'), res1, () => {}),
    preview.uses[0].handler(fakeReq('GET', '/spots'), res2, () => {}),
  ]);
  assert.equal(builds, 1, 'concurrent first requests share one build');
  assert.equal(res1.status, 200);
  assert.equal(res1.json().homeGrid, 'JO32');
  assert.equal(res2.status, 200);
  assert.equal(res2.json().spots.length, SPOTS.length);
  const res3 = fakeRes();
  await dev.uses[0].handler(fakeReq('GET', '/status'), res3, () => {});
  assert.equal(builds, 1);
  assert.equal(await plugin.hamrigRuntime(), runtime);
});

test('HAMRIG_ENABLED=0 makes the plugin answer 503 for every /api/hamrig/* path and build nothing', async () => {
  let builds = 0;
  const plugin = hamrigProxyPlugin({ HAMRIG_ENABLED: '0', HAMRIG_PASSWORD: 'hunter2' }, { log: createLog(), buildRuntimeImpl: async () => { builds += 1; return {}; } });
  assert.equal(plugin.hamrigConfig.password, '***', 'config hook redacts the password');
  const server = fakeServer();
  plugin.configureServer(server);
  for (const url of ['/status', '/spots', '/station/DH5DAX', '/my/rotators']) {
    const res = fakeRes();
    await server.uses[0].handler(fakeReq('GET', url), res, () => {});
    assert.equal(res.status, 503, url);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.json().error, 'HamRig integration disabled');
    assertNoPii(res.body);
  }
  const post = fakeRes();
  await server.uses[0].handler(fakeReq('POST', '/locate', { calls: ['DH5DAX'] }), post, () => {});
  assert.equal(post.status, 503);
  assert.equal(builds, 0);
  assert.equal(await plugin.hamrigRuntime(), null);
});

test('a runtime that fails to build answers 502 and retries on the next request', async () => {
  const log = createLog();
  let attempts = 0;
  const runtime = { client: fakeClient(HAMRIG_ROUTES), cty: fakeCty(), geolocator: fakeGeolocator(), spotFeed: fakeSpotFeed() };
  const plugin = hamrigProxyPlugin({}, {
    log,
    buildRuntimeImpl: async () => { attempts += 1; if (attempts === 1) throw new Error('cty dir unwritable'); return runtime; },
  });
  const server = fakeServer();
  plugin.configureServer(server);
  const first = fakeRes();
  await server.uses[0].handler(fakeReq('GET', '/status'), first, () => {});
  assert.equal(first.status, 502);
  assert.equal(first.json().error, 'HamRig integration failed to start');
  assert.ok(log.lines.some((line) => line.includes('cty dir unwritable')));
  const second = fakeRes();
  await server.uses[0].handler(fakeReq('GET', '/status'), second, () => {});
  assert.equal(second.status, 200);
  assert.equal(attempts, 2);
});

test('the real buildRuntime wires client, cty, geolocator and spot feed without touching the network', async () => {
  const log = createLog();
  const fetchImpl = async () => { throw new Error('network disabled in test'); };
  const plugin = hamrigProxyPlugin(
    { HAMRIG_BASE_URL: 'https://test.hamrig.com', HAMRIG_SPOTS_WS_URL: 'wss://test.hamrig.com:8777', HAMRIG_CTY_URL: 'https://example.invalid/cty.dat' },
    { log, fetchImpl },
  );
  const runtime = await plugin.hamrigRuntime();
  assert.equal(runtime.client.configured, true);
  assert.equal(runtime.client.status().baseUrl, 'https://test.hamrig.com');
  assert.equal(typeof runtime.cty.resolve, 'function');
  assert.equal(typeof runtime.geolocator.locateMany, 'function');
  assert.equal(typeof runtime.spotFeed.getSpots, 'function');
  const server = fakeServer();
  plugin.configureServer(server);
  const res = fakeRes();
  await server.uses[0].handler(fakeReq('GET', '/status'), res, () => {});
  assert.equal(res.status, 200);
  assert.equal(res.json().configured, true);
  assert.deepEqual(res.json().features, { spotsLive: true, myStation: false, sota: false });
  runtime.spotFeed.stop();
});

test('an insecure spots WebSocket URL disables the live feed but keeps the rest of the runtime', async () => {
  const log = createLog();
  const plugin = hamrigProxyPlugin(
    { HAMRIG_SPOTS_WS_URL: 'ws://hamrig.com:8777', HAMRIG_CTY_URL: 'https://example.invalid/cty.dat' },
    { log, fetchImpl: async () => { throw new Error('offline'); } },
  );
  const runtime = await plugin.hamrigRuntime();
  assert.equal(runtime.spotFeed, null);
  assert.ok(log.lines.some((line) => line.includes('HAMRIG_SPOTS_WS_URL')));
  const server = fakeServer();
  plugin.configureServer(server);
  const res = fakeRes();
  await server.uses[0].handler(fakeReq('GET', '/spots'), res, () => {});
  assert.equal(res.status, 502);
});
