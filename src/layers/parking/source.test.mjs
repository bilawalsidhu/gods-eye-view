import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARKING_API_ROOT,
  PARKING_SITE_LIMIT,
  createParkingSource,
  parkingViewFits,
} from './source.js';

/** Stuttgart's centre, a few kilometres across. */
const STUTTGART = { south: 48.76, west: 9.15, north: 48.79, east: 9.2 };

const site = (id, extra = {}) => ({
  id,
  source_id: 12,
  name: `Garage ${id}`,
  type: 'CAR_PARK',
  purpose: 'CAR',
  has_realtime_data: true,
  realtime_data_updated_at: `2026-10-24T02:0${id % 10}:00Z`,
  realtime_free_capacity: 40,
  capacity: 100,
  lat: 48.77,
  lon: 9.17,
  ...extra,
});

/** A source over an injected fetch and clock. */
function harness({
  sites = (_url) => ({ items: [site(1), site(2)], total_count: 2 }),
  sources,
} = {}) {
  const calls = [];
  let clock = Date.UTC(2026, 9, 24, 2, 15);
  const source = createParkingSource({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === `${PARKING_API_ROOT}/sources`)
        return sources
          ? sources(url)
          : Response.json({
              items: [{ id: 12, attribution_contributor: 'Stadt Karlsruhe' }],
            });
      const body = sites(url);
      return body instanceof Response ? body : Response.json(body);
    },
  });
  return {
    source,
    calls,
    reads: () => calls.filter((url) => url.includes('/parking-sites?')),
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('an invalid view is refused before any request', async () => {
  const { source, calls } = harness();
  for (const bad of [
    null,
    { ...STUTTGART, north: NaN },
    { ...STUTTGART, east: STUTTGART.west - 1 },
    { ...STUTTGART, north: 91 },
  ])
    await assert.rejects(
      source.getSites(bad),
      /Parking requires a bounded viewport/,
    );
  assert.equal(calls.length, 0);
});

test('a view wider than the span cap asks to zoom in without a request', async () => {
  const { source, calls } = harness();
  const wide = { south: 48.5, west: 9.0, north: 49.0, east: 9.4 };
  assert.equal(parkingViewFits(wide), false);
  assert.equal(parkingViewFits(STUTTGART), true);
  assert.deepEqual(await source.getSites(wide), {
    records: [],
    zoomIn: true,
    partial: false,
    saturated: false,
    observedAt: null,
  });
  assert.equal(calls.length, 0);
});

test('a view reads car parks in its grid box with the contributor named', async () => {
  const { source, reads } = harness();
  const snapshot = await source.getSites(STUTTGART);
  const [url] = reads();
  const query = new URL(url).searchParams;
  assert.equal(
    new URL(url).origin + new URL(url).pathname,
    `${PARKING_API_ROOT}/parking-sites`,
  );
  assert.deepEqual(Object.fromEntries(query), {
    lat_min: '48.76',
    lat_max: '48.80',
    lon_min: '9.14',
    lon_max: '9.20',
    purpose: 'CAR',
    not_type: 'ON_STREET',
    limit: String(PARKING_SITE_LIMIT),
  });
  assert.equal(snapshot.zoomIn, false);
  assert.equal(snapshot.saturated, false);
  assert.deepEqual(
    snapshot.records.map((record) => [record.id, record.contributor]),
    [
      ['parking:1', 'Stadt Karlsruhe'],
      ['parking:2', 'Stadt Karlsruhe'],
    ],
  );
  // Freshness is the newest operator reading, not the fetch time.
  assert.equal(snapshot.observedAt, Date.UTC(2026, 9, 24, 2, 2));
});

test('a small pan repeats the cached read; the poll after a minute reads again', async () => {
  const { source, reads, calls, advance } = harness();
  await source.getSites(STUTTGART);
  await source.getSites({ ...STUTTGART, west: 9.151, east: 9.199 });
  assert.equal(reads().length, 1, 'the same grid box is not re-read');
  advance(61_000);
  await source.getSites(STUTTGART);
  assert.equal(reads().length, 2);
  assert.equal(
    calls.filter((url) => url.endsWith('/sources')).length,
    1,
    'the contributor list is read once',
  );
  source.destroy();
  await source.getSites(STUTTGART);
  assert.equal(reads().length, 3, 'destroy drops the cache');
});

test('a read that matched more sites than it returned is saturated', async () => {
  const { source } = harness({
    sites: () => ({ items: [site(1)], total_count: PARKING_SITE_LIMIT + 1 }),
  });
  const snapshot = await source.getSites(STUTTGART);
  assert.equal(snapshot.saturated, true);
  assert.equal(snapshot.records.length, 1);
});

test('outside the covered region the read is empty, not an error', async () => {
  const { source } = harness({ sites: () => ({ items: [], total_count: 0 }) });
  const snapshot = await source.getSites({
    south: 51.49,
    west: -0.14,
    north: 51.52,
    east: -0.1,
  });
  assert.deepEqual(snapshot.records, []);
  assert.equal(snapshot.observedAt, null);
});

test('a failed contributor list leaves sites unnamed rather than failing', async () => {
  const { source } = harness({
    sources: () => new Response('', { status: 502 }),
  });
  const snapshot = await source.getSites(STUTTGART);
  assert.equal(snapshot.records.length, 2);
  assert.equal(snapshot.records[0].contributor, null);
});

test('upstream failures arrive in the fixed English forms the row translates', async () => {
  const failing = async (sites) => {
    const { source } = harness({ sites });
    return source.getSites(STUTTGART).then(
      () => null,
      (error) => error.message,
    );
  };
  assert.equal(
    await failing(() => new Response('', { status: 503 })),
    'ParkAPI HTTP 503',
  );
  assert.equal(
    await failing(() => new Response('', { status: 429 })),
    'ParkAPI rate limited',
  );
  assert.equal(
    await failing(() => {
      throw new TypeError('fetch failed');
    }),
    'ParkAPI network error',
  );
  assert.equal(
    await failing(() => new Response('<html>')),
    'Malformed ParkAPI response',
  );
  assert.equal(
    await failing(() => ({ items: 'none' })),
    'Malformed ParkAPI response',
  );
});

test('a request past the deadline is a network error', async () => {
  const source = createParkingSource({
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  });
  await assert.rejects(source.getSites(STUTTGART), {
    message: 'ParkAPI network error',
  });
});

test('cancellation stays an abort, never a feed error', async () => {
  const abort = new AbortController();
  const { source } = harness({
    sites: () => {
      abort.abort();
      return { items: [site(1)], total_count: 1 };
    },
  });
  await assert.rejects(source.getSites(STUTTGART, { signal: abort.signal }), {
    name: 'AbortError',
  });
});
