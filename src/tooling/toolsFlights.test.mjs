import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolsHandler } from '../../server/serverless/tools-route.js';
import { toolIndex } from '../../server/tools/registry.js';
import { createPluginInvoker } from '../../server/tools/_invoke.js';
import { fetchUpstreamJson } from '../../server/providers/common/upstream.js';
import {
  bboxFrom,
  createFlightTools,
  normalizeOpenSkyState,
  normalizeReadsbAircraft,
  plugin,
  readsbNowMs,
  tools,
  worstStatus,
} from '../../server/tools/flights.js';

// A fake platform credential: it must never appear in any tool answer.
const FAKE_SECRET = 'fixture-ondemand-api-key-DO-NOT-LEAK';
process.env.ONDEMAND_API_KEY = FAKE_SECRET;

const NOW = new Date('2026-09-18T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const AUSTIN = { lat: 30.27, lon: -97.74 };

/** OpenSky state vectors around Austin: airborne near, on ground, airborne ~100 nm out. */
const OPENSKY_STATES = [
  ['abe124', 'SWA3614 ', 'United States', NOW_SEC - 2, NOW_SEC - 1, -97.6602, 30.2943, 594.36, false, 89.0, 179.3, -4.23, null, 670.56, '1350', false, 0, 3],
  ['a1b2c3', 'GROUND1 ', 'United States', NOW_SEC - 3, NOW_SEC - 3, -97.67, 30.19, null, true, 5.1, 90, 0, null, null, '7000', false, 0, 3],
  ['c0ffee', 'FAR100  ', 'Mexico', NOW_SEC - 4, NOW_SEC - 4, -97.0, 31.7, 11277.6, false, 240.0, 45, 0, null, 11582.4, null, false, 0, 5],
  ['badbad', 'NOPOS   ', 'Canada', null, NOW_SEC - 9, null, null, 9000, false, 200, 10, 0, null, null, null, false, 0, 3],
];

/** readsb rows (adsb.lol / adsb.fi shape). */
const READSB_ROW = {
  hex: 'AE6477',
  type: 'adsb_icao',
  flight: 'ROPER91 ',
  r: '17-5904',
  t: 'C30J',
  desc: 'LOCKHEED MARTIN C-130J Hercules',
  dbFlags: 1,
  alt_baro: 8825,
  alt_geom: 9425,
  gs: 275,
  track: 318.8,
  baro_rate: 1540,
  squawk: '5211',
  emergency: 'none',
  category: 'A3',
  lat: 30.065018,
  lon: -96.884363,
  seen_pos: 0.4,
  seen: 0.1,
};

function invokeRoute(handler, url, method = 'GET') {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      end: (body) =>
        resolve({
          status: res.statusCode,
          headers,
          body: body ? JSON.parse(body) : null,
        }),
    };
    handler({ url, method, on() {} }, res);
  });
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

const anonymousOpenSky = (t) =>
  environment(t, {
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
    OPENSKY_USERNAME: undefined,
    OPENSKY_PASSWORD: undefined,
    AIRPLANES_LIVE_ENABLED: undefined,
  });

const silence = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
};

/** The OpenSky proxy judges snapshot age with Date.now(); pin it to the fixture clock. */
const pinClock = (t) => t.mock.method(Date, 'now', () => NOW.getTime());

const connectTimeout = () =>
  Object.assign(new Error('fetch failed'), {
    cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
  });

/** A private OpenSky module instance: breaker, cooldown and caches start cold. */
let freshModules = 0;
const freshOpenSkyInvoker = async () => {
  const mod = await import(
    `../../server/providers/aircraft/opensky.js?fresh=${++freshModules}-${Date.now()}`
  );
  return createPluginInvoker(() => mod.openSkyProxy());
};

/** fetchUpstreamJson without real backoff sleeps. */
const quickFetchJson = (url, options) =>
  fetchUpstreamJson(url, { ...options, sleep: async () => {} });

const ctx = () => ({ now: () => NOW, env: {}, signal: undefined });

test('flights: plugin descriptor and tool list are well-formed', () => {
  assert.equal(plugin.id, 'flights');
  assert.match(plugin.name, /OpenSky/);
  assert.ok(plugin.conversationStarters.length >= 3);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['flights_in_bbox', 'flight_by_icao24'],
  );
  assert.equal(tools[0].cacheSeconds, 10);
  assert.equal(tools[1].cacheSeconds, 10);
  for (const tool of tools) {
    assert.ok(tool.summary && tool.description);
    for (const [key, rule] of Object.entries(tool.params))
      assert.ok(rule.description, `${tool.name}.${key} has a description`);
  }
});

test('flights: normalisers map OpenSky state vectors and readsb rows to named fields', () => {
  const row = normalizeOpenSkyState(OPENSKY_STATES[0], AUSTIN);
  assert.equal(row.icao24, 'abe124');
  assert.equal(row.callsign, 'SWA3614');
  assert.equal(row.originCountry, 'United States');
  assert.equal(row.lat, 30.2943);
  assert.equal(row.lon, -97.6602);
  assert.equal(row.baroAltM, 594);
  assert.equal(row.geoAltM, 671);
  assert.equal(row.velocityMs, 89);
  assert.equal(row.headingDeg, 179.3);
  assert.equal(row.verticalRateMs, -4.23);
  assert.equal(row.onGround, false);
  assert.equal(row.squawk, '1350');
  assert.equal(row.lastContactUtc, new Date((NOW_SEC - 1) * 1000).toISOString());
  assert.ok(row.distanceNm > 4 && row.distanceNm < 5, `distance ${row.distanceNm}`);
  assert.equal(normalizeOpenSkyState(OPENSKY_STATES[3], AUSTIN), null, 'no position → dropped');
  assert.equal(normalizeOpenSkyState('nope', AUSTIN), null);

  const ac = normalizeReadsbAircraft(READSB_ROW, { scene: AUSTIN, nowMs: NOW.getTime() });
  assert.equal(ac.icao24, 'ae6477');
  assert.equal(ac.callsign, 'ROPER91');
  assert.equal(ac.registration, '17-5904');
  assert.equal(ac.type, 'C30J');
  assert.equal(ac.description, 'LOCKHEED MARTIN C-130J Hercules');
  assert.equal(ac.baroAltFt, 8825);
  assert.equal(ac.geoAltFt, 9425);
  assert.equal(ac.groundSpeedKt, 275);
  assert.equal(ac.trackDeg, 318.8);
  assert.equal(ac.verticalRateFpm, 1540);
  assert.equal(ac.squawk, '5211');
  assert.equal(ac.emergency, null);
  assert.equal(ac.seenSec, 0.1);
  assert.equal(ac.military, true);
  assert.equal(ac.onGround, false);
  assert.ok(ac.distanceNm > 45 && ac.distanceNm < 48, `distance ${ac.distanceNm}`);
  const ground = normalizeReadsbAircraft({ hex: 'abc', alt_baro: 'ground', dbFlags: 0 });
  assert.equal(ground.onGround, true);
  assert.equal(ground.baroAltFt, 0);
  assert.equal(ground.military, false);
  assert.equal(ground.lat, null);
  assert.equal(normalizeReadsbAircraft({ hex: 'abc' }, { requirePosition: true }), null);
  assert.equal(normalizeReadsbAircraft(null), null);

  assert.equal(readsbNowMs(1789748375500), 1789748375500);
  assert.equal(readsbNowMs(1789748375.5), 1789748375500);
  assert.equal(readsbNowMs(undefined, 42), 42);
  assert.equal(worstStatus('live', 'degraded', 'stale'), 'degraded');
  assert.equal(worstStatus(), 'live');
  assert.deepEqual(bboxFrom({ lamin: 1, lomin: 2, lamax: 3, lomax: 4 }), { lamin: 1, lomin: 2, lamax: 3, lomax: 4 });
  assert.equal(bboxFrom({ lamin: 1, lomin: 2, lamax: 3 }), null);
  assert.equal(bboxFrom({ lamin: 5, lomin: 2, lamax: 3, lomax: 4 }), null, 'inverted box');
});

test('flights: flights_in_bbox through the registered tool + tools route (real OpenSky proxy, offline fixture) is live, sorted and filtered', async (t) => {
  anonymousOpenSky(t);
  silence(t);
  pinClock(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url).includes('opensky-network.org/api/states/all')) {
      return Response.json({ time: NOW_SEC, states: OPENSKY_STATES });
    }
    throw Error(`tests must stay offline; unexpected fetch ${url}`);
  });
  const handler = createToolsHandler({ index: toolIndex(), now: () => NOW });
  const res = await invokeRoute(handler, '/flights_in_bbox?lat=30.27&lon=-97.74&radiusNm=50');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers['x-tools-route'], 'ondemand-spatial');
  assert.match(res.headers['cache-control'], /s-maxage=10/);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tool, 'flights_in_bbox');
  assert.deepEqual(res.body.params, { lat: 30.27, lon: -97.74, radiusNm: 50, limit: 200, onGround: false });
  const { data } = res.body;
  assert.deepEqual(data.scene, { lat: 30.27, lon: -97.74, radiusNm: 50, onGround: false });
  assert.equal(data.sourceFeed, 'OpenSky Network');
  assert.match(data.coverage, /scene box around 30\.25,-97\.75/);
  assert.equal(data.snapshotUtc, NOW.toISOString());
  assert.equal(data.upstreamStates, 4);
  assert.equal(data.total, 1, 'ground and >50 nm rows are excluded');
  assert.equal(data.count, 1);
  assert.equal(data.flights[0].icao24, 'abe124');
  assert.equal(data.flights[0].callsign, 'SWA3614');
  assert.equal(res.body.provider.status, 'live');
  assert.equal(res.body.provider.source, 'OpenSky Network');
  assert.equal(res.body.provenance.completeness, 'partial');
  assert.equal(res.body.provenance.upstream, 'OpenSky Network');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /lamin=28\.75&lomin=-99\.25&lamax=31\.75&lomax=-96\.25/);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_SECRET));

  // Wider radius + onGround via the same cached scene: no new upstream call.
  const wide = await invokeRoute(handler, '/flights_in_bbox?lat=30.27&lon=-97.74&radiusNm=150&onGround=true&limit=2');
  assert.equal(wide.status, 200);
  assert.equal(wide.body.data.total, 3);
  assert.equal(wide.body.data.count, 2, 'limit caps the array');
  assert.deepEqual(wide.body.data.flights.map((f) => f.icao24), ['abe124', 'a1b2c3']);
  assert.ok(wide.body.data.flights[0].distanceNm <= wide.body.data.flights[1].distanceNm);
  assert.equal(calls.length, 1, 'served from the proxy cache');

  // An explicit bounding box replaces the radius filter.
  const box = await invokeRoute(handler, '/flights_in_bbox?lat=30.27&lon=-97.74&lamin=31&lomin=-98&lamax=32&lomax=-96');
  assert.equal(box.status, 200);
  assert.deepEqual(box.body.data.scene.bbox, { lamin: 31, lomin: -98, lamax: 32, lomax: -96 });
  assert.deepEqual(box.body.data.flights.map((f) => f.icao24), ['c0ffee']);
});

test('flights: degraded propagation — OpenSky unreachable, adsb.lol regional feed answers (real proxy, offline)', async (t) => {
  anonymousOpenSky(t);
  silence(t);
  pinClock(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url).includes('opensky-network.org')) throw connectTimeout();
    if (String(url).includes('api.adsb.lol/v2/lat/')) {
      return Response.json({
        now: NOW.getTime(),
        ac: [
          { ...READSB_ROW, hex: 'a0b1c2', flight: 'REG1    ', lat: 30.3, lon: -97.7, dbFlags: 0 },
          { ...READSB_ROW, hex: 'a0b1c3', flight: 'REG2    ', lat: 30.9, lon: -97.7, dbFlags: 0 },
        ],
      });
    }
    throw Error(`tests must stay offline; unexpected fetch ${url}`);
  });
  const [flightsInBbox] = createFlightTools({ invoke: await freshOpenSkyInvoker() });
  const result = await flightsInBbox.handler(
    { lat: 30.27, lon: -97.74, radiusNm: 150, limit: 200, onGround: false },
    ctx(),
  );
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.provider.status, 'degraded');
  assert.equal(result.provider.source, 'adsb.lol');
  assert.match(result.provider.error, /OpenSky unreachable/);
  assert.equal(result.data.sourceFeed, 'adsb.lol');
  assert.match(result.data.coverage, /regional fallback/);
  assert.equal(result.data.count, 2);
  assert.deepEqual(result.data.flights.map((f) => f.callsign), ['REG1', 'REG2']);
  assert.equal(result.provenance.upstream, 'adsb.lol');
  assert.ok(calls.some((u) => u.includes('opensky-network.org')));
  assert.ok(calls.some((u) => u.includes('api.adsb.lol')));
  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET));
});

test('flights: unavailable propagation — every feed down is a structured 503, never a throw', async (t) => {
  anonymousOpenSky(t);
  silence(t);
  pinClock(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw connectTimeout();
  });
  const flightTools = createFlightTools({ invoke: await freshOpenSkyInvoker() });
  const [flightsInBbox] = flightTools;
  const result = await flightsInBbox.handler(
    { lat: 48.85, lon: 2.35, radiusNm: 150, limit: 200, onGround: false },
    ctx(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error.code, 'upstream_unavailable');
  assert.match(result.error.message, /OpenSky/);
  assert.equal(result.provider.status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET));

  const handler = createToolsHandler({
    index: new Map(flightTools.map((tool) => [tool.name, tool])),
    now: () => NOW,
  });
  const http = await invokeRoute(handler, '/flights_in_bbox?lat=48.85&lon=2.35');
  assert.equal(http.status, 503);
  assert.equal(http.body.error.code, 'upstream_unavailable');
  assert.equal(http.body.provider.status, 'unavailable');
  assert.equal(http.headers['cache-control'], 'no-store');
});

test('flights: flight_by_icao24 — adsb.lol hit, adsb.fi fall-back (degraded), 404 not_found and 503 unavailable', async (t) => {
  silence(t);
  let mode = 'lol';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    calls.push(target);
    const isLol = target.startsWith('https://api.adsb.lol/v2/hex/');
    const isFi = target.startsWith('https://opendata.adsb.fi/api/v2/hex/');
    if (!isLol && !isFi) throw Error(`tests must stay offline; unexpected fetch ${url}`);
    if (mode === 'down') throw connectTimeout();
    if (mode === 'empty') return Response.json({ ac: [], msg: 'No error', now: NOW.getTime(), total: 0 });
    if (mode === 'fi') {
      if (isLol) return new Response('', { status: 503 });
      return Response.json({ ac: [READSB_ROW], msg: 'No error', now: NOW.getTime(), total: 1 });
    }
    // mode === 'lol'
    if (isLol) return Response.json({ ac: [READSB_ROW], msg: 'No error', now: NOW.getTime() - 3000, total: 1 });
    throw Error('adsb.fi must not be asked when adsb.lol answered');
  });
  const [, byHex] = createFlightTools({ fetchJson: quickFetchJson });

  const hit = await byHex.handler({ icao24: 'AE6477' }, ctx());
  assert.equal(hit.ok, true, JSON.stringify(hit.error));
  assert.equal(hit.data.icao24, 'ae6477');
  assert.equal(hit.data.sourceFeed, 'adsb.lol');
  assert.equal(hit.data.snapshotUtc, new Date(NOW.getTime() - 3000).toISOString());
  assert.equal(hit.data.aircraft.callsign, 'ROPER91');
  assert.equal(hit.data.aircraft.registration, '17-5904');
  assert.equal(hit.data.aircraft.type, 'C30J');
  assert.equal(hit.data.aircraft.military, true);
  assert.equal(hit.data.aircraft.baroAltFt, 8825);
  assert.equal(hit.data.aircraft.groundSpeedKt, 275);
  assert.equal(hit.provider.status, 'live');
  assert.equal(hit.provider.ageSec, 3);
  assert.equal(hit.provenance.upstream, 'adsb.lol');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://api.adsb.lol/v2/hex/ae6477');

  mode = 'fi';
  calls.length = 0;
  const fallback = await byHex.handler({ icao24: 'ae6477' }, ctx());
  assert.equal(fallback.ok, true, JSON.stringify(fallback.error));
  assert.equal(fallback.data.sourceFeed, 'adsb.fi');
  assert.equal(fallback.provider.status, 'degraded');
  assert.equal(fallback.provider.source, 'adsb.fi');
  assert.match(fallback.provider.error, /adsb\.lol HTTP 503/);
  assert.deepEqual(fallback.provenance.failedFeeds.map((f) => f.source), ['adsb.lol']);
  assert.equal(calls.filter((u) => u.includes('adsb.lol')).length, 2, 'one retry on a 5xx');
  assert.equal(calls.filter((u) => u.includes('adsb.fi')).length, 1);

  mode = 'empty';
  const missing = await byHex.handler({ icao24: 'ffffff' }, ctx());
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  assert.equal(missing.error.code, 'not_found');
  assert.match(missing.error.message, /ffffff/);
  assert.equal(missing.provider.status, 'live');
  assert.equal(missing.provider.count, 0);

  mode = 'down';
  const down = await byHex.handler({ icao24: 'ae6477' }, ctx());
  assert.equal(down.ok, false);
  assert.equal(down.status, 503);
  assert.equal(down.error.code, 'upstream_unavailable');
  assert.match(down.error.message, /adsb\.lol/);
  assert.match(down.error.message, /adsb\.fi/);
  assert.equal(down.provider.status, 'unavailable');
  assert.ok(!JSON.stringify([hit, fallback, missing, down]).includes(FAKE_SECRET));
});

test('flights: the registered tools validate query params through the tools route (400 unknown_param / invalid_param) without any network call', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    throw Error(`validation must not reach the network: ${url}`);
  });
  const handler = createToolsHandler({ index: toolIndex(), now: () => NOW });
  const unknown = await invokeRoute(handler, '/flights_in_bbox?lat=30.27&lon=-97.74&bogus=1');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_param');
  assert.equal(unknown.body.error.param, 'bogus');
  assert.match(unknown.body.error.message, /allowed: lat, lon, radiusNm, lamin, lomin, lamax, lomax, limit, onGround/);
  const radius = await invokeRoute(handler, '/flights_in_bbox?lat=30.27&lon=-97.74&radiusNm=1000');
  assert.equal(radius.status, 400);
  assert.equal(radius.body.error.code, 'invalid_param');
  const missing = await invokeRoute(handler, '/flights_in_bbox?lat=30.27');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'missing_param');
  const badHex = await invokeRoute(handler, '/flight_by_icao24?icao24=xyz123');
  assert.equal(badHex.status, 400);
  assert.equal(badHex.body.error.code, 'invalid_param');
  assert.equal(badHex.body.error.param, 'icao24');
  const longHex = await invokeRoute(handler, '/flight_by_icao24?icao24=ae64770');
  assert.equal(longHex.status, 400);
  const unknownHexParam = await invokeRoute(handler, '/flight_by_icao24?icao24=ae6477&hex=1');
  assert.equal(unknownHexParam.status, 400);
  assert.equal(unknownHexParam.body.error.code, 'unknown_param');
  assert.ok(!JSON.stringify([unknown.body, badHex.body]).includes(FAKE_SECRET));
});
