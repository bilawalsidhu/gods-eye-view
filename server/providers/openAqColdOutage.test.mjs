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

test('OpenAQ cold outage: a first-load 503 with nothing acquired is a failure, not a cached snapshot', async () => {
  const { fetchImpl } = fake({
    clock: () => start,
    stations: () => [],
    fail: () => 503,
  });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl,
  });
  let result = null;
  try {
    result = await source.getSnapshot({
      view: [10, -10, 30, 10, 20, 0],
      mode: 'aqi',
    });
  } catch {
    /* expected */
  }
  assert.equal(
    result,
    null,
    `resolved: stale=${result?.stale} readings=${result?.readings.length} failureStatus=${result?.failureStatus}`,
  );
});

test('OpenAQ cold deadline: a first catalog page that reaches the deadline is a retryable failure, not an empty view', async () => {
  const realTimeout = AbortSignal.timeout;
  const deadline = new AbortController();
  AbortSignal.timeout = () => deadline.signal;
  try {
    const source = createOpenAqAcquisition({
      getKey: () => 'fixture',
      now: () => start,
      fetchImpl: async (_raw, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
          setTimeout(
            () => deadline.abort(new DOMException('deadline', 'TimeoutError')),
            10,
          );
        }),
    });
    let result = null,
      failure = null;
    try {
      result = await source.getSnapshot({
        view: [10, -10, 30, 10, 20, 0],
        mode: 'aqi',
      });
    } catch (e) {
      failure = e;
    }
    assert.equal(
      result,
      null,
      `resolved: stale=${result?.stale} readings=${result?.readings.length} failureStatus=${result?.failureStatus}`,
    );
    assert.equal(failure.status, 503);
    assert.ok(Number.isFinite(failure.retryAt), `retryAt=${failure.retryAt}`);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});

test('OpenAQ cold station outage: listed stations whose first checks all fail are a failure, not cached data', async () => {
  const { fetchImpl } = fake({
    clock: () => start,
    stations: () => [loc(1, 20, 0, start), loc(2, 20.2, 0, start)],
    fail: (url) => (/\/latest$/.test(url.pathname) ? 503 : 0),
  });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl,
  });
  let result = null,
    failure = null;
  try {
    result = await source.getSnapshot({
      view: [10, -10, 30, 10, 20, 0],
      mode: 'aqi',
    });
  } catch (e) {
    failure = e;
  }
  assert.equal(
    result,
    null,
    `resolved: stale=${result?.stale} readings=${result?.readings.length} failureStatus=${result?.failureStatus}`,
  );
  assert.equal(failure.status, 503);
  // The answer says when to ask again.
  assert.equal(failure.retryAt, start + 60_000);
});
