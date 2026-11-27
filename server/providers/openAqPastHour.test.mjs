import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAqAcquisition,
  openAqHourAt,
  openAqProxy,
} from './openAq.js';

const HOUR = 3600_000;
const wall = Date.parse('2026-10-20T12:20:00Z');
/** The past hour asked: 09:00, three hours before the wall clock's hour. */
const past = Date.parse('2026-10-20T09:00:00Z');
const iso = (t) => new Date(t).toISOString();
const view = [0, -10, 30, 10, 20, 0];

/** A sensor's hourly mean for the hour ending at `endMs`. */
const meanOf = (sensor, endMs) => sensor + ((endMs / HOUR) % 24);
const SENSORS = [
  { id: 11, parameter: { name: 'pm25', units: 'µg/m³' } },
  { id: 12, parameter: { name: 'o3', units: 'ppm' } },
  { id: 13, parameter: { name: 'no2', units: 'ppb' } },
];

/**
 * An OpenAQ stand-in: station 1 (PM2.5, O3, NO2) reports from 2026-10-01,
 * station 2 (PM2.5) only from 11:00 on the day asked. Hourly means answer
 * every hour in the window asked, plus one past its end, as a loose upstream
 * might; the latest values are the newest hour's means.
 */
function upstream(clock, { filedAt = () => 0 } = {}) {
  const urls = [];
  const fetchImpl = async (raw) => {
    const url = new URL(raw);
    urls.push(url);
    if (url.pathname === '/v3/locations')
      return Response.json({
        results: [
          ['1', SENSORS, '2026-10-01T00:00:00Z'],
          ['2', [{ ...SENSORS[0], id: 21 }], '2026-10-20T11:00:00Z'],
        ].map(([id, sensors, first]) => ({
          id: Number(id),
          name: `S${id}`,
          country: { code: 'XX', name: 'X' },
          datetimeFirst: { utc: first },
          datetimeLast: { utc: iso(clock()) },
          coordinates: { latitude: 0, longitude: 20 },
          isMonitor: true,
          sensors,
        })),
      });
    const hours = url.pathname.match(/^\/v3\/sensors\/(\d+)\/hours$/);
    if (hours) {
      const sensor = SENSORS.find((s) => s.id === Number(hours[1])) ?? {
        ...SENSORS[0],
        id: Number(hours[1]),
      };
      const from = Date.parse(url.searchParams.get('datetime_from'));
      const to =
        Math.floor(Date.parse(url.searchParams.get('datetime_to')) / HOUR) *
        HOUR;
      const results = [];
      for (
        let end = Math.ceil(from / HOUR) * HOUR;
        end <= to + HOUR;
        end += HOUR
      )
        if (
          end <= Math.floor(clock() / HOUR) * HOUR &&
          clock() >= filedAt(sensor.id, end)
        )
          results.push({
            value: meanOf(sensor.id, end),
            parameter: sensor.parameter,
            flagInfo: { hasFlags: false },
            coverage: { percentCoverage: 100 },
            period: {
              interval: '01:00:00',
              datetimeFrom: { utc: iso(end - HOUR) },
              datetimeTo: { utc: iso(end) },
            },
          });
      return Response.json({ results: results.slice(-999) });
    }
    const id = Number(url.pathname.split('/')[3]);
    const newest = Math.floor(clock() / HOUR) * HOUR;
    return Response.json({
      results: (id === 1 ? SENSORS : [{ id: 21 }]).map((s) => ({
        locationsId: id,
        sensorsId: s.id,
        value: meanOf(s.id, newest),
        datetime: { utc: iso(newest) },
      })),
    });
  };
  return { urls, fetchImpl };
}

/** Ask a view until its stations are all checked (each ask is one pass). */
async function settle(source, ask, clock, step = 10_000) {
  let snapshot;
  for (let i = 0; i < 20; i++) {
    snapshot = await source.getSnapshot(ask);
    if (!snapshot.partial) return snapshot;
    clock.t = Math.max(clock.t + step, snapshot.retryAt ?? 0);
  }
  return snapshot;
}

const acquisition = (clock, options) => {
  const io = upstream(() => clock.t, options);
  return {
    io,
    source: createOpenAqAcquisition({
      now: () => clock.t,
      getKey: () => 'key',
      fetchImpl: io.fetchImpl,
    }),
  };
};

test('a past hour is the hour it was asked for; a time ahead is refused', () => {
  assert.equal(openAqHourAt(undefined, wall), null);
  assert.equal(openAqHourAt(past + 59 * 60_000, wall), past);
  // Within the current hour is now.
  assert.equal(openAqHourAt(wall - 10 * 60_000, wall), null);
  assert.equal(openAqHourAt(wall + 4 * 60_000, wall), null);
  for (const bad of [wall + HOUR, -1, 1.5, Number.NaN])
    assert.throws(
      () => openAqHourAt(bad, wall),
      (e) => e.status === 400,
    );
});

test('the US AQI view of a past hour is what the view showed then', async () => {
  const clock = { t: wall };
  const { io, source } = acquisition(clock);
  const before = await settle(source, { view, mode: 'aqi', at: past }, clock);
  assert.equal(before.at, past);
  // Only hourly means up to the hour asked, none of the latest values.
  assert.ok(io.urls.every((u) => !u.pathname.endsWith('/latest')));
  for (const u of io.urls.filter((u) => u.pathname.includes('/hours')))
    assert.equal(u.searchParams.get('datetime_to'), iso(past));
  // Station 2 began reporting after the hour asked: no request is spent on it.
  assert.ok(io.urls.every((u) => !u.pathname.includes('/sensors/21/')));
  assert.deepEqual(
    before.readings.map((r) => r.stationId),
    ['1'],
  );

  // The same view asked live at that hour answers the same values.
  const then = { t: past };
  const live = await settle(
    acquisition(then).source,
    { view, mode: 'aqi' },
    then,
  );
  const [a] = before.readings;
  const [b] = live.readings.filter((r) => r.stationId === '1');
  assert.deepEqual(a.values, b.values);
  assert.equal(a.observedMs, past);
});

test('a pollutant view of a past hour shows that hour’s means', async () => {
  const clock = { t: wall };
  const { source } = acquisition(clock);
  const snapshot = await settle(
    source,
    { view, parameter: 'PM2.5', at: past + 30 * 60_000 },
    clock,
  );
  assert.deepEqual(
    snapshot.readings.map((r) => [r.stationId, r.value, r.observedMs]),
    [['1', meanOf(11, past), past]],
  );
});

test('a recent past hour is read again for late hours, and kept apart from now', async () => {
  const clock = { t: wall };
  const at = Date.parse('2026-10-20T11:00:00Z');
  // Station 1's PM2.5 hours from 10:00 on are filed three hours late.
  const late = Date.parse('2026-10-20T10:00:00Z');
  const { io, source } = acquisition(clock, {
    filedAt: (sensor, end) =>
      sensor === 11 && end >= late ? end + 3 * HOUR : 0,
  });
  const ask = { view, parameter: 'PM2.5', at };
  const station1 = (answer) =>
    answer.readings.find((r) => r.stationId === '1')?.observedMs;
  const first = await settle(source, ask, clock);
  assert.equal(station1(first), late - HOUR);
  const spent = io.urls.length;
  // Within the recheck interval nothing is read again.
  clock.t += 30 * 60_000;
  const again = await source.getSnapshot(ask);
  assert.equal(again.partial, false);
  assert.equal(io.urls.length, spent);
  // An hour on (13:35), the station is checked again: its 10:00 hour, filed
  // at 13:00, shows.
  clock.t += 45 * 60_000;
  const later = await settle(source, ask, clock);
  assert.equal(station1(later), late);
  // Now has its own readings: the newest hour's, not the past one's.
  const now = await settle(source, { view, parameter: 'PM2.5' }, clock);
  assert.equal(now.at, null);
  assert.ok(now.readings.some((r) => r.stationId === '2' && r.observedMs > at));
});

test('an hour more than three days back is read once', async () => {
  const clock = { t: wall };
  const { io, source } = acquisition(clock);
  const ask = { view, parameter: 'PM2.5', at: wall - 4 * 24 * HOUR };
  await settle(source, ask, clock);
  const spent = io.urls.length;
  clock.t += 3 * HOUR;
  await settle(source, ask, clock);
  // Only the station catalog is read again, no station.
  assert.ok(io.urls.slice(spent).every((u) => u.pathname === '/v3/locations'));
});

test('a past hour needs a pollutant or the US AQI view', async () => {
  const { source } = acquisition({ t: wall });
  await assert.rejects(
    source.getSnapshot({ view, at: past }),
    (e) => e.status === 400,
  );
});

test('the route takes one numeric at', async () => {
  const plugin = openAqProxy({ getKey: () => '' });
  let handler;
  plugin.configureServer({ middlewares: { use: (_p, h) => (handler = h) } });
  for (const [url, status] of [
    [`/?mode=aqi&at=${past}`, 428],
    [`/?mode=aqi&at=${past}&at=${past}`, 400],
    ['/?mode=aqi&at=yesterday', 400],
    ['/?mode=aqi&at=-1', 400],
  ]) {
    let code;
    await handler(
      { method: 'GET', url },
      { writeHead: (s) => (code = s), end() {} },
    );
    assert.equal(code, status, url);
  }
});
