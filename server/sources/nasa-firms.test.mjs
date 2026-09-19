import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchFires,
  resolveArea,
  circleToBbox,
  normalizeDetections,
  buildUrl,
  SPEC,
  SOURCES,
  LIMIT_CAP,
  KEY_ENV,
  LICENSE,
} from './nasa-firms.js';
import { parseFirmsCsv, acquisitionMsUtc } from '../../src/data/firmsCsv.js';

const KEY = 'TESTKEY-0123456789abcdef-SENTINEL';
const ENV = { [KEY_ENV]: KEY };
const NOW = () => new Date('2026-09-18T09:00:00.000Z');

const CSV = [
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
  '24.9231,55.1023,331.2,0.39,0.36,2026-09-18,0936,N20,VIIRS,n,2.0NRT,295.4,3.1,D',
  '25.1002,56.3311,345.8,0.41,0.37,2026-09-18,0936,N20,VIIRS,h,2.0NRT,301.2,12.7,D',
  '23.4410,53.9012,301.0,0.55,0.51,2026-09-17,2211,N20,VIIRS,l,2.0NRT,290.0,0.9,N',
  '',
].join('\n');

const csvResponse = (text = CSV) =>
  new Response(text, { status: 200, headers: { 'content-type': 'text/csv' } });

function stub(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  return { fetchImpl, calls };
}

const GULF = { bbox: '51,24,57,27' };

describe('server/sources/nasa-firms.js — fires.search (10 cases)', () => {
  test('1 happy path: bbox + defaults → normalised detections, provenance envelope, completeness never complete, key never echoed', async () => {
    const { fetchImpl, calls } = stub([csvResponse()]);
    const r = await fetchFires(
      { ...GULF, source: 'VIIRS_NOAA20_NRT' },
      { fetchImpl, env: ENV, now: NOW },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.status, 200);
    assert.equal(r.data.count, 3);
    assert.equal(r.data.total_in_area, 3);
    assert.equal(r.data.sensor, 'VIIRS_NOAA20_NRT');
    const first = r.data.detections[0];
    assert.deepEqual(Object.keys(first), [
      'id',
      'latitude',
      'longitude',
      'observed_at',
      'brightness_k',
      'brightness_secondary_k',
      'frp_mw',
      'confidence',
      'satellite',
      'instrument',
      'daynight',
    ]);
    assert.equal(first.latitude, 24.9231);
    assert.equal(first.longitude, 55.1023);
    assert.equal(first.observed_at, '2026-09-18T09:36:00.000Z');
    assert.equal(first.frp_mw, 3.1);
    assert.equal(first.confidence, 'n');
    assert.deepEqual(Object.keys(r.provenance), [
      'provider',
      'source_url',
      'license',
      'fetched_at',
      'freshness',
      'coverage',
      'completeness',
    ]);
    assert.equal(r.provenance.license.attribution, 'NASA FIRMS / LANCE');
    assert.equal(r.provenance.fetched_at, '2026-09-18T09:00:00.000Z');
    assert.equal(r.provenance.freshness.kind, 'live');
    assert.equal(
      r.provenance.freshness.latest_observed_at,
      '2026-09-18T09:36:00.000Z',
    );
    assert.equal(r.provenance.coverage.kind, 'bbox');
    assert.notEqual(r.provenance.completeness.status, 'complete');
    assert.equal(r.provenance.completeness.status, 'partial');
    assert.deepEqual(r.data.quota, {
      transactions_per_10min: 5000,
      note: 'per MAP_KEY; a multi-day request counts as multiple transactions (FIRMS area API docs)',
    });
    // the real key went to the upstream URL and nowhere else
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].url.includes(`/csv/${KEY}/VIIRS_NOAA20_NRT/51,24,57,27/1`),
      calls[0].url,
    );
    assert.equal(r.provenance.source_url.includes(KEY), false);
    assert.ok(
      r.provenance.source_url.includes(
        '/csv/<redacted>/VIIRS_NOAA20_NRT/51,24,57,27/1',
      ),
    );
    assert.equal(JSON.stringify(r).includes(KEY), false);
  });

  test('2 invalid input: unknown param, bad bbox, bbox+circle, day_range out of range, unknown source, limit above cap → 400 with param', async () => {
    const { fetchImpl, calls } = stub([]);
    const cases = [
      [{ ...GULF, foo: 1 }, 'unknown_param', 'foo'],
      [{ bbox: '1,2,3' }, 'invalid_param', 'bbox'],
      [{ bbox: '10,5,3,4' }, 'invalid_param', 'bbox'],
      [
        { ...GULF, latitude: 24, longitude: 54, radius_km: 50 },
        'invalid_param',
        'bbox',
      ],
      [{ latitude: 24, longitude: 54 }, 'missing_param', 'radius_km'],
      [{}, 'missing_param', 'bbox'],
      [{ ...GULF, day_range: 11 }, 'invalid_param', 'day_range'],
      [{ ...GULF, day_range: 0 }, 'invalid_param', 'day_range'],
      [{ ...GULF, source: 'LANDSAT_NRT' }, 'invalid_param', 'source'],
      [{ ...GULF, limit: LIMIT_CAP + 1 }, 'invalid_param', 'limit'],
      [{ ...GULF, date: '2026-9-1' }, 'invalid_param', 'date'],
      [{ ...GULF, date: '2026-13-40' }, 'invalid_param', 'date'],
    ];
    for (const [q, code, param] of cases) {
      const r = await fetchFires(q, { fetchImpl, env: ENV });
      assert.equal(r.ok, false, JSON.stringify(q));
      assert.equal(r.status, 400, JSON.stringify(q));
      assert.equal(r.error.code, code, JSON.stringify(q));
      assert.equal(r.error.param, param, JSON.stringify(q));
    }
    assert.equal(
      calls.length,
      0,
      'validation failures never reach the network',
    );
    assert.deepEqual(
      [...SOURCES],
      ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'],
    );
    assert.equal(SPEC.limit.max, 200);
  });

  test('3 missing auth: no NASA_FIRMS_MAP_KEY → 503 not_configured, no network call, no key requested', async () => {
    const { fetchImpl, calls } = stub([]);
    for (const env of [{}, { [KEY_ENV]: '   ' }, undefined]) {
      const r = await fetchFires(GULF, { fetchImpl, env });
      assert.equal(r.ok, false);
      assert.equal(r.status, 503);
      assert.equal(r.error.code, 'not_configured');
      assert.equal(r.error.param, KEY_ENV);
      assert.match(r.error.message, /NASA_FIRMS_MAP_KEY is not configured/);
    }
    assert.equal(calls.length, 0);
    // the adapter never reads the legacy env name or any other key source
    const r = await fetchFires(GULF, {
      fetchImpl,
      env: { FIRMS_MAP_KEY: 'legacy' },
    });
    assert.equal(r.status, 503);
  });

  test('4 rate limit: upstream 429 → 429 rate_limited with retry_after, single fetch; FIRMS text quota message → 429', async () => {
    const s1 = stub([
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '600' },
      }),
    ]);
    const r1 = await fetchFires(GULF, { fetchImpl: s1.fetchImpl, env: ENV });
    assert.equal(r1.status, 429);
    assert.equal(r1.error.code, 'rate_limited');
    assert.equal(r1.error.retry_after, 600);
    assert.equal(s1.calls.length, 1);
    const s2 = stub([
      new Response('Exceeded transaction limit for the 10 minute interval.', {
        status: 200,
      }),
    ]);
    const r2 = await fetchFires(GULF, { fetchImpl: s2.fetchImpl, env: ENV });
    assert.equal(r2.status, 429);
    assert.equal(r2.error.code, 'rate_limited');
  });

  test('5 provider down: 503 twice → 502 upstream_unavailable after exactly two attempts', async () => {
    const { fetchImpl, calls } = stub([
      new Response('down', { status: 503 }),
      new Response('down', { status: 502 }),
    ]);
    const r = await fetchFires(GULF, { fetchImpl, env: ENV });
    assert.equal(r.status, 502);
    assert.equal(r.error.code, 'upstream_unavailable');
    assert.equal(calls.length, 2);
    assert.equal(JSON.stringify(r).includes(KEY), false);
  });

  test('6 empty result: header-only CSV → ok, count 0, completeness partial', async () => {
    const header = CSV.split('\n')[0];
    const { fetchImpl } = stub([csvResponse(`${header}\n`)]);
    const r = await fetchFires(GULF, { fetchImpl, env: ENV, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 0);
    assert.deepEqual(r.data.detections, []);
    assert.equal(r.provenance.completeness.status, 'partial');
    assert.equal(r.provenance.freshness.latest_observed_at, null);
  });

  test('7 partial result: limit below the detection count → truncated, completeness bounded with the limit', async () => {
    const { fetchImpl } = stub([csvResponse()]);
    const r = await fetchFires(
      { ...GULF, limit: 2 },
      { fetchImpl, env: ENV, now: NOW },
    );
    assert.equal(r.data.count, 2);
    assert.equal(r.data.total_in_area, 3);
    assert.equal(r.provenance.completeness.status, 'bounded');
    assert.match(r.provenance.completeness.reason, /limit 2 of 3/);
  });

  test('8 timeout: upstream never answers → retried once, then 504 upstream_timeout', async () => {
    let calls = 0;
    const fetchImpl = (_u, { signal }) =>
      new Promise((_res, rej) => {
        calls += 1;
        signal.addEventListener('abort', () =>
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    const r = await fetchFires(GULF, { fetchImpl, env: ENV, timeoutMs: 15 });
    assert.equal(r.status, 504);
    assert.equal(r.error.code, 'upstream_timeout');
    assert.equal(calls, 2);
  });

  test('9 malformed upstream: HTML body → 502 malformed_upstream; "Invalid MAP_KEY" text → 502 upstream_auth without echoing the key', async () => {
    const s1 = stub([
      new Response('<html><body>Service unavailable</body></html>', {
        status: 200,
      }),
    ]);
    const r1 = await fetchFires(GULF, { fetchImpl: s1.fetchImpl, env: ENV });
    assert.equal(r1.status, 502);
    assert.equal(r1.error.code, 'malformed_upstream');
    const s2 = stub([new Response('Invalid MAP_KEY.', { status: 200 })]);
    const r2 = await fetchFires(GULF, { fetchImpl: s2.fetchImpl, env: ENV });
    assert.equal(r2.status, 502);
    assert.equal(r2.error.code, 'upstream_auth');
    assert.equal(JSON.stringify(r2).includes(KEY), false);
  });

  test('10 cancellation: aborted AbortSignal → 499 cancelled, at most one fetch', async () => {
    const ac = new AbortController();
    let calls = 0;
    const fetchImpl = (_u, { signal }) =>
      new Promise((_res, rej) => {
        calls += 1;
        signal.addEventListener('abort', () =>
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    const p = fetchFires(GULF, { fetchImpl, env: ENV, signal: ac.signal });
    ac.abort();
    const r = await p;
    assert.equal(r.status, 499);
    assert.equal(r.error.code, 'cancelled');
    assert.ok(calls <= 1);
  });
});

describe('server/sources/nasa-firms.js — helpers and parity with src/data/firmsCsv.js (the existing FIRMS parser used by server/providers/firms.js)', () => {
  test('circle → bbox conversion and resolveArea (bbox XOR circle), URL shape with date', () => {
    const box = circleToBbox(24.433, 54.651, 100);
    assert.ok(Math.abs(box.north - 24.433 - 100 / 110.574) < 1e-9);
    assert.ok(box.west < 54.651 && box.east > 54.651 && box.south < 24.433);
    const area = resolveArea({
      latitude: 24.433,
      longitude: 54.651,
      radius_km: 100,
    });
    assert.equal(area.area_kind, 'circle');
    assert.deepEqual(area.circle, {
      latitude: 24.433,
      longitude: 54.651,
      radius_km: 100,
    });
    assert.equal(resolveArea({ bbox: '51,24,57,27' }).area_kind, 'bbox');
    assert.equal(
      resolveArea({ bbox: '51,24,57,27', latitude: 1 }).error.code,
      'invalid_param',
    );
    const url = buildUrl(
      'K',
      'MODIS_NRT',
      { west: 51, south: 24, east: 57, north: 27 },
      3,
      '2026-09-10',
    );
    assert.equal(
      url,
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/K/MODIS_NRT/51,24,57,27/3/2026-09-10',
    );
    assert.equal(LICENSE.attribution, 'NASA FIRMS / LANCE');
  });

  test('parity: same CSV fixture through the existing parser and this adapter — counts, coordinates, timestamps, ids, metadata keys, error shapes', async () => {
    const existing = parseFirmsCsv(CSV); // what server/providers/firms.js serves (after its 24 h filter)
    const { items } = normalizeDetections(existing, { limit: LIMIT_CAP });
    assert.equal(existing.length, items.length, 'entity count');
    existing.forEach((e, i) => {
      assert.ok(Math.abs(e.lat - items[i].latitude) < 1e-6);
      assert.ok(Math.abs(e.lon - items[i].longitude) < 1e-6);
      assert.equal(
        new Date(acquisitionMsUtc(e.acqDate, e.acqTime)).toISOString(),
        items[i].observed_at,
        'timestamp',
      );
      assert.equal(e.frp, items[i].frp_mw);
      assert.equal(e.brightness, items[i].brightness_k);
      assert.equal(e.brightnessTi5, items[i].brightness_secondary_k);
      assert.equal(e.confidence, items[i].confidence);
      assert.equal(e.satellite, items[i].satellite);
      assert.equal(e.instrument, items[i].instrument);
      assert.equal(e.daynight, items[i].daynight);
      assert.ok(
        items[i].id.startsWith(`${e.satellite}-${e.acqDate}T`),
        'id derived from satellite + acquisition',
      );
    });
    // metadata key mapping existing → adapter (documented rename table)
    const MAP = {
      lat: 'latitude',
      lon: 'longitude',
      frp: 'frp_mw',
      confidence: 'confidence',
      brightness: 'brightness_k',
      brightnessTi5: 'brightness_secondary_k',
      daynight: 'daynight',
      satellite: 'satellite',
      instrument: 'instrument',
    };
    for (const [from, to] of Object.entries(MAP)) {
      assert.ok(from in existing[0], from);
      assert.ok(to in items[0], to);
    }
    const unmapped = Object.keys(existing[0]).filter((k) => !(k in MAP));
    assert.deepEqual(
      unmapped,
      ['acqDate', 'acqTime'],
      'acqDate+acqTime are folded into observed_at',
    );
    // error shapes on a 5xx fixture: the existing proxy throws `HTTP 503` and serves stale;
    // this adapter returns a structured envelope.
    const { fetchImpl } = stub([
      new Response('x', { status: 503 }),
      new Response('x', { status: 503 }),
    ]);
    const r = await fetchFires(GULF, { fetchImpl, env: ENV });
    assert.deepEqual(Object.keys(r.error), ['code', 'message']);
    assert.equal(r.error.code, 'upstream_unavailable');
  });

  test('deny-list: neither the adapter source nor its outputs carry a key value, and the legacy FIRMS_MAP_KEY name is not read', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('./nasa-firms.js', import.meta.url),
      'utf8',
    );
    assert.equal(
      src.includes('FIRMS_MAP_KEY'),
      src.includes('NASA_FIRMS_MAP_KEY') && !/[^_]FIRMS_MAP_KEY/.test(src),
      'only NASA_FIRMS_MAP_KEY is referenced',
    );
    assert.equal(
      /process\.env\.[A-Z_]*KEY/.test(src),
      false,
      'the key is read from the injected env object, never process.env directly',
    );
    const { fetchImpl } = stub([csvResponse()]);
    const r = await fetchFires(
      {
        latitude: 24.433,
        longitude: 54.651,
        radius_km: 150,
        source: 'MODIS_NRT',
        day_range: 2,
      },
      { fetchImpl, env: ENV, now: NOW },
    );
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes(KEY), false);
    assert.ok(serialized.includes('<redacted>'));
    assert.equal(r.data.area.kind, 'circle');
    assert.equal(r.provenance.coverage.kind, 'circle');
  });
});
