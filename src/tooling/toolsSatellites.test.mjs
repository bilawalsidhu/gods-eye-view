import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { createToolsHandler } from '../../server/serverless/tools-route.js';
import { toolIndex } from '../../server/tools/registry.js';
import { createPluginInvoker } from '../../server/tools/_invoke.js';
import { celestrakProxy } from '../../server/providers/space/celestrak.js';
import {
  createSatelliteTools,
  findPasses,
  haversineKm,
  mergeProviders,
  observe,
  parseTleText,
  plugin,
  satrecFor,
  tleEpochUtc,
  tools,
} from '../../server/tools/satellites.js';

// A fake platform credential: it must never appear in any tool answer.
const FAKE_SECRET = 'fixture-ondemand-api-key-DO-NOT-LEAK';
process.env.ONDEMAND_API_KEY = FAKE_SECRET;

const ISS_TLE = [
  'ISS (ZARYA)             ',
  '1 25544U 98067A   26261.14280998  .00005718  00000+0  11125-3 0  9991',
  '2 25544  51.6307 200.0361 0004822 152.4527 207.6718 15.49160218586162',
].join('\n');
// CRLF line endings on purpose: CelesTrak serves them.
const CSS_TLE = [
  'CSS (TIANHE)            ',
  '1 48274U 21035A   26261.29773936  .00016929  00000+0  20659-3 0  9990',
  '2 48274  41.4677 116.6699 0002625 287.9042  72.1510 15.60068670307703',
].join('\r\n');
const STATIONS_TLE = `${ISS_TLE}\n${CSS_TLE}\r\n`;
const NOW = new Date('2026-09-18T12:00:00.000Z');
const LONDON = { lat: 51.5074, lon: -0.1278 };

/** Node-test HTTP shim for createToolsHandler (same shape as toolsRoute.test.mjs). */
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

/** Keep the CelesTrak proxy off the repository's .gev-cache disk cache. */
function isolateDisk(t) {
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no disk cache in tests');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no disk cache in tests');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
}

/** A private CelesTrak proxy instance (cold caches, no snapshot, no backoff sleeps). */
function freshInvoker() {
  return createPluginInvoker(() =>
    celestrakProxy({ loadSnapshot: async () => null, sleep: async () => {} }),
  );
}

/** Offline CelesTrak: every group answers the stations fixture, or a 503. */
function mockCelestrak(t, { status = 200, body = STATIONS_TLE } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = new URL(String(url));
    calls.push(target);
    if (!/celestrak\.(org|com)$/.test(target.hostname)) {
      throw Error(`tests must stay offline; unexpected fetch ${target}`);
    }
    if (status !== 200) return new Response('Service Unavailable', { status });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  });
  t.mock.method(console, 'warn', () => {});
  return calls;
}

const ctx = () => ({ now: () => NOW, env: {}, signal: undefined });

test('satellites: plugin descriptor and tool list are well-formed', () => {
  assert.equal(plugin.id, 'satellites');
  assert.match(plugin.name, /CelesTrak/);
  assert.ok(plugin.conversationStarters.length >= 3);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['list_satellites_in_scene', 'satellite_passes'],
  );
  assert.equal(tools[0].cacheSeconds, 60);
  assert.equal(tools[1].cacheSeconds, 300);
  for (const tool of tools) {
    assert.ok(tool.summary && tool.description);
    for (const [key, rule] of Object.entries(tool.params))
      assert.ok(rule.description, `${tool.name}.${key} has a description`);
  }
});

test('satellites: TLE parsing, epoch decoding, haversine and SGP4 observation', () => {
  const records = parseTleText(STATIONS_TLE);
  assert.equal(records.length, 2);
  assert.equal(records[0].name, 'ISS (ZARYA)');
  assert.equal(records[0].noradId, 25544);
  assert.equal(records[1].noradId, 48274);
  assert.equal(tleEpochUtc(records[0].line1), '2026-09-18T03:25:38.782Z');
  assert.equal(parseTleText('garbage\nno tle here').length, 0);
  assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - 111.19) < 0.1);
  const satrec = satrecFor(records[0]);
  assert.ok(satrec);
  const look = observe(satrec, NOW, LONDON);
  assert.ok(look.altKm > 350 && look.altKm < 480, `ISS altitude ${look.altKm}`);
  assert.ok(
    look.velocityKms > 7.5 && look.velocityKms < 7.8,
    `ISS speed ${look.velocityKms}`,
  );
  assert.ok(look.elevationDeg >= -90 && look.elevationDeg <= 90);
  assert.ok(look.azimuthDeg >= 0 && look.azimuthDeg < 360);
  assert.ok(look.rangeKm > 400);
  assert.equal(
    satrecFor({ line1: '1 nonsense', line2: '2 nonsense' }),
    null,
  );
});

test('satellites: mergeProviders takes the worst status and flags failed groups as degraded', () => {
  const live = { status: 'live', source: 'CelesTrak', fetchedAt: '2026-09-18T10:00:00.000Z', ageSec: 10, error: null, count: 20 };
  const stale = { status: 'stale', source: 'CelesTrak (bundled snapshot)', fetchedAt: '2026-09-17T10:00:00.000Z', ageSec: 90000, error: 'CelesTrak HTTP 503', count: 156 };
  assert.equal(mergeProviders([live]).status, 'live');
  const merged = mergeProviders([live, stale]);
  assert.equal(merged.status, 'stale');
  assert.equal(merged.count, 176);
  assert.equal(merged.ageSec, 90000);
  assert.match(merged.source, /CelesTrak/);
  assert.equal(mergeProviders([live], { failedGroups: ['geo'] }).status, 'degraded');
  assert.equal(mergeProviders([], { failedGroups: ['geo'] }).status, 'unavailable');
});

test('satellites: list_satellites_in_scene through the real CelesTrak proxy (offline fixture) finds the ISS over its own sub-satellite point', async (t) => {
  isolateDisk(t);
  const calls = mockCelestrak(t);
  const [list] = createSatelliteTools({ invoke: freshInvoker() });
  // Scene = wherever the fixture ISS is at NOW, so it must be the nearest hit.
  const iss = observe(satrecFor(parseTleText(ISS_TLE)[0]), NOW, null);
  const result = await list.handler(
    {
      lat: iss.lat,
      lon: iss.lon,
      radiusKm: 1500,
      groups: ['stations'],
      minElevationDeg: 0,
      limit: 10,
    },
    ctx(),
  );
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.data.epochUtc, NOW.toISOString());
  assert.equal(result.data.total, 2, 'two catalogue entries');
  assert.ok(result.data.count >= 1);
  const first = result.data.satellites[0];
  assert.equal(first.name, 'ISS (ZARYA)');
  assert.equal(first.noradId, 25544);
  assert.equal(first.group, 'stations');
  assert.ok(first.groundDistanceKm < 1, `ISS ground distance ${first.groundDistanceKm}`);
  assert.ok(first.elevationDeg > 89, `ISS elevation ${first.elevationDeg}`);
  assert.ok(first.altKm > 350 && first.altKm < 480);
  assert.ok(Math.abs(first.rangeKm - first.altKm) < 2);
  assert.equal(first.tleEpochUtc, '2026-09-18T03:25:38.782Z');
  assert.equal(result.provider.status, 'live');
  assert.equal(result.provider.source, 'CelesTrak');
  assert.equal(result.provenance.completeness, 'partial');
  assert.equal(result.provenance.upstream, 'celestrak.org');
  assert.deepEqual(
    result.provenance.groups.map((g) => [g.group, g.ok, g.status, g.tleSource, g.satellites]),
    [['stations', true, 'live', 'celestrak.org', 2]],
  );
  assert.equal(calls.length, 1, 'one upstream fetch for one group');
  assert.equal(calls[0].searchParams.get('GROUP'), 'stations');
  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET));

  // Same instance, second call: served from the proxy's memory cache, no new fetch,
  // and the elevation filter drops everything below the horizon.
  const below = await list.handler(
    { lat: -iss.lat, lon: ((iss.lon + 360) % 360) - 180, radiusKm: 6000, groups: ['stations'], minElevationDeg: 0, limit: 10 },
    ctx(),
  );
  assert.equal(below.ok, true);
  assert.equal(below.data.count, 0);
  assert.equal(calls.length, 1, 'cache HIT — no second upstream fetch');
  assert.equal(below.provenance.groups[0].cache, 'HIT');
});

test('satellites: satellite_passes predicts ISS passes over London, flags an in-progress pass and resolves name aliases', async (t) => {
  isolateDisk(t);
  mockCelestrak(t);
  const [, passes] = createSatelliteTools({ invoke: freshInvoker() });
  const base = {
    lat: LONDON.lat,
    lon: LONDON.lon,
    group: 'stations',
    hours: 24,
    minElevationDeg: 10,
    stepSec: 30,
  };
  const result = await passes.handler({ ...base, noradId: 25544 }, ctx());
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.data.satellite, {
    name: 'ISS (ZARYA)',
    noradId: 25544,
    group: 'stations',
    tleEpochUtc: '2026-09-18T03:25:38.782Z',
  });
  assert.equal(result.data.windowStartUtc, NOW.toISOString());
  assert.equal(result.data.windowEndUtc, '2026-09-19T12:00:00.000Z');
  assert.ok(result.data.count >= 1, 'the ISS passes London within 24 h');
  assert.equal(result.data.passes.length, result.data.count);
  for (const pass of result.data.passes) {
    assert.ok(pass.riseUtc < pass.maxUtc && pass.maxUtc < pass.setUtc, JSON.stringify(pass));
    assert.ok(pass.maxElevationDeg >= 10 && pass.maxElevationDeg <= 90);
    assert.ok(pass.durationSec > 30 && pass.durationSec < 1200, `duration ${pass.durationSec}`);
    for (const az of [pass.riseAzimuthDeg, pass.setAzimuthDeg, pass.maxAzimuthDeg])
      assert.ok(az >= 0 && az < 360);
    assert.ok(pass.riseUtc >= result.data.windowStartUtc && pass.setUtc <= result.data.windowEndUtc);
  }
  assert.ok(result.data.current && Number.isFinite(result.data.current.elevationDeg));
  assert.equal(result.provider.status, 'live');
  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET));

  // Start the window at a culmination: that pass is reported as in progress.
  const maxUtc = new Date(result.data.passes[0].maxUtc);
  const during = await passes.handler(
    { ...base, noradId: 25544 },
    { now: () => maxUtc },
  );
  assert.equal(during.ok, true);
  assert.equal(during.data.passes[0].inProgress, true);
  assert.equal(during.data.passes[0].riseUtc, maxUtc.toISOString());

  // Name lookup: alias → catalogue name, case-insensitive substring otherwise.
  const alias = await passes.handler({ ...base, name: 'Tiangong' }, ctx());
  assert.equal(alias.ok, true, JSON.stringify(alias.error));
  assert.equal(alias.data.satellite.name, 'CSS (TIANHE)');
  assert.equal(alias.data.satellite.noradId, 48274);
  assert.equal(alias.data.satellite.matchedName, 'CSS (TIANHE)');
  const substring = await passes.handler({ ...base, name: 'zarya' }, ctx());
  assert.equal(substring.ok, true);
  assert.equal(substring.data.satellite.noradId, 25544);
});

test('satellites: satellite_passes answers 404 not_found for an unknown satellite and 400 for zero/two identifiers', async (t) => {
  isolateDisk(t);
  const calls = mockCelestrak(t);
  const [, passes] = createSatelliteTools({ invoke: freshInvoker() });
  const base = { lat: 0, lon: 0, group: 'stations', hours: 1, minElevationDeg: 10, stepSec: 60 };
  const missing = await passes.handler({ ...base, noradId: 99999 }, ctx());
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  assert.equal(missing.error.code, 'not_found');
  assert.match(missing.error.message, /99999/);
  assert.equal(missing.provider.status, 'live');
  // Every group was searched (stations first, then the rest, starlink last).
  assert.deepEqual(
    calls.map((u) => u.searchParams.get('GROUP')),
    ['stations', 'visual', 'gps-ops', 'glo-ops', 'galileo', 'geo', 'starlink'],
  );
  const neither = await passes.handler(base, ctx());
  assert.equal(neither.status, 400);
  assert.equal(neither.error.code, 'missing_param');
  const both = await passes.handler({ ...base, noradId: 25544, name: 'ISS' }, ctx());
  assert.equal(both.status, 400);
  assert.equal(both.error.code, 'invalid_param');
});

test('satellites: findPasses handles a satellite that never rises and a step that starts mid-pass', () => {
  const satrec = satrecFor(parseTleText(ISS_TLE)[0]);
  // The ISS (51.6° inclination) never rises above 10° at the South Pole.
  const none = findPasses(satrec, { lat: -89.9, lon: 0 }, {
    startMs: NOW.getTime(),
    endMs: NOW.getTime() + 6 * 3_600_000,
    stepSec: 60,
    minElevationDeg: 10,
  });
  assert.deepEqual(none, []);
});

test('satellites: degraded / stale propagation — a snapshot-backed group and a failed group', async () => {
  const answers = {
    stations: {
      status: 200,
      headers: {
        'x-provider-status': 'stale',
        'x-provider-source': 'CelesTrak (bundled snapshot)',
        'x-provider-fetched-at': '2026-09-17T12:00:00.000Z',
        'x-provider-age-sec': '86400',
        'x-provider-error': 'CelesTrak HTTP 503',
        'x-provider-count': '2',
        'x-tle-source': 'snapshot',
        'x-tle-cache': 'SNAPSHOT',
      },
      text: STATIONS_TLE,
      json: null,
    },
    geo: {
      status: 503,
      headers: {
        'x-provider-status': 'unavailable',
        'x-provider-source': 'CelesTrak',
        'x-provider-error': 'CelesTrak unreachable - no cached TLEs for group "geo" on this instance',
        'x-tle-cache': 'NONE',
      },
      text: '{"error":"CelesTrak unreachable"}',
      json: { error: 'CelesTrak unreachable', provider: { status: 'unavailable' } },
    },
  };
  const invoke = async (path) => answers[path.split('/').pop()] || { status: 404, headers: {}, text: '', json: null };
  const [list, passes] = createSatelliteTools({ invoke });
  const result = await list.handler(
    { lat: LONDON.lat, lon: LONDON.lon, radiusKm: 6000, groups: ['stations', 'geo'], minElevationDeg: -90, limit: 50 },
    ctx(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.provider.status, 'degraded', 'stale data + a failed group → degraded');
  assert.match(result.provider.error, /geo/);
  assert.match(result.provider.error, /HTTP 503/);
  assert.equal(result.provenance.upstream, 'snapshot');
  const geo = result.provenance.groups.find((g) => g.group === 'geo');
  assert.equal(geo.ok, false);
  assert.equal(geo.status, 'unavailable');
  assert.match(geo.error, /CelesTrak unreachable/);
  const stations = result.provenance.groups.find((g) => g.group === 'stations');
  assert.equal(stations.status, 'stale');
  assert.equal(stations.tleSource, 'snapshot');

  // Only the stale group requested → stale, not degraded.
  const staleOnly = await list.handler(
    { lat: LONDON.lat, lon: LONDON.lon, radiusKm: 6000, groups: ['stations'], minElevationDeg: -90, limit: 50 },
    ctx(),
  );
  assert.equal(staleOnly.provider.status, 'stale');

  // Passes through a stale group carry the stale status too.
  const pass = await passes.handler(
    { lat: LONDON.lat, lon: LONDON.lon, noradId: 25544, group: 'stations', hours: 12, minElevationDeg: 10, stepSec: 60 },
    ctx(),
  );
  assert.equal(pass.ok, true);
  assert.equal(pass.provider.status, 'stale');
  assert.ok(!JSON.stringify([result, staleOnly, pass]).includes(FAKE_SECRET));
});

test('satellites: unavailable propagation — every group failing through the real proxy is a structured 503, never a throw', async (t) => {
  isolateDisk(t);
  mockCelestrak(t, { status: 503 });
  const [list, passes] = createSatelliteTools({ invoke: freshInvoker() });
  const result = await list.handler(
    { lat: 30.27, lon: -97.74, radiusKm: 1500, groups: ['stations', 'visual'], minElevationDeg: -90, limit: 50 },
    ctx(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error.code, 'upstream_unavailable');
  assert.match(result.error.message, /CelesTrak/);
  assert.equal(result.provider.status, 'unavailable');
  const pass = await passes.handler(
    { lat: 30.27, lon: -97.74, noradId: 25544, group: 'stations', hours: 1, minElevationDeg: 10, stepSec: 60 },
    ctx(),
  );
  assert.equal(pass.ok, false);
  assert.equal(pass.status, 503);
  assert.equal(pass.error.code, 'upstream_unavailable');
  assert.ok(!JSON.stringify([result, pass]).includes(FAKE_SECRET));

  // The HTTP envelope for the same failure via the tools route.
  const handler = createToolsHandler({
    index: new Map(createSatelliteTools({ invoke: freshInvoker() }).map((tool) => [tool.name, tool])),
    now: () => NOW,
  });
  const http = await invokeRoute(handler, '/list_satellites_in_scene?lat=30.27&lon=-97.74&groups=stations');
  assert.equal(http.status, 503);
  assert.equal(http.body.ok, false);
  assert.equal(http.body.error.code, 'upstream_unavailable');
  assert.equal(http.body.provider.status, 'unavailable');
  assert.equal(http.headers['cache-control'], 'no-store');
});

test('satellites: the registered tools validate query params through the tools route (400 unknown_param / invalid_param) without any network call', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    throw Error(`validation must not reach the network: ${url}`);
  });
  const handler = createToolsHandler({ index: toolIndex(), now: () => NOW });
  const unknown = await invokeRoute(handler, '/list_satellites_in_scene?lat=30.27&lon=-97.74&bogus=1');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_param');
  assert.equal(unknown.body.error.param, 'bogus');
  assert.match(unknown.body.error.message, /allowed: lat, lon, radiusKm, groups, minElevationDeg, limit/);
  const badGroup = await invokeRoute(handler, '/list_satellites_in_scene?lat=30.27&lon=-97.74&groups=stations,moon');
  assert.equal(badGroup.status, 400);
  assert.equal(badGroup.body.error.code, 'invalid_param');
  const badRadius = await invokeRoute(handler, '/list_satellites_in_scene?lat=30.27&lon=-97.74&radiusKm=10');
  assert.equal(badRadius.status, 400);
  const missingLat = await invokeRoute(handler, '/satellite_passes?lon=-97.74&noradId=25544');
  assert.equal(missingLat.status, 400);
  assert.equal(missingLat.body.error.code, 'missing_param');
  const noIdentifier = await invokeRoute(handler, '/satellite_passes?lat=51.5&lon=-0.12');
  assert.equal(noIdentifier.status, 400);
  assert.equal(noIdentifier.body.error.code, 'missing_param');
  const unknownPass = await invokeRoute(handler, '/satellite_passes?lat=51.5&lon=-0.12&noradId=25544&hours=200');
  assert.equal(unknownPass.status, 400);
  assert.equal(unknownPass.body.error.code, 'invalid_param');
  assert.ok(!JSON.stringify([unknown.body, badGroup.body, noIdentifier.body]).includes(FAKE_SECRET));
});
