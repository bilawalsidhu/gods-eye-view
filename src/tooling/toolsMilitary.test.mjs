import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolsHandler } from '../../server/serverless/tools-route.js';
import { toolIndex } from '../../server/tools/registry.js';
import { createPluginInvoker } from '../../server/tools/_invoke.js';
import { adsbLolProxy } from '../../server/providers/aircraft/adsb-lol.js';
import { distanceNm } from '../../server/providers/common/upstream.js';
import {
  createMilitaryTools,
  plugin,
  radiusCoveringBbox,
  tools,
} from '../../server/tools/military.js';

// A fake platform credential: it must never appear in any tool answer.
const FAKE_SECRET = 'fixture-ondemand-api-key-DO-NOT-LEAK';
process.env.ONDEMAND_API_KEY = FAKE_SECRET;

const NOW = new Date('2026-09-18T12:00:00.000Z');
const SNAPSHOT_MS = NOW.getTime() - 2000;

const ROPER91 = {
  hex: 'ae6477',
  type: 'adsb_icao',
  flight: 'ROPER91 ',
  r: '17-5904',
  t: 'C30J',
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
/** Worldwide /v2/mil list: one near Austin, one over Europe, one 880 nm away, one without a position. */
const MIL_ROWS = [
  { ...ROPER91, hex: 'ae1234', flight: 'RCH512  ', r: '07-7180', t: 'C17', lat: 35.0, lon: -80.0 },
  ROPER91,
  { ...ROPER91, hex: '43c6e2', flight: 'RRR7204 ', r: 'ZZ338', t: 'A332', lat: 51.5, lon: -1.0 },
  { hex: 'ae0000', type: 'adsb_icao', flight: 'NOPOS   ', dbFlags: 1, alt_baro: 25000, seen: 12 },
];

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

const silence = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
};
const pinClock = (t) => t.mock.method(Date, 'now', () => NOW.getTime());
const connectTimeout = () =>
  Object.assign(new Error('fetch failed'), {
    cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
  });

/** A private adsb.lol proxy instance: cold caches and cooldowns. */
const freshInvoker = () => createPluginInvoker(() => adsbLolProxy());

/**
 * Offline feeds: `lol` / `fi` are 'rows' (answer the fixture), 'down' (network
 * error) or an HTTP status number.
 */
function mockFeeds(t, { lol = 'rows', fi = 'rows' } = {}) {
  const calls = [];
  environment(t, { AIRPLANES_LIVE_ENABLED: undefined });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    calls.push(target);
    let mode;
    if (target === 'https://api.adsb.lol/v2/mil') mode = lol;
    else if (target === 'https://opendata.adsb.fi/api/v2/mil') mode = fi;
    else throw Error(`tests must stay offline; unexpected fetch ${url}`);
    if (mode === 'down') throw connectTimeout();
    if (typeof mode === 'number') return new Response('', { status: mode });
    return Response.json({ ac: MIL_ROWS, msg: 'No error', now: SNAPSHOT_MS, total: MIL_ROWS.length });
  });
  return calls;
}

const ctx = () => ({ now: () => NOW, env: {}, signal: undefined });

test('military: plugin descriptor and tool list are well-formed', () => {
  assert.equal(plugin.id, 'military');
  assert.match(plugin.name, /adsb\.lol/);
  assert.ok(plugin.conversationStarters.length >= 3);
  assert.deepEqual(tools.map((t) => t.name), ['military_flights_in_bbox']);
  assert.equal(tools[0].cacheSeconds, 12);
  assert.ok(tools[0].summary && tools[0].description);
  for (const [key, rule] of Object.entries(tools[0].params))
    assert.ok(rule.description, `${key} has a description`);
  assert.equal(tools[0].params.radiusNm.default, 600);
});

test('military: radiusCoveringBbox reaches every corner of the box and is capped at the proxy ceiling', () => {
  const bbox = { lamin: 54, lomin: 10, lamax: 60, lomax: 30 };
  const radius = radiusCoveringBbox(57, 20, bbox);
  for (const [la, lo] of [[54, 10], [54, 30], [60, 10], [60, 30]])
    assert.ok(distanceNm(57, 20, la, lo) <= radius, `corner ${la},${lo} inside ${radius} nm`);
  assert.ok(radius < 400, `tight bound, got ${radius}`);
  assert.equal(radiusCoveringBbox(0, 0, { lamin: -89, lomin: -179, lamax: 89, lomax: 179 }), 5000);
});

test('military: military_flights_in_bbox through the registered tool + tools route (real adsb.lol proxy, offline fixture)', async (t) => {
  silence(t);
  pinClock(t);
  const calls = mockFeeds(t);
  const handler = createToolsHandler({ index: toolIndex(), now: () => NOW });
  const res = await invokeRoute(handler, '/military_flights_in_bbox?lat=30.27&lon=-97.74');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers['x-tools-route'], 'ondemand-spatial');
  assert.match(res.headers['cache-control'], /s-maxage=12/);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.tool, 'military_flights_in_bbox');
  assert.deepEqual(res.body.params, { lat: 30.27, lon: -97.74, radiusNm: 600, limit: 200 });
  const { data } = res.body;
  assert.deepEqual(data.scene, { lat: 30.27, lon: -97.74, radiusNm: 600 });
  assert.equal(data.sourceFeed, 'adsb.lol');
  assert.equal(data.coverage, '600nm around 30.27,-97.74');
  assert.equal(data.snapshotUtc, new Date(SNAPSHOT_MS).toISOString());
  assert.equal(data.total, 1, 'the 880 nm row, the European row and the positionless row are out');
  assert.equal(data.count, 1);
  const ac = data.aircraft[0];
  assert.equal(ac.icao24, 'ae6477');
  assert.equal(ac.callsign, 'ROPER91');
  assert.equal(ac.registration, '17-5904');
  assert.equal(ac.type, 'C30J');
  assert.equal(ac.military, true);
  assert.equal(ac.baroAltFt, 8825);
  assert.equal(ac.groundSpeedKt, 275);
  assert.equal(ac.squawk, '5211');
  assert.ok(ac.distanceNm > 45 && ac.distanceNm < 48, `distance ${ac.distanceNm}`);
  assert.equal(res.body.provider.status, 'live');
  assert.equal(res.body.provider.source, 'adsb.lol');
  assert.equal(res.body.provider.count, 1, 'the proxy counts the scene-filtered rows');
  assert.equal(res.body.provenance.completeness, 'partial');
  assert.equal(res.body.provenance.upstream, 'adsb.lol');
  assert.equal(res.body.provenance.cache, 'MISS');
  assert.deepEqual(calls, ['https://api.adsb.lol/v2/mil']);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_SECRET));

  // A second scene within the 12 s cache window reuses the worldwide list.
  const europe = await invokeRoute(handler, '/military_flights_in_bbox?lat=51.5&lon=-0.12&radiusNm=100&limit=1');
  assert.equal(europe.status, 200);
  assert.deepEqual(europe.body.data.aircraft.map((a) => a.callsign), ['RRR7204']);
  assert.equal(europe.body.provenance.cache, 'HIT');
  assert.equal(calls.length, 1, 'no second upstream fetch');

  // Radius 1500 from Austin reaches the 880 nm C-17 too, nearest first, capped by limit.
  const wide = await invokeRoute(handler, '/military_flights_in_bbox?lat=30.27&lon=-97.74&radiusNm=1500&limit=5');
  assert.deepEqual(wide.body.data.aircraft.map((a) => a.callsign), ['ROPER91', 'RCH512']);
  assert.ok(wide.body.data.aircraft[0].distanceNm < wide.body.data.aircraft[1].distanceNm);
});

test('military: an explicit bounding box widens the proxy radius to cover the box and filters rows to it', async () => {
  const seen = [];
  const invoke = async (path) => {
    seen.push(new URL(path, 'http://localhost'));
    return {
      status: 200,
      headers: {
        'x-provider-status': 'live',
        'x-provider-source': 'adsb.lol',
        'x-provider-fetched-at': NOW.toISOString(),
        'x-provider-age-sec': '0',
        'x-provider-count': String(MIL_ROWS.length),
        'x-flight-coverage': '386nm around 57,20',
        'x-ads-b-cache': 'HIT',
      },
      text: '',
      json: { ac: MIL_ROWS, now: SNAPSHOT_MS },
    };
  };
  const [tool] = createMilitaryTools({ invoke });
  // Box over the southern UK: only RRR7204 (51.5, -1.0) is inside.
  const result = await tool.handler(
    { lat: 52, lon: 0, radiusNm: 600, lamin: 50, lomin: -3, lamax: 53, lomax: 2, limit: 200 },
    ctx(),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.scene, { lat: 52, lon: 0, bbox: { lamin: 50, lomin: -3, lamax: 53, lomax: 2 } });
  assert.deepEqual(result.data.aircraft.map((a) => a.callsign), ['RRR7204']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pathname, '/api/adsblol/mil');
  const requested = Number(seen[0].searchParams.get('radiusNm'));
  assert.ok(requested >= distanceNm(52, 0, 50, -3), `radius ${requested} covers the far corner`);
  assert.ok(requested < 200, `and stays tight (${requested})`);
  assert.equal(result.data.coverage, '386nm around 57,20');
});

test('military: degraded propagation — adsb.lol down, adsb.fi answers (real proxy, offline)', async (t) => {
  silence(t);
  pinClock(t);
  const calls = mockFeeds(t, { lol: 503, fi: 'rows' });
  const [tool] = createMilitaryTools({ invoke: freshInvoker() });
  const result = await tool.handler({ lat: 30.27, lon: -97.74, radiusNm: 600, limit: 200 }, ctx());
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.provider.status, 'degraded');
  assert.equal(result.provider.source, 'adsb.fi');
  assert.match(result.provider.error, /adsb\.lol HTTP 503/);
  assert.equal(result.data.sourceFeed, 'adsb.fi');
  assert.equal(result.data.count, 1);
  assert.equal(result.data.aircraft[0].callsign, 'ROPER91');
  assert.equal(result.provenance.upstream, 'adsb.fi');
  assert.ok(calls.includes('https://api.adsb.lol/v2/mil'));
  assert.ok(calls.includes('https://opendata.adsb.fi/api/v2/mil'));
  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET));
});

test('military: unavailable propagation — every feed down is a structured 503, never a throw', async (t) => {
  silence(t);
  pinClock(t);
  mockFeeds(t, { lol: 'down', fi: 'down' });
  const militaryTools = createMilitaryTools({ invoke: freshInvoker() });
  const [tool] = militaryTools;
  const result = await tool.handler({ lat: 30.27, lon: -97.74, radiusNm: 600, limit: 200 }, ctx());
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error.code, 'upstream_unavailable');
  assert.match(result.error.message, /adsb\.lol unreachable/);
  assert.equal(result.provider.status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET));

  const handler = createToolsHandler({
    index: new Map(militaryTools.map((entry) => [entry.name, entry])),
    now: () => NOW,
  });
  const http = await invokeRoute(handler, '/military_flights_in_bbox?lat=30.27&lon=-97.74');
  assert.equal(http.status, 503);
  assert.equal(http.body.ok, false);
  assert.equal(http.body.error.code, 'upstream_unavailable');
  assert.equal(http.body.provider.status, 'unavailable');
  assert.equal(http.headers['cache-control'], 'no-store');
});

test('military: the registered tool validates query params through the tools route (400 unknown_param / invalid_param) without any network call', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    throw Error(`validation must not reach the network: ${url}`);
  });
  const handler = createToolsHandler({ index: toolIndex(), now: () => NOW });
  const unknown = await invokeRoute(handler, '/military_flights_in_bbox?lat=30.27&lon=-97.74&bogus=1');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_param');
  assert.equal(unknown.body.error.param, 'bogus');
  assert.match(unknown.body.error.message, /allowed: lat, lon, radiusNm, lamin, lomin, lamax, lomax, limit/);
  const radius = await invokeRoute(handler, '/military_flights_in_bbox?lat=30.27&lon=-97.74&radiusNm=5');
  assert.equal(radius.status, 400);
  assert.equal(radius.body.error.code, 'invalid_param');
  const missing = await invokeRoute(handler, '/military_flights_in_bbox?lon=-97.74');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'missing_param');
  const limit = await invokeRoute(handler, '/military_flights_in_bbox?lat=30.27&lon=-97.74&limit=2.5');
  assert.equal(limit.status, 400);
  assert.equal(limit.body.error.code, 'invalid_param');
  assert.ok(!JSON.stringify([unknown.body, radius.body]).includes(FAKE_SECRET));
});
