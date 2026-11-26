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

test('failed station fairness: persistent failures at the four nearest stations do not starve healthy ones', async () => {
  let clock = start;
  const asked = [];
  const { fetchImpl } = fake({
    clock: () => clock,
    stations: () =>
      Array.from({ length: 6 }, (_, i) =>
        loc(i + 1, 20 + (i + 1) * 0.5, 0, clock),
      ),
    fail: (url) => {
      const m = url.pathname.match(/locations\/(\d+)\/latest/);
      if (m) asked.push(Number(m[1]));
      return m && Number(m[1]) <= 4 ? 500 : 0;
    },
  });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [10, -10, 30, 10, 20, 0];
  let snap,
    acquired = false;
  for (let i = 0; i < 8; i++) {
    let retryAt;
    try {
      snap = await source.getSnapshot({ view });
      acquired ||= snap.readings.length > 0;
      retryAt = snap.retryAt ?? clock + 60_000;
    } catch (e) {
      // Nothing acquired yet and every check failed: a retryable 503.
      if (e.status !== 503 || acquired) throw e;
      assert.ok(Number.isFinite(e.retryAt), `retryAt=${e.retryAt}`);
      retryAt = e.retryAt;
    }
    clock = Math.max(clock + 1000, retryAt + 1);
  }
  assert.ok(
    snap.readings.length >= 2,
    `readings ${snap.readings.length}; stations asked: ${asked.join(',')}`,
  );
});
