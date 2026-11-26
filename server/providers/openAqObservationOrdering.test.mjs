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

test('overlap observation ordering: an older late response does not replace a newer shared reading', async () => {
  const clock = start;
  const pending = [];
  let catalogCalls = 0;
  const base = fake({
    clock: () => clock,
    stations: () => [loc(1, 20, 0, clock)],
    latest: () => new Promise((resolve) => pending.push(resolve)),
  });
  const fetchImpl = (raw, o) => {
    if (new URL(raw).pathname === '/v3/locations') catalogCalls++;
    return base.fetchImpl(raw, o);
  };
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const p1 = source.getSnapshot({ view: [10, -10, 30, 10, 20, 0] });
  const p2 = source.getSnapshot({ view: [11, -10, 29, 10, 20, 0] });
  for (let i = 0; i < 100 && pending.length < 2; i++)
    await new Promise(setImmediate);
  assert.equal(pending.length, 2, 'both views asked the same station');
  pending[1](Response.json({ results: [latestRow(1, clock - 60_000, 9)] }));
  await p2;
  pending[0](
    Response.json({ results: [latestRow(1, clock - HOUR - 60_000, 3)] }),
  );
  await p1;
  const third = await source.getSnapshot({ view: [12, -10, 28, 10, 20, 0] });
  console.log(
    'catalog calls for one shared page:',
    catalogCalls,
    'latest calls:',
    pending.length,
  );
  assert.equal(
    third.readings[0].value,
    9,
    `third view shows value ${third.readings[0].value}`,
  );
});
