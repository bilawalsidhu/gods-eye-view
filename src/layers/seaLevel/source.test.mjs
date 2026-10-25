import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeaLevelSource } from './source.js';
import {
  countSeaLevelStations,
  normalizeSeaLevelSeries,
  normalizeSeaLevelSnapshot,
  percentOfRange,
  seaLevelFreshness,
  seaLevelStationPageUrl,
} from './records.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const station = (code, ageMs, extra = {}) => ({
  code,
  name: `Station ${code}`,
  country: 'Netherlands',
  lat: 51.98,
  lon: 4.12,
  sensor: 'flt',
  lastIso: '2026-10-24T20:20:00.000Z',
  lastValue: 0.54,
  ageMs,
  ...extra,
});

test('a snapshot validates into records aged on the server clock', () => {
  const snapshot = normalizeSeaLevelSnapshot({
    generatedAt: '2026-10-24T20:40:00.000Z',
    stale: true,
    snapshotAgeMs: 5 * 60_000,
    stations: [
      station('hoek', 20 * 60_000),
      station('nolast', null, { lastIso: null, lastValue: 0.3 }),
      station('noval', 0, { lastValue: null }),
      station('BAD', 0),
      station('far', 0, { lat: 95 }),
      station('nolon', 0, { lon: null }),
      null,
    ],
  });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.generatedAt, '2026-10-24T20:40:00.000Z');
  assert.deepEqual(
    snapshot.stations.map((s) => s.code),
    ['hoek', 'nolast', 'noval'],
  );
  const [hoek, nolast, noval] = snapshot.stations;
  assert.equal(hoek.id, 'sea-level:hoek');
  assert.equal(hoek.ageMs, 25 * 60_000);
  assert.equal(nolast.ageMs, null);
  assert.equal(nolast.lastValue, null, 'a value without a time is dropped');
  assert.equal(noval.lastIso, null, 'a time without a value is dropped');
  assert.equal(noval.ageMs, null);
  assert.equal(normalizeSeaLevelSnapshot({ rows: [] }), null);
  assert.equal(normalizeSeaLevelSnapshot(null), null);
});

test('freshness bands: within 3 h reporting, to 24 h late, beyond or none silent', () => {
  const h = 3_600_000;
  assert.equal(seaLevelFreshness(0).id, 'reporting');
  assert.equal(seaLevelFreshness(3 * h).id, 'reporting');
  assert.equal(seaLevelFreshness(3 * h + 1).id, 'late');
  assert.equal(seaLevelFreshness(24 * h).id, 'late');
  assert.equal(seaLevelFreshness(24 * h + 1).id, 'silent');
  assert.equal(seaLevelFreshness(null).id, 'silent');
  assert.deepEqual(
    countSeaLevelStations([
      { ageMs: 0 },
      { ageMs: 5 * h },
      { ageMs: null },
      { ageMs: 100 * h },
    ]),
    { reporting: 1, late: 1, silent: 2 },
  );
});

test('a series validates against the station asked for; a range gives a percent', () => {
  const payload = {
    code: 'hoek',
    sensor: 'flt',
    count: 3,
    min: 0.2,
    max: 1.8,
    latest: { iso: '2026-10-24T20:20:00.000Z', value: 1.4 },
    points: [
      [1, 0.2],
      [2, 'x'],
      [3, 1.8],
    ],
  };
  const series = normalizeSeaLevelSeries(payload, 'hoek');
  assert.equal(series.sensor, 'flt');
  assert.deepEqual(series.points, [
    [1, 0.2],
    [3, 1.8],
  ]);
  assert.equal(normalizeSeaLevelSeries(payload, 'vlis'), null);
  assert.equal(normalizeSeaLevelSeries({ code: 'hoek' }, 'hoek'), null);
  const broken = normalizeSeaLevelSeries({ ...payload, min: 2 }, 'hoek');
  assert.equal(broken.latest, null, 'min above max is no range');
  assert.equal(percentOfRange(1.4, 0.2, 1.8), 75);
  assert.equal(percentOfRange(0.2, 0.2, 1.8), 0);
  assert.equal(percentOfRange(1, 1, 1), null);
  assert.equal(percentOfRange(null, 0, 1), null);
  assert.equal(
    seaLevelStationPageUrl('hoek'),
    'https://www.ioc-sealevelmonitoring.org/station.php?code=hoek',
  );
  assert.equal(seaLevelStationPageUrl('ho&ek'), null);
});

test('the snapshot is read from the same-origin proxy', async () => {
  const urls = [];
  const source = createSeaLevelSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return json({
        generatedAt: '2026-10-24T20:40:00.000Z',
        stale: false,
        snapshotAgeMs: 0,
        stations: [station('hoek', 0)],
      });
    },
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(urls, ['/api/sea-level/stations']);
  assert.equal(snapshot.stations[0].id, 'sea-level:hoek');
  assert.equal(source.label, 'IOC / VLIZ · RAW');
});

test('failures read in the fixed forms the layer row translates', async () => {
  const fail = (impl) =>
    createSeaLevelSource({ fetchImpl: impl }).getSnapshot();
  await assert.rejects(
    fail(async () => json({ error: 'sea_level_unavailable' }, 503)),
    { message: 'IOC HTTP 503' },
  );
  await assert.rejects(
    fail(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:4173');
    }),
    { message: 'IOC network error' },
  );
  await assert.rejects(
    fail(async () => new Response('<html>504</html>')),
    { message: 'Malformed IOC response' },
  );
  await assert.rejects(
    fail(async () => json({ rows: [] })),
    { message: 'Malformed IOC response' },
  );
});

test('a caller abort stays an abort, not a feed error', async () => {
  const controller = new AbortController();
  const source = createSeaLevelSource({
    fetchImpl: (url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  });
  const pending = source.getSnapshot({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a station series is read only for valid codes and must be that station', async () => {
  const urls = [];
  const source = createSeaLevelSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return json({
        code: url.endsWith('hoek') ? 'hoek' : 'other',
        points: [],
      });
    },
  });
  assert.equal((await source.getStation('hoek')).code, 'hoek');
  await assert.rejects(source.getStation('../../x'), TypeError);
  await assert.rejects(source.getStation('HOEK'), TypeError);
  await assert.rejects(source.getStation('vlis'), {
    message: 'Malformed IOC response',
  });
  assert.deepEqual(urls, [
    '/api/sea-level/station/hoek',
    '/api/sea-level/station/vlis',
  ]);
});
