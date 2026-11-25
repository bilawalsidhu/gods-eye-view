import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition } from './openAq.js';
const start = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3600_000;
const iso = (t) => new Date(t).toISOString();
const loc = (id, lon, lat, last, sensors) => ({
  id,
  name: 'S' + id,
  country: { code: 'XX', name: 'X' },
  datetimeLast: { utc: iso(last) },
  coordinates: { latitude: lat, longitude: lon },
  sensors: sensors ?? [
    { id: id * 10, parameter: { name: 'pm25', units: 'µg/m³' } },
  ],
});
const latestRow = (id, t, value = 5) => ({
  locationsId: id,
  sensorsId: id * 10,
  value,
  datetime: { utc: iso(t) },
});
/** Fake OpenAQ: catalog from `stations()` filtered by bbox and paginated. */
function fake({ clock, stations, latest, hours, fail }) {
  const calls = [];
  const fetchImpl = async (raw, options) => {
    calls.push(raw);
    const url = new URL(raw);
    const status = fail?.(url);
    if (status) return new Response('', { status });
    if (url.pathname === '/v3/locations') {
      const [w, s, e, n] = url.searchParams.get('bbox').split(',').map(Number);
      const page = Number(url.searchParams.get('page'));
      const all = stations()
        .filter(
          (l) =>
            l.coordinates.longitude >= w &&
            l.coordinates.longitude <= e &&
            l.coordinates.latitude >= s &&
            l.coordinates.latitude <= n,
        )
        .sort((a, b) => a.id - b.id);
      return Response.json({
        results: all.slice((page - 1) * 1000, page * 1000),
      });
    }
    const m = url.pathname.match(/locations\/(\d+)\/latest/);
    if (m)
      return latest
        ? latest(Number(m[1]), options)
        : Response.json({ results: [latestRow(Number(m[1]), clock())] });
    const h = url.pathname.match(/sensors\/(\d+)\/hours/);
    if (h) return hours(Number(h[1]), options);
    throw new Error('unexpected ' + raw);
  };
  return { calls, fetchImpl };
}

test('mixed pass cadence: one failing station does not mark fresh progress as stale cached data', async () => {
  const clock = start;
  const { fetchImpl } = fake({
    clock: () => clock,
    stations: () =>
      Array.from({ length: 6 }, (_, i) =>
        loc(i + 1, 20 + (i + 1) * 0.5, 0, clock),
      ),
    fail: (url) => (/locations\/1\/latest/.test(url.pathname) ? 500 : 0),
  });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const snap = await source.getSnapshot({ view: [10, -10, 30, 10, 20, 0] });
  assert.equal(snap.readings.length, 3);
  assert.equal(snap.partial, true);
  assert.equal(
    snap.stale,
    false,
    `stale=${snap.stale} failureStatus=${snap.failureStatus} retry in ${snap.retryAt - clock} ms`,
  );
  assert.ok(
    snap.retryAt - clock <= 10_000,
    `retry in ${snap.retryAt - clock} ms`,
  );
});

test('a lone failing station neither marks fresh readings stale nor delays healthy rechecks', async () => {
  let clock = start;
  const checks = new Map();
  const { fetchImpl } = fake({
    clock: () => clock,
    stations: () =>
      Array.from({ length: 6 }, (_, i) =>
        loc(i + 1, 20 + (i + 1) * 0.1, 0, start),
      ),
    fail: (url) => {
      const id = url.pathname.match(/locations\/(\d+)\/latest/)?.[1];
      if (id) checks.set(id, [...(checks.get(id) ?? []), clock]);
      return id === '1' ? 500 : 0;
    },
  });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const stale = [];
  while (clock - start < 30 * 60_000) {
    const snap = await source.getSnapshot({ view: [10, -10, 30, 10, 20, 0] });
    if (snap.stale)
      stale.push(`t+${(clock - start) / 1000}s readings=${snap.readings.length}`);
    // The browser asks again at retryAt, and at least once a minute.
    clock = Math.max(
      clock + 1000,
      Math.min(snap.retryAt ?? Infinity, clock + 60_000),
    );
  }
  assert.deepEqual(stale, []);
  for (const [id, times] of checks) {
    if (id === '1') continue;
    const gaps = times.slice(1).map((at, i) => at - times[i]);
    assert.ok(gaps.length, `station ${id} was not rechecked`);
    assert.ok(
      Math.max(...gaps) <= 21 * 60_000,
      `station ${id} rechecked after ${Math.max(...gaps) / 1000} s`,
    );
  }
});
