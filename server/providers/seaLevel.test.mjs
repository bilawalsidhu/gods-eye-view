import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEA_LEVEL_CODE,
  SEA_LEVEL_REFRESH_MS,
  SEA_LEVEL_RETRY_AFTER_FAILURE_MS,
  SEA_LEVEL_SERIES_TTL_MS,
  SEA_LEVEL_STALE_MAX_MS,
  chooseSeaLevelSensor,
  createSeaLevelStore,
  iocLevel,
  normalizeSeaLevelSeries,
  normalizeSeaLevelStationList,
  parseIocTime,
  seaLevelCode,
  seaLevelProxy,
  seaLevelSeriesUrl,
} from './seaLevel.js';

const quiet = { warn() {} };
const NOW = Date.parse('2026-10-24T20:40:00Z');

/** One sensor row as the IOC station list returns it. */
function row(code, sensor, lasttime, lastvalue = 1.23, extra = {}) {
  return {
    Code: code,
    Location: `Station ${code}`,
    country: 'NLD',
    countryname: 'Netherlands',
    Lat: 51.9775,
    Lon: 4.12,
    sensor,
    units: 'M',
    lasttime,
    lastvalue,
    status: 1,
    ...extra,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('IOC times are UTC without a zone mark; anything else is no time', () => {
  assert.equal(
    parseIocTime('2026-10-24 20:20:00.000'),
    Date.parse('2026-10-24T20:20:00Z'),
  );
  assert.equal(
    parseIocTime('2026-10-24 20:20:15'),
    Date.parse('2026-10-24T20:20:15Z'),
  );
  assert.equal(
    parseIocTime('2026-10-24T20:20'),
    Date.parse('2026-10-24T20:20:00Z'),
  );
  for (const bad of [
    null,
    '',
    '2026-02-30 00:00:00',
    '2026-10-24 24:00:00',
    '2026-10-24 20:20:00Z',
    '2026-10-24 20:20:00+02:00',
    'yesterday',
    1_761_337_200_000,
  ])
    assert.equal(parseIocTime(bad), null, String(bad));
  assert.equal(iocLevel(-999), null);
  assert.equal(iocLevel(null), null);
  assert.equal(iocLevel('1.2'), null);
  assert.equal(iocLevel(0.54000000000000004), 0.54);
});

test('station codes are letters and digits, lower-cased, and nothing else', () => {
  assert.equal(seaLevelCode('hoek'), 'hoek');
  assert.equal(seaLevelCode('NA23'), 'na23');
  assert.equal(seaLevelCode('CanMa'), 'canma');
  for (const bad of [
    '',
    ' ',
    'ho ek',
    'hoek/../x',
    '..',
    'hoek?x=1',
    'hoek%2F',
    'hoek-2',
    'abcdefghijk',
    'https://evil.example',
    null,
    42,
  ])
    assert.equal(seaLevelCode(bad), null, String(bad));
  assert.ok(SEA_LEVEL_CODE.test('hoek') && !SEA_LEVEL_CODE.test('HOEK'));
  assert.throws(() => seaLevelSeriesUrl('HOEK', NOW), TypeError);
  const url = new URL(seaLevelSeriesUrl('hoek', NOW));
  assert.equal(url.origin, 'https://www.ioc-sealevelmonitoring.org');
  assert.equal(url.searchParams.get('code'), 'hoek');
  assert.equal(url.searchParams.get('timestart'), '2026-10-21T20:40');
  assert.equal(url.searchParams.get('timestop'), '2026-10-24T20:40');
  assert.equal(url.searchParams.get('format'), 'json');
});

test('one entry per station: the sensor with the newest reading, ties by sensor order', () => {
  const stations = normalizeSeaLevelStationList(
    [
      // Pressure reported later than radar: the later reading wins.
      row('dzao', 'rad', '2026-10-24 19:00:00.000', 2.1),
      row('dzao', 'prs', '2026-10-24 20:20:00.000', 2.2),
      // Same time: radar before pressure, whatever the row order.
      row('tie1', 'prs', '2026-10-24 20:20:00.000', 0.5),
      row('tie1', 'rad', '2026-10-24 20:20:00.000', 0.6),
      // Two unlisted sensors at the same time fall back to the id.
      row('tie2', 'zzz', '2026-10-24 20:20:00.000', 0.1),
      row('tie2', 'aaa', '2026-10-24 20:20:00.000', 0.2),
      // A sensor with no time loses to one with a time.
      row('nope', 'rad', null, null),
      row('nope', 'flt', '2026-10-20 08:00:00.000', 1.5),
      // A later time with the -999 sentinel is no reading: the valued one wins.
      row('vals', 'rad', '2026-10-24 20:30:00.000', -999),
      row('vals', 'prs', '2026-10-24 20:10:00.000', 0.8),
      // Duplicated identical rows (the list repeats some) collapse.
      row('dup1', 'rad', '2026-10-24 20:24:00.000', 2.292),
      row('dup1', 'rad', '2026-10-24 20:24:00.000', 2.292),
    ],
    NOW,
  );
  const by = Object.fromEntries(stations.map((s) => [s.code, s]));
  assert.equal(by.dzao.sensor, 'prs');
  assert.equal(by.dzao.lastValue, 2.2);
  assert.equal(by.tie1.sensor, 'rad');
  assert.equal(by.tie1.lastValue, 0.6);
  assert.equal(by.tie2.sensor, 'aaa');
  assert.equal(by.nope.sensor, 'flt');
  assert.equal(by.vals.sensor, 'prs');
  assert.equal(by.vals.lastValue, 0.8);
  assert.equal(stations.filter((s) => s.code === 'dup1').length, 1);
  assert.deepEqual(
    stations.map((s) => s.code),
    ['dup1', 'dzao', 'nope', 'tie1', 'tie2', 'vals'],
  );
  assert.equal(
    chooseSeaLevelSensor([
      { sensor: 'prs', lastMs: 5 },
      { sensor: 'rad', lastMs: 5 },
    ]).sensor,
    'rad',
  );
});

test('a station trims to the drawn fields, with its reading age on the server clock', () => {
  const [station] = normalizeSeaLevelStationList(
    [row('HOEK', 'flt', '2026-10-24 20:20:00.000', 0.54000000000000004)],
    NOW,
  );
  assert.deepEqual(station, {
    code: 'hoek',
    name: 'Station HOEK',
    country: 'Netherlands',
    lat: 51.9775,
    lon: 4.12,
    sensor: 'flt',
    lastIso: '2026-10-24T20:20:00.000Z',
    lastValue: 0.54,
    ageMs: 20 * 60_000,
  });
});

test('rows that are not water-level sensors, or lack a code or position, drop', () => {
  const stations = normalizeSeaLevelStationList(
    [
      row('batt', 'bat', '2026-10-24 20:20:00.000', 12.8, { units: 'V' }),
      row('batm', 'bat', '2026-10-24 20:20:00.000', 0.01),
      row('airp', 'atm', '2026-10-24 20:20:00.000', 1.0136),
      row('volt', 'prs', '2026-10-24 20:20:00.000', 4.1, { units: 'V' }),
      row('none', null, null, null, { units: null }),
      row('bad/', 'rad', '2026-10-24 20:20:00.000'),
      row('', 'rad', '2026-10-24 20:20:00.000'),
      row('nlat', 'rad', '2026-10-24 20:20:00.000', 1, { Lat: null }),
      row('xlat', 'rad', '2026-10-24 20:20:00.000', 1, { Lat: 91 }),
      row('xlon', 'rad', '2026-10-24 20:20:00.000', 1, { Lon: 'east' }),
      null,
      'row',
      // Kept: feet-labelled rows carry metre values; -999 is no value.
      row('feet', 'rad', '2026-10-24 20:19:00.000', 1.810512, { units: 'F' }),
      row('sent', 'rad', '2026-10-24 20:19:00.000', -999),
      // A reading dated two hours ahead has a broken clock: no time.
      row('futr', 'rad', '2026-10-24 22:40:00.000', 1.1),
    ],
    NOW,
  );
  const by = Object.fromEntries(stations.map((s) => [s.code, s]));
  assert.deepEqual(Object.keys(by).sort(), ['feet', 'futr', 'sent']);
  assert.equal(by.feet.lastValue, 1.811);
  assert.equal(by.sent.lastValue, null);
  assert.equal(by.sent.lastIso, null, 'a -999 reading is no reading');
  assert.equal(by.sent.ageMs, null);
  assert.equal(by.futr.lastIso, null);
  assert.equal(by.futr.ageMs, null);
  assert.equal(normalizeSeaLevelStationList({ rows: [] }, NOW), null);
});

test('a series keeps its primary sensor, its raw range and 10-minute means', () => {
  const rows = [
    { slevel: 0.5, stime: '2026-10-24 20:00:00', sensor: 'rad' },
    { slevel: 0.7, stime: '2026-10-24 20:05:00', sensor: 'rad' },
    { slevel: 1.9, stime: '2026-10-24 20:12:00', sensor: 'rad' },
    { slevel: -999, stime: '2026-10-24 20:14:00', sensor: 'rad' },
    { slevel: 9.0, stime: '2026-10-24 20:20:00', sensor: 'bat' },
    { slevel: 3.0, stime: '2026-10-24 19:00:00', sensor: 'prs' },
    // Outside the 72-hour window, and an unreadable time.
    { slevel: -5, stime: '2026-10-20 20:00:00', sensor: 'rad' },
    { slevel: 7, stime: 'later', sensor: 'rad' },
  ];
  const series = normalizeSeaLevelSeries(rows, 'hoek', NOW);
  assert.equal(series.sensor, 'rad');
  assert.equal(series.count, 3);
  assert.equal(series.min, 0.5);
  assert.equal(series.max, 1.9);
  assert.deepEqual(series.latest, {
    iso: '2026-10-24T20:12:00.000Z',
    value: 1.9,
  });
  assert.deepEqual(series.points, [
    [Date.parse('2026-10-24T20:05:00Z'), 0.6],
    [Date.parse('2026-10-24T20:15:00Z'), 1.9],
  ]);
  assert.equal(series.from, '2026-10-21T20:40:00.000Z');
  const empty = normalizeSeaLevelSeries([], 'hoek', NOW);
  assert.equal(empty.count, 0);
  assert.equal(empty.latest, null);
  assert.deepEqual(empty.points, []);
  assert.equal(normalizeSeaLevelSeries({ error: 'x' }, 'hoek', NOW), null);
});

test('the list is read once per 10 minutes, one read at a time', async () => {
  let clock = NOW;
  let reads = 0;
  let release;
  const store = createSeaLevelStore({
    log: quiet,
    now: () => clock,
    fetchImpl: async (url, init) => {
      reads++;
      assert.equal(init.redirect, 'error');
      assert.match(url, /query=stationlist&showall=all$/);
      await new Promise((resolve) => (release = resolve));
      return jsonResponse([row('hoek', 'flt', '2026-10-24 20:20:00.000')]);
    },
  });
  const a = store.current();
  const b = store.current();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(reads, 1);
  assert.equal(first.snapshot.stations[0].code, 'hoek');
  assert.equal(second.snapshot, first.snapshot);
  clock += SEA_LEVEL_REFRESH_MS - 1;
  await store.current();
  assert.equal(reads, 1);
  clock += 1;
  const next = store.current();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await next;
  assert.equal(reads, 2);
});

test('a failed read serves the last list stale for 6 hours, then 503', async () => {
  let clock = NOW;
  let down = false;
  let reads = 0;
  const store = createSeaLevelStore({
    log: quiet,
    now: () => clock,
    fetchImpl: async () => {
      reads++;
      if (down) return new Response('busy', { status: 502 });
      return jsonResponse([row('hoek', 'flt', '2026-10-24 20:20:00.000')]);
    },
  });
  const plugin = seaLevelProxy({ store, now: () => clock });
  const ok = await call(plugin, '/stations');
  assert.equal(ok.status, 200);
  const body = JSON.parse(ok.body);
  assert.equal(body.stale, false);
  assert.equal(body.snapshotAgeMs, 0);
  assert.equal(body.stations[0].ageMs, 20 * 60_000);
  assert.equal(ok.headers['X-Data-Stale'], undefined);

  down = true;
  clock += SEA_LEVEL_REFRESH_MS;
  const stale = await call(plugin, '/stations');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(JSON.parse(stale.body).stale, true);
  assert.equal(JSON.parse(stale.body).snapshotAgeMs, SEA_LEVEL_REFRESH_MS);
  // The failure cools down: the next request does not ask IOC again.
  const readsAfterFailure = reads;
  await call(plugin, '/stations');
  assert.equal(reads, readsAfterFailure);
  assert.ok(SEA_LEVEL_RETRY_AFTER_FAILURE_MS >= 60_000);

  clock = NOW + SEA_LEVEL_STALE_MAX_MS;
  assert.equal((await call(plugin, '/stations')).status, 200);
  clock = NOW + SEA_LEVEL_STALE_MAX_MS + SEA_LEVEL_RETRY_AFTER_FAILURE_MS + 1;
  const gone = await call(plugin, '/stations');
  assert.equal(gone.status, 503);
  assert.equal(gone.headers['Retry-After'], '60');
  assert.deepEqual(JSON.parse(gone.body), { error: 'sea_level_unavailable' });

  // Recovery replaces the stale list.
  down = false;
  clock += SEA_LEVEL_RETRY_AFTER_FAILURE_MS;
  const back = await call(plugin, '/stations');
  assert.equal(back.status, 200);
  assert.equal(JSON.parse(back.body).stale, false);
});

test('with no list yet and IOC down the route answers 503; an empty or odd list is a failure', async () => {
  for (const answer of [
    () => {
      throw new TypeError('fetch failed');
    },
    () => jsonResponse([]),
    () => jsonResponse({ error: 'maintenance' }),
    () => new Response('<html>', { status: 200 }),
  ]) {
    const plugin = seaLevelProxy({
      log: quiet,
      fetchImpl: async () => answer(),
    });
    const response = await call(plugin, '/stations');
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), {
      error: 'sea_level_unavailable',
    });
  }
});

test('routes take GET and HEAD only and answer unknown paths with 404', async () => {
  const plugin = seaLevelProxy({
    log: quiet,
    fetchImpl: async () =>
      jsonResponse([row('hoek', 'flt', '2026-10-24 20:20:00.000')]),
  });
  const post = await call(plugin, '/stations', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET, HEAD');
  const head = await call(plugin, '/stations', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await call(plugin, '/other')).status, 404);
  assert.equal((await call(plugin, '/station/hoek/extra')).status, 404);
  assert.equal(
    JSON.parse((await call(plugin, '/stations?x=1')).body).stations.length,
    1,
  );
});

test('the station route validates the code before any upstream call', async () => {
  const urls = [];
  const plugin = seaLevelProxy({
    log: quiet,
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse([
        { slevel: 0.5, stime: '2026-10-24 20:00:00', sensor: 'flt' },
      ]);
    },
  });
  for (const bad of [
    '/station/',
    '/station/ho%20ek',
    '/station/..%2F..%2Fadmin',
    '/station/hoek%3Fx%3D1',
    '/station/https:%2F%2Fevil.example',
    '/station/hoek-1',
    '/station/abcdefghijk',
  ]) {
    const response = await call(plugin, bad);
    assert.equal(response.status, 400, bad);
    assert.deepEqual(JSON.parse(response.body), { error: 'invalid_code' });
  }
  assert.equal(urls.length, 0);
  const ok = await call(plugin, '/station/HOEK');
  assert.equal(ok.status, 200);
  const body = JSON.parse(ok.body);
  assert.equal(body.code, 'hoek');
  assert.equal(body.sensor, 'flt');
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get('code'), 'hoek');
  // Cached: a second read makes no request.
  await call(plugin, '/station/hoek');
  assert.equal(urls.length, 1);
});

test('a failed series read serves the cached answer as stale, else 502', async () => {
  let clock = NOW;
  let down = false;
  const store = createSeaLevelStore({
    log: quiet,
    now: () => clock,
    fetchImpl: async () =>
      down
        ? new Response('no', { status: 500 })
        : jsonResponse([
            { slevel: 0.5, stime: '2026-10-24 20:00:00', sensor: 'flt' },
          ]),
  });
  const plugin = seaLevelProxy({ store, now: () => clock });
  assert.equal((await call(plugin, '/station/hoek')).status, 200);
  down = true;
  clock += SEA_LEVEL_SERIES_TTL_MS;
  const stale = await call(plugin, '/station/hoek');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(JSON.parse(stale.body).stale, true);
  const missing = await call(plugin, '/station/vlis');
  assert.equal(missing.status, 502);
  assert.deepEqual(JSON.parse(missing.body), {
    error: 'sea_level_unavailable',
  });
  // Past the stale limit, as for the list, the old series is not served.
  clock = NOW + SEA_LEVEL_STALE_MAX_MS + 1;
  assert.equal((await call(plugin, '/station/hoek')).status, 502);
});

test('with every series read in flight, a cached station is served stale and a new one waits', async () => {
  let clock = NOW;
  let hold = false;
  const pending = [];
  const store = createSeaLevelStore({
    log: quiet,
    now: () => clock,
    fetchImpl: async () => {
      if (hold) await new Promise((resolve) => pending.push(resolve));
      return jsonResponse([
        { slevel: 0.5, stime: '2026-10-24 20:00:00', sensor: 'flt' },
      ]);
    },
  });
  const plugin = seaLevelProxy({ store, now: () => clock });
  assert.equal((await call(plugin, '/station/hoek')).status, 200);
  clock += SEA_LEVEL_SERIES_TTL_MS;
  hold = true;
  const busy = Array.from({ length: 16 }, (_, i) =>
    call(plugin, `/station/s${i}`),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const cached = await call(plugin, '/station/hoek');
  assert.equal(cached.status, 200);
  assert.equal(cached.headers['X-Data-Stale'], 'true');
  const fresh = await call(plugin, '/station/new1');
  assert.equal(fresh.status, 429);
  assert.equal(fresh.headers['Retry-After'], '10');
  for (const resolve of pending) resolve();
  for (const response of await Promise.all(busy))
    assert.equal(response.status, 200);
});

/** Drive the plugin's middleware with a minimal req/res pair. */
async function call(plugin, url, method = 'GET') {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_prefix, fn) => (handler = fn) },
  });
  const res = {
    destroyed: false,
    status: 0,
    headers: {},
    body: '',
    writeHead(status, h) {
      this.status = status;
      this.headers = h;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
  await handler(
    { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    res,
  );
  return res;
}
