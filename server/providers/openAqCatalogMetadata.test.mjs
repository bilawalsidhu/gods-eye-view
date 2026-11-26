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

test('catalog metadata precedence: revisiting a view after a day keeps all active stations eligible', async () => {
  let clock = start;
  const stations = () =>
    Array.from({ length: 8 }, (_, i) => loc(i + 1, 19.6 + i * 0.1, 0, clock));
  const { fetchImpl } = fake({ clock: () => clock, stations });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [19, -1, 21, 1, 20, 0];
  let snap;
  for (let i = 0; i < 6; i++) {
    snap = await source.getSnapshot({ view });
    if (!snap.partial) break;
    clock += 8001;
  }
  assert.equal(snap.partial, false);
  assert.equal(snap.readings.length, 8);
  clock += 24 * HOUR;
  const first = await source.getSnapshot({ view });
  clock += 61_000;
  const second = await source.getSnapshot({ view });
  assert.equal(
    second.eligible,
    8,
    `eligible: first pass ${first.eligible}, second pass ${second.eligible}; readings ${second.readings.length}`,
  );
});
