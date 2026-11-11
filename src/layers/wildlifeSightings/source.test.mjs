import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWildlifeSightingsSource,
  WILDLIFE_GRID_TTL_MS,
} from './source.js';
import { wildlifeGridCellId } from './gridViewport.js';

const now = Date.UTC(2026, 10, 4, 18);
const seattle = { south: 47.5, west: -122.5, north: 47.7, east: -122.2 };
const outside = { south: 10, west: 10, north: 12, east: 12 };
const inat = {
  stableId: 'inat:123',
  origin: 'inaturalist',
  lat: 47.6,
  lon: -122.3,
  observedAt: now - 3_600_000,
  observedOn: '2026-11-04',
};
const acartia = {
  stableId: 'acartia:abc',
  origin: 'acartia',
  lat: 48.12,
  lon: -122.54,
  observedAt: now - 3_600_000,
  cetacean: true,
  quality: 'research',
  provider: { name: 'Provider', entity: null },
};
const inatEnvelope = (extra = {}) => ({
  fetchedAt: now,
  rows: [inat],
  scope: 'view',
  totalResults: 1,
  ...extra,
});
const acartiaEnvelope = (extra = {}) => ({
  fetchedAt: now,
  rows: [acartia],
  ...extra,
});

test('construction performs no acquisition', () => {
  createWildlifeSightingsSource({
    fetchImpl: () => assert.fail('construction fetched'),
  });
});

test('source sends proxy-only scope, box, taxa and confirmed parameters for all presets', async () => {
  for (const taxa of [
    'all',
    'Aves',
    'Mammalia',
    'whales',
    'Insecta',
    'Plantae',
  ]) {
    const urls = [];
    const source = createWildlifeSightingsSource({
      now: () => now,
      fetchImpl: async (url) => {
        urls.push(new URL(url, 'https://example.test'));
        return Response.json(inatEnvelope());
      },
    });
    await source.getSnapshotDetail({ box: outside, taxa, confirmed: true });
    assert.equal(urls.length, 1);
    assert.equal(urls[0].pathname, '/api/inaturalist/observations');
    assert.deepEqual(Object.fromEntries(urls[0].searchParams), {
      scope: 'view',
      taxa,
      quality: 'research',
      south: '10',
      west: '10',
      north: '12',
      east: '12',
    });
    // taxon_id, d1 (observed date), photos and quality_grade are upstream
    // choices owned and tested by the server, never browser query controls.
  }
});

test('confirmed false omits quality, and global sample omits bbox and Acartia', async () => {
  const urls = [];
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json(inatEnvelope({ scope: 'global' }));
    },
  });
  const result = await source.getSnapshotDetail({
    scope: 'global',
    taxa: 'whales',
    confirmed: false,
    box: seattle,
  });
  assert.equal(result.scope, 'global');
  assert.deepEqual(
    Object.fromEntries(new URL(urls[0], 'https://example.test').searchParams),
    { scope: 'global', taxa: 'whales' },
  );
  assert.equal(urls.length, 1);
});

test('Acartia loads only inside coverage for the three mammal-inclusive presets', async () => {
  for (const box of [seattle, outside])
    for (const taxa of [
      'all',
      'Aves',
      'Mammalia',
      'whales',
      'Insecta',
      'Plantae',
    ]) {
      const urls = [];
      const source = createWildlifeSightingsSource({
        now: () => now,
        fetchImpl: async (url) => {
          urls.push(url);
          return Response.json(
            url.startsWith('/api/acartia') ? acartiaEnvelope() : inatEnvelope(),
          );
        },
      });
      const result = await source.getSnapshotDetail({ box, taxa });
      const expected =
        box === seattle && ['all', 'Mammalia', 'whales'].includes(taxa);
      assert.equal(
        urls.some((url) => url === '/api/acartia/sightings'),
        expected,
      );
      assert.equal(result.rows.length, expected ? 2 : 1);
    }
});

test('Acartia failure preserves iNat rows with an explicit failed source', async () => {
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url) =>
      url.startsWith('/api/acartia')
        ? new Response('', { status: 502 })
        : Response.json(inatEnvelope()),
  });
  const result = await source.getSnapshotDetail({ box: seattle });
  assert.deepEqual(result.rows, [inat]);
  assert.equal(result.sources.acartia.ok, false);
  assert.equal(result.sources.inaturalist.ok, true);
});

test('iNat failure keeps a successful Acartia result and reports iNat degraded', async () => {
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url) =>
      url.startsWith('/api/acartia')
        ? Response.json(acartiaEnvelope())
        : new Response('', {
            status: 502,
            headers: { 'X-Upstream-Status': '503', 'Retry-After': '30' },
          }),
  });
  const result = await source.getSnapshotDetail({ box: seattle });
  assert.deepEqual(result.rows, [acartia]);
  assert.equal(result.totalResults, 1);
  assert.equal(result.fetchedAt, now);
  assert.equal(result.sources.acartia.ok, true);
  assert.equal(result.sources.inaturalist.ok, false);
  assert.equal(result.sources.inaturalist.count, 0);
  assert.equal(
    result.sources.inaturalist.error.message,
    'iNaturalist HTTP 502',
  );
  assert.equal(result.sources.inaturalist.error.retryAfterSec, 30);
  assert.deepEqual(result.sources.inaturalist.failedBoxes, [seattle]);
});

test('observations reject only when every requested source failed', async () => {
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url) =>
      new Response('', { status: url.startsWith('/api/acartia') ? 502 : 503 }),
  });
  await assert.rejects(source.getSnapshotDetail({ box: seattle }), {
    message: 'iNaturalist HTTP 503',
  });
  const antimeridian = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(
    antimeridian.getSnapshotDetail({
      boxes: [
        { south: 10, west: 179, north: 12, east: 180 },
        { south: 10, west: -180, north: 12, east: -178 },
      ],
    }),
    { message: 'iNaturalist HTTP 503' },
  );
});

test('one failed antimeridian half keeps the other half and reports the failed box', async () => {
  const east = { south: 10, west: 179, north: 12, east: 180 };
  const west = { south: 10, west: -180, north: 12, east: -178 };
  const eastRow = { ...inat, stableId: 'inat:east', lat: 11, lon: 179.5 };
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url) =>
      new URL(url, 'https://example.test').searchParams.get('west') === '179'
        ? Response.json(inatEnvelope({ rows: [eastRow], totalResults: 3 }))
        : new Response('', { status: 503 }),
  });
  const result = await source.getSnapshotDetail({ boxes: [east, west] });
  assert.deepEqual(result.rows, [eastRow]);
  assert.equal(result.totalResults, 3);
  assert.equal(result.sources.inaturalist.ok, false);
  assert.equal(result.sources.inaturalist.count, 1);
  assert.equal(
    result.sources.inaturalist.error.message,
    'iNaturalist HTTP 503',
  );
  assert.deepEqual(result.sources.inaturalist.failedBoxes, [west]);
});

test('proxy staleness and original fetch dates pass through with per-source counts', async () => {
  const fetchedAt = now - 50 * 60_000;
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url) =>
      Response.json(
        url.startsWith('/api/acartia')
          ? acartiaEnvelope()
          : inatEnvelope({
              fetchedAt,
              stale: true,
              partial: true,
              totalResults: 400,
            }),
      ),
  });
  const result = await source.getSnapshotDetail({ box: seattle });
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, fetchedAt);
  assert.equal(result.partial, true);
  assert.equal(result.totalResults, 401);
  assert.deepEqual(result.sources.inaturalist, {
    ok: true,
    stale: true,
    fetchedAt,
    count: 1,
  });
  assert.equal(result.sources.acartia.count, 1);
});

test('antimeridian boxes fetch once each and merge duplicate boundary rows', async () => {
  const urls = [];
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json(inatEnvelope());
    },
  });
  const boxes = [
    { south: 10, west: 179, north: 12, east: 180 },
    { south: 10, west: -180, north: 12, east: -178 },
  ];
  const result = await source.getSnapshotDetail({ boxes });
  assert.equal(urls.length, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.totalResults, 2);
});

test('iNat non-OK responses carry stable status messages and status values', async () => {
  for (const status of [429, 502]) {
    const source = createWildlifeSightingsSource({
      fetchImpl: async () =>
        new Response('', {
          status,
          headers: { 'X-Upstream-Status': String(status) },
        }),
    });
    await assert.rejects(source.getSnapshot({ box: outside }), (error) => {
      assert.equal(
        error.message,
        status === 429 ? 'iNaturalist rate limited' : 'iNaturalist HTTP 502',
      );
      assert.equal(error.status, status);
      return true;
    });
  }
});

test('Retry-After delta seconds and HTTP dates use the injected source clock', async () => {
  for (const [header, seconds] of [
    ['3600', 3600],
    [new Date(now + 12 * 3_600_000).toUTCString(), 43_200],
    [new Date(now - 1000).toUTCString(), 0],
    ['0', 0],
    ['not a deadline', undefined],
    ['-10', undefined],
    ['', undefined],
  ]) {
    const source = createWildlifeSightingsSource({
      now: () => now,
      fetchImpl: async () =>
        new Response('', {
          status: 429,
          headers: { 'Retry-After': header },
        }),
    });
    await assert.rejects(source.getSnapshot({ box: outside }), (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterSec, seconds, header);
      return true;
    });
  }
});

test('malformed envelopes and invalid rows reject instead of becoming empty', async () => {
  for (const payload of [
    {},
    { rows: {} },
    { rows: [], totalResults: null },
    { rows: [{}], totalResults: 1 },
    { results: [], total_results: 0 },
  ]) {
    const source = createWildlifeSightingsSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(
      source.getSnapshot({ box: outside }),
      /Malformed iNaturalist response/,
    );
  }
  const source = createWildlifeSightingsSource({
    fetchImpl: async () => new Response('{bad'),
  });
  await assert.rejects(
    source.getSnapshot({ box: outside }),
    /Malformed iNaturalist response/,
  );
});

test('well-formed empty projected snapshot is legitimate and getSnapshot returns only rows', async () => {
  const source = createWildlifeSightingsSource({
    fetchImpl: async () =>
      Response.json(inatEnvelope({ rows: [], totalResults: 0 })),
  });
  assert.deepEqual(await source.getSnapshot({ box: outside }), []);
});

test('abort is checked before acquisition and after a late fetch resolves', async () => {
  const early = new AbortController();
  early.abort();
  const idle = createWildlifeSightingsSource({
    fetchImpl: () => assert.fail('aborted fetch ran'),
  });
  await assert.rejects(
    idle.getSnapshot({ box: outside, signal: early.signal }),
    { name: 'AbortError' },
  );
  let resolve;
  const source = createWildlifeSightingsSource({
    fetchImpl: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const late = new AbortController();
  const request = source.getSnapshot({ box: outside, signal: late.signal });
  late.abort();
  resolve(Response.json(inatEnvelope()));
  await assert.rejects(request, { name: 'AbortError' });
});

const gridCell = {
  id: 'grid:2/1/1:1:51',
  cellCount: 6,
  lat: 65.94,
  lon: -18.28125,
};
const gridEnvelope = (extra = {}) => ({
  cells: [gridCell],
  totalResults: 6,
  fetchedAt: now,
  ...extra,
});
const gridTile = { z: 2, x: 1, y: 1 };

test('grid source sends visible XYZ/filter parameters only, dedupes tiles and keeps source untouched', async () => {
  const urls = [];
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url, options) => {
      urls.push(new URL(url, 'https://example.test'));
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(gridEnvelope());
    },
  });
  const result = await source.getGridSnapshot({
    tiles: [gridTile, gridTile],
    confirmed: true,
    taxa: 'Aves',
  });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].pathname, '/api/inaturalist/grid');
  assert.deepEqual(Object.fromEntries(urls[0].searchParams), {
    z: '2',
    x: '1',
    y: '1',
    taxa: 'Aves',
    quality: 'research',
  });
  assert.deepEqual(result, {
    cells: [gridCell],
    totalResults: 6,
    fetchedAt: now,
    stale: false,
  });
});

test('grid source caches stable tile/filter/hour keys and combines neighbor edge cells once', async () => {
  let clock = now;
  let calls = 0;
  const source = createWildlifeSightingsSource({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(gridEnvelope());
    },
  });
  const options = { tiles: [gridTile, { z: 2, x: 2, y: 1 }] };
  const result = await source.getGridSnapshot(options);
  assert.equal(calls, 2);
  assert.equal(
    result.cells.length,
    1,
    'same geographic cell can bleed into a neighboring hit tile',
  );
  assert.equal(result.totalResults, 6);
  await source.getGridSnapshot({ tiles: [...options.tiles].reverse() });
  assert.equal(calls, 2, 'ordering does not change stable keys');
  await source.getGridSnapshot({ ...options, confirmed: true });
  assert.equal(calls, 4, 'quality changes the key');
  clock += WILDLIFE_GRID_TTL_MS + 1;
  await source.getGridSnapshot(options);
  assert.equal(calls, 6, 'fifteen minute refresh cap');
});

test('grid source preserves stale metadata and rejects invalid projected schema/privacy fields', async () => {
  const staleSource = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async () =>
      Response.json(gridEnvelope({ stale: true, fetchedAt: now - 1000 })),
  });
  const stale = await staleSource.getGridSnapshot({ tiles: [gridTile] });
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, now - 1000);
  for (const payload of [
    {},
    gridEnvelope({ cells: {} }),
    gridEnvelope({ totalResults: -1 }),
    gridEnvelope({ totalResults: 5 }),
    gridEnvelope({ fetchedAt: null }),
    gridEnvelope({ cells: [{ ...gridCell, uuid: 'must-not-leave-proxy' }] }),
    gridEnvelope({ cells: [{ ...gridCell, iconic: 'Aves' }] }),
    gridEnvelope({ cells: [{ ...gridCell, lat: 91 }] }),
    gridEnvelope({ cells: [{ ...gridCell, id: 'grid:99/0/0:1:1' }] }),
    gridEnvelope({ cells: [{ ...gridCell, id: 'grid:2/1/1:3:51' }] }),
    gridEnvelope({ cells: [gridCell, gridCell], totalResults: 12 }),
  ]) {
    const source = createWildlifeSightingsSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(
      source.getGridSnapshot({ tiles: [gridTile] }),
      /Malformed iNaturalist grid response/,
    );
  }
});

test('grid source validates request bounds before fetching and aborts superseded loads', async () => {
  const idle = createWildlifeSightingsSource({
    fetchImpl: () => assert.fail('invalid/aborted grid acquired'),
  });
  for (const tiles of [
    undefined,
    [],
    [{ z: 2, x: 4, y: 0 }],
    [{ z: -1, x: 0, y: 0 }],
    Array(13).fill(gridTile),
  ]) {
    await assert.rejects(
      idle.getGridSnapshot({ tiles }),
      /requires visible tiles/,
    );
  }
  const early = new AbortController();
  early.abort();
  await assert.rejects(
    idle.getGridSnapshot({ tiles: [gridTile], signal: early.signal }),
    { name: 'AbortError' },
  );
  let resolve;
  let passedSignal;
  const source = createWildlifeSightingsSource({
    fetchImpl: (_url, options) => {
      passedSignal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const late = new AbortController();
  const loading = source.getGridSnapshot({
    tiles: [gridTile],
    signal: late.signal,
  });
  late.abort();
  assert.equal(passedSignal.aborted, true);
  resolve(Response.json(gridEnvelope()));
  await assert.rejects(loading, { name: 'AbortError' });
});

test('grid worker concurrency is bounded and a failed tile preserves progressive siblings', async () => {
  const waiting = [];
  const source = createWildlifeSightingsSource({
    fetchImpl: (_url, options) =>
      new Promise((resolve, reject) => {
        waiting.push({ resolve, signal: options.signal });
        options.signal.addEventListener(
          'abort',
          () => reject(options.signal.reason),
          { once: true },
        );
      }),
  });
  const tiles = Array.from({ length: 6 }, (_, x) => ({ z: 3, x, y: 0 }));
  const loading = source.getGridSnapshot({ tiles });
  assert.equal(waiting.length, 4);
  waiting[0].resolve(new Response('', { status: 502 }));
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 1; i < 4; i++) waiting[i].resolve(Response.json(gridEnvelope()));
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 4; i < waiting.length; i++)
    waiting[i].resolve(Response.json(gridEnvelope()));
  const result = await loading;
  assert.equal(result.error.message, 'iNaturalist HTTP 502');
  assert.deepEqual(result.cells, [gridCell]);
  assert.ok(waiting.every((item) => !item.signal.aborted));
});

test('failed grid refresh keeps the tile last good cells across its window-hour key, without extending stale life', async () => {
  let clock = now + 55 * 60_000;
  let fail = false;
  let calls = 0;
  const source = createWildlifeSightingsSource({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return fail
        ? new Response('', { status: 502, headers: { 'Retry-After': '40' } })
        : Response.json(gridEnvelope({ fetchedAt: clock }));
    },
  });
  const good = await source.getGridSnapshot({
    tiles: [gridTile],
    taxa: 'whales',
  });
  const fetchedAt = clock;
  fail = true;
  clock += 300_001;
  const stale = await source.getGridSnapshot({
    tiles: [gridTile],
    taxa: 'whales',
  });
  assert.deepEqual(stale.cells, good.cells);
  assert.equal(stale.totalResults, good.totalResults);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, fetchedAt);
  assert.equal(stale.error.message, 'iNaturalist HTTP 502');
  assert.equal(stale.retryAfterSec, 40);
  assert.equal(calls, 2);
  await assert.rejects(
    source.getGridSnapshot({ tiles: [gridTile], taxa: 'Aves' }),
    /iNaturalist HTTP 502/,
    'a different filter cannot borrow the last tile',
  );
  clock = fetchedAt + 3_600_001;
  await assert.rejects(
    source.getGridSnapshot({ tiles: [gridTile], taxa: 'whales' }),
    /iNaturalist HTTP 502/,
    'failed refresh did not renew original data age',
  );
});

test('a rejected grid request never rejects a parallel observations acquisition', async () => {
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url) =>
      url.startsWith('/api/inaturalist/grid?')
        ? new Response('', { status: 502 })
        : Response.json(inatEnvelope()),
  });
  const [grid, observations] = await Promise.allSettled([
    source.getGridSnapshot({ tiles: [gridTile] }),
    source.getSnapshotDetail({ box: outside }),
  ]);
  assert.equal(grid.status, 'rejected');
  assert.equal(grid.reason.status, 502);
  assert.equal(observations.status, 'fulfilled');
  assert.deepEqual(observations.value.rows, [inat]);
});

test('one failed cached tile retains its cells while neighboring tiles refresh successfully', async () => {
  let clock = now;
  let refreshing = false;
  const neighbor = {
    ...gridCell,
    id: wildlifeGridCellId(30, 20, 2),
    lat: 30,
    lon: 20,
  };
  const signals = [];
  const source = createWildlifeSightingsSource({
    now: () => clock,
    fetchImpl: async (url, { signal }) => {
      signals.push(signal);
      const isFailedTile =
        new URL(url, 'https://example.test').searchParams.get('x') === '1';
      if (refreshing && isFailedTile) return new Response('', { status: 502 });
      const cell = isFailedTile
        ? gridCell
        : { ...neighbor, cellCount: refreshing ? 10 : 6 };
      return Response.json({
        cells: [cell],
        totalResults: cell.cellCount,
        fetchedAt: clock,
      });
    },
  });
  const options = { tiles: [gridTile, { z: 2, x: 2, y: 1 }] };
  await source.getGridSnapshot(options);
  refreshing = true;
  clock += WILDLIFE_GRID_TTL_MS + 1;
  const result = await source.getGridSnapshot(options);
  assert.equal(result.cells.length, 2);
  assert.equal(
    result.cells.find((cell) => cell.id === gridCell.id).cellCount,
    6,
  );
  assert.equal(
    result.cells.find((cell) => cell.id === neighbor.id).cellCount,
    10,
  );
  assert.equal(result.totalResults, 16);
  assert.equal(result.stale, true);
  assert.equal(result.error.message, 'iNaturalist HTTP 502');
  assert.ok(signals.every((signal) => !signal.aborted));
});

test('stale successful proxy answers preserve Retry-After for observation and grid retry guidance', async () => {
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: async (url) =>
      Response.json(
        url.startsWith('/api/inaturalist/grid?')
          ? gridEnvelope({ stale: true })
          : inatEnvelope({ stale: true }),
        { headers: { 'X-Data-Stale': 'true', 'Retry-After': '75' } },
      ),
  });
  const rows = await source.getSnapshotDetail({ box: outside });
  const grid = await source.getGridSnapshot({ tiles: [gridTile] });
  assert.equal(rows.stale, true);
  assert.equal(rows.retryAfterSec, 75);
  assert.equal(grid.stale, true);
  assert.equal(grid.retryAfterSec, 75);
});

test('client stale tiles publish before revalidation finishes and retain the original data date', async () => {
  let clock = now;
  let refresh;
  let calls = 0;
  const source = createWildlifeSightingsSource({
    now: () => clock,
    fetchImpl: () =>
      ++calls === 1
        ? Promise.resolve(Response.json(gridEnvelope()))
        : new Promise((resolve) => {
            refresh = resolve;
          }),
  });
  await source.getGridSnapshot({ tiles: [gridTile] });
  clock += WILDLIFE_GRID_TTL_MS + 1;
  const paints = [];
  const pending = source.getGridSnapshot({
    tiles: [gridTile],
    onTile: (tile) => paints.push(tile),
  });
  assert.equal(
    paints.length,
    1,
    'stale cache is synchronous, before the fetch settles',
  );
  assert.equal(paints[0].stale, true);
  assert.equal(paints[0].fetchedAt, now);
  refresh(
    Response.json(
      gridEnvelope({
        cells: [{ ...gridCell, cellCount: 9 }],
        totalResults: 9,
        fetchedAt: clock,
      }),
    ),
  );
  const result = await pending;
  assert.equal(paints.length, 2);
  assert.equal(paints[1].stale, undefined);
  assert.equal(result.totalResults, 9);
});

test('cached coverage publishes before slow misses earlier in XYZ order fill all workers', async () => {
  const waiting = [];
  let cold = false;
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: (url) => {
      const x = Number(
        new URL(url, 'https://example.test').searchParams.get('x'),
      );
      const cell = {
        id: wildlifeGridCellId(83, x * 45 - 157.5, 3),
        lat: 83,
        lon: x * 45 - 157.5,
        cellCount: 6,
      };
      const value = { cells: [cell], totalResults: 6, fetchedAt: now };
      return cold
        ? new Promise((resolve) =>
            waiting.push(() => resolve(Response.json(value))),
          )
        : Promise.resolve(Response.json(value));
    },
  });
  const tiles = Array.from({ length: 6 }, (_, x) => ({ z: 3, x, y: 0 }));
  await source.getGridSnapshot({ tiles: tiles.slice(4) });
  cold = true;
  const paints = [];
  const pending = source.getGridSnapshot({
    tiles,
    onTile: (value, metadata) => paints.push({ value, metadata }),
  });
  assert.deepEqual(
    paints.map(({ metadata }) => metadata.tile.x),
    [4, 5],
    'known cells paint synchronously even though the four earlier misses are unresolved',
  );
  assert.equal(waiting.length, 4);
  for (const finish of waiting) finish();
  const result = await pending;
  assert.equal(result.cells.length, 6);
  assert.equal(result.totalResults, 36);
});

test('an adjacent zoom cache fills the new tile immediately while its exact cells load', async () => {
  let resolve;
  let calls = 0;
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: () =>
      ++calls === 1
        ? Promise.resolve(Response.json(gridEnvelope()))
        : new Promise((done) => {
            resolve = done;
          }),
  });
  await source.getGridSnapshot({ tiles: [gridTile] });
  const parent = { z: 1, x: 0, y: 0 };
  const paints = [];
  const pending = source.getGridSnapshot({
    tiles: [parent],
    onTile: (value) => paints.push(value),
  });
  assert.equal(paints.length, 1);
  assert.deepEqual(paints[0].cells, [gridCell]);
  assert.equal(calls, 2, 'the exact zoom still loads in the background');
  const cell = {
    ...gridCell,
    id: wildlifeGridCellId(gridCell.lat, gridCell.lon, 1),
  };
  resolve(Response.json(gridEnvelope({ cells: [cell] })));
  await pending;
  assert.equal(paints.length, 2);
  assert.deepEqual(paints[1].cells, [cell]);
});

test('concurrent client views share an in-flight tile without one consumer aborting the other', async () => {
  let resolve;
  let calls = 0;
  let signal;
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: (_url, options) => {
      calls++;
      signal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const first = new AbortController();
  const one = source.getGridSnapshot({
    tiles: [gridTile],
    signal: first.signal,
  });
  const two = source.getGridSnapshot({ tiles: [gridTile] });
  first.abort();
  await assert.rejects(one, { name: 'AbortError' });
  assert.equal(signal.aborted, false);
  resolve(Response.json(gridEnvelope()));
  assert.equal((await two).totalResults, 6);
  assert.equal(calls, 1);
  await source.getGridSnapshot({ tiles: [gridTile] });
  assert.equal(calls, 1);
});

test('local HTTP pacing errors never become iNaturalist rate-limited errors', async () => {
  for (const status of [429, 503]) {
    const source = createWildlifeSightingsSource({
      fetchImpl: async () =>
        new Response('', { status, headers: { 'Retry-After': '30' } }),
    });
    await assert.rejects(
      source.getSnapshotDetail({ box: outside }),
      (error) => {
        assert.equal(error.upstreamStatus, 0);
        assert.doesNotMatch(error.message, /rate limited/i);
        return true;
      },
    );
  }
});

test('a server stale-while-revalidate answer joins its refresh and publishes fresh cells in the same view', async () => {
  const urls = [];
  let resolve;
  const source = createWildlifeSightingsSource({
    now: () => now,
    fetchImpl: (url) => {
      urls.push(url);
      return urls.length === 1
        ? Promise.resolve(
            Response.json(
              gridEnvelope({
                stale: true,
                fetchedAt: now - WILDLIFE_GRID_TTL_MS - 1,
              }),
            ),
          )
        : new Promise((done) => {
            resolve = done;
          });
    },
  });
  const paints = [];
  const pending = source.getGridSnapshot({
    tiles: [gridTile],
    onTile: (value) => paints.push(value),
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(paints.length, 1);
  assert.equal(paints[0].stale, true);
  assert.equal(
    new URL(urls[1], 'https://example.test').searchParams.get('refresh'),
    'wait',
  );
  resolve(
    Response.json(
      gridEnvelope({
        cells: [{ ...gridCell, cellCount: 11 }],
        totalResults: 11,
      }),
    ),
  );
  assert.equal((await pending).totalResults, 11);
  assert.equal(paints.length, 2);
  assert.equal(paints[1].stale, undefined);
});
