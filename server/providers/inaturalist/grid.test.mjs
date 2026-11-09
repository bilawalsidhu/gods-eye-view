import test from 'node:test';
import assert from 'node:assert/strict';
import { projectInatGrid } from './grid.js';
import { syntheticGrid } from './grid.fixture.mjs';
import { installInatProxy, NOW } from './proxy.fixture.mjs';
import { createInatClient } from './client.js';

const tile = { z: 2, x: 1, y: 1 };
const gridUrl = '/grid?z=2&x=1&y=1&taxa=Aves&quality=research';
const install = (options, hook) => installInatProxy(gridUrl, options, hook);

test('UTFGrid projection validates the full shape and counts each logical occupied cell once', () => {
  const raw = syntheticGrid();
  const projected = projectInatGrid(raw, tile);
  assert.equal(raw.grid.length, 64);
  assert.ok(raw.grid.every((row) => row.length === 64));
  assert.equal(
    raw.grid.join('').split('!').length - 1,
    5,
    'one key is repeated by its hit area',
  );
  assert.equal(projected.cells.length, 2);
  assert.equal(projected.totalResults, 18);
  assert.deepEqual(projected.cells[0], {
    id: 'grid:2/1/1:1:51',
    cellCount: 6,
    lat: raw.data[raw.keys[1]].latitude,
    lon: raw.data[raw.keys[1]].longitude,
  });
  for (const cell of projected.cells)
    assert.deepEqual(Object.keys(cell).sort(), [
      'cellCount',
      'id',
      'lat',
      'lon',
    ]);
  for (const privateField of [
    '900000000',
    'uuid',
    'geoprivacy',
    'private_location',
    'captive',
    'quality_grade',
  ])
    assert.ok(!JSON.stringify(projected).includes(privateField));
});

test('legitimate blank grid and null/unknown iconic ids remain safe', () => {
  assert.deepEqual(projectInatGrid(syntheticGrid({ cells: [] }), tile), {
    cells: [],
    totalResults: 0,
  });
  const raw = syntheticGrid({
    cells: [{ row: 1, column: 1, count: 1, iconic: null }],
  });
  const projected = projectInatGrid(raw, tile);
  assert.equal(projected.cells[0].cellCount, 1);
  raw.data[raw.keys[1]]['taxon.iconic_taxon_id'] = 999999;
  assert.deepEqual(projectInatGrid(raw, tile), projected);
});

test('schema drift anywhere fails closed, including unused, malformed and orphan cells', () => {
  const changes = [
    (raw) => {
      raw.grid.pop();
    },
    (raw) => {
      raw.grid[0] = '';
    },
    (raw) => {
      raw.grid[0] = '~'.repeat(64);
    },
    (raw) => {
      raw.keys[0] = 'not-empty';
    },
    (raw) => {
      raw.keys.push(raw.keys[1]);
    },
    (raw) => {
      delete raw.data[raw.keys[1]];
    },
    (raw) => {
      raw.data.extra = {};
    },
    (raw) => {
      raw.data[raw.keys[1]].cellCount = -1;
    },
    (raw) => {
      raw.data[raw.keys[1]].latitude = '47';
    },
    (raw) => {
      raw.data[raw.keys[1]].longitude = 181;
    },
    (raw) => {
      raw.data[raw.keys[1]].quality_grade = 'new-grade';
    },
    (raw) => {
      delete raw.data[raw.keys[1]]['taxon.iconic_taxon_id'];
    },
    (raw) => {
      raw.data[raw.keys[1]]['taxon.iconic_taxon_id'] = 'Aves';
    },
    (raw) => {
      raw.grid = Array(64).fill(' '.repeat(64));
    },
  ];
  for (const change of changes) {
    const raw = syntheticGrid();
    change(raw);
    assert.throws(
      () => projectInatGrid(raw, tile),
      /Invalid iNaturalist UTFGrid/,
    );
  }
});

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: fixed grid URL shares filters, caps and allow-list cache`, async () => {
    const calls = [];
    const cache = new Map();
    const request = install(
      {
        cache,
        fetchImpl: async (url, options) => {
          calls.push(new URL(url));
          assert.equal(options.redirect, 'error');
          assert.ok(options.signal instanceof AbortSignal);
          assert.match(
            options.headers['User-Agent'],
            /^gods-eye-view-wildlife-sightings-proxy/,
          );
          return Response.json(syntheticGrid());
        },
      },
      hook,
    );
    assert.equal(calls.length, 0);
    const response = await request(
      `${gridUrl}&url=https://attacker.test&per_page=999`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.cells.length, 2);
    assert.equal(response.body.fetchedAt, NOW);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(
      calls[0].origin + calls[0].pathname,
      'https://api.inaturalist.org/v1/grid/2/1/1.grid.json',
    );
    assert.deepEqual(Object.fromEntries(calls[0].searchParams), {
      verifiable: 'true',
      captive: 'false',
      d1: '2026-11-02',
      photos: 'true',
      quality_grade: 'research',
      iconic_taxa: 'Aves',
    });
    await request(gridUrl);
    assert.equal(calls.length, 1, 'fresh stable tile/filter key is cached');
    assert.ok(!JSON.stringify([...cache]).includes('private_location'));
    assert.ok(!JSON.stringify([...cache]).includes('900000000'));
    const whale = await request('/grid?z=2&x=1&y=1&taxa=whales&confirmed=true');
    assert.equal(whale.status, 200);
    assert.equal(calls[1].searchParams.get('taxon_id'), '152871');
    assert.equal(calls[1].searchParams.get('d1'), '2026-10-28');
    assert.equal(calls[1].searchParams.has('photos'), false);
  });
}

test('grid admission rejects cross-site/method/path/tile before acquisition', async () => {
  const request = install({
    fetchImpl() {
      assert.fail('invalid grid request acquired');
    },
  });
  assert.equal(
    (
      await request(gridUrl, {
        headers: {
          host: 'localhost:5173',
          origin: 'https://other.test',
          'sec-fetch-site': 'cross-site',
        },
      })
    ).status,
    403,
  );
  assert.equal((await request('/grid', { method: 'POST' })).status, 405);
  assert.equal((await request('/grid/extra')).status, 404);
  for (const query of [
    '',
    'z=2&x=4&y=0',
    'z=-1&x=0&y=0',
    'z=23&x=0&y=0',
    'z=2&x=1.5&y=0',
    'z=2&x=&y=0',
    'z=2&x=0&y=4',
  ]) {
    const result = await request(`/grid?${query}`);
    assert.equal(result.status, 400, query);
    assert.equal(result.body.error, 'invalid_tile');
  }
});

test('grid refresh single-flight, stale fallback and hour-key expiry keep the original age', async () => {
  let time = NOW;
  let calls = 0;
  let resolve;
  let mode = 'pending';
  const request = install({
    now: () => time,
    fetchImpl: async () => {
      calls += 1;
      if (mode === 'pending')
        return new Promise((done) => {
          resolve = done;
        });
      if (mode === 'bad') return Response.json({ grid: [] });
      return Response.json(syntheticGrid());
    },
  });
  const first = request();
  const second = request();
  for (let i = 0; i < 100 && !resolve; i += 1) await new Promise(setImmediate);
  assert.equal(calls, 1);
  resolve(Response.json(syntheticGrid()));
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  time += 900_001;
  mode = 'bad';
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, NOW);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  time = NOW + 3_600_001;
  const expired = await request();
  assert.equal(expired.status, 502);
  assert.equal(expired.body.error, 'inaturalist_unavailable');
});

test('grid and observations share the upstream cooldown and daily reservations', async () => {
  let calls = 0;
  const client = createInatClient({
    now: () => NOW,
    cacheDir: null,
    queueOptions: { intervalMs: 0 },
    warn() {},
    fetchImpl: async () => {
      calls += 1;
      return new Response('', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });
    },
  });
  await assert.rejects(
    client.getGrid({ ...tile, taxa: 'all', observedD1: '2026-11-02' }),
    (error) => error.status === 429 && error.retryAfterS === 120,
  );
  await assert.rejects(
    client.getObservations({
      scope: 'global',
      taxa: 'all',
      observedD1: '2026-11-02',
    }),
    (error) => error.status === 429,
  );
  assert.equal(calls, 1);
  assert.equal(client.budgetState().count, 1);
});

test('grid body cap and upstream failures return fixed errors; only real 5xx cools down', async () => {
  for (const [response, retryAfter] of [
    [() => new Response('x'.repeat(8 * 1024 * 1024 + 1)), undefined],
    [() => new Response('', { status: 503 }), '15'],
  ]) {
    const request = install({ fetchImpl: async () => response() });
    const result = await request();
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { error: 'inaturalist_unavailable' });
    assert.equal(result.headers['Retry-After'], retryAfter);
  }
});

test('a failed tile preserves last good cells and cannot send unrelated observations into 502', async () => {
  let at = NOW;
  let failGrid = false;
  const calls = [];
  const warnings = [];
  const request = install({
    now: () => at,
    warn: (message) => warnings.push(message),
    fetchImpl: async (url) => {
      const isGrid = new URL(url).pathname.includes('/grid/');
      calls.push(isGrid ? 'grid' : 'observations');
      if (isGrid && failGrid)
        return new Response('private upstream text', {
          status: 503,
          headers: { 'Retry-After': '45' },
        });
      return Response.json(
        isGrid ? syntheticGrid() : { results: [], total_results: 0 },
      );
    },
  });
  const first = await request();
  at += 900_001;
  failGrid = true;
  const failed = await request();
  assert.equal(failed.status, 200);
  assert.equal(failed.headers['X-Data-Stale'], 'true');
  assert.equal(failed.body.stale, true);
  assert.equal(failed.body.fetchedAt, first.body.fetchedAt);
  assert.deepEqual(failed.body.cells, first.body.cells);
  assert.equal(
    (await request('/observations?scope=global&taxa=whales')).status,
    200,
  );
  assert.deepEqual(calls, ['grid', 'grid', 'observations']);
  assert.match(warnings[0], /resource=grid status=503 reason=http/);
  assert.doesNotMatch(warnings[0], /private upstream text/);
  // The tile cooldown also preserves its data without another upstream try.
  const cooling = await request();
  assert.equal(cooling.body.stale, true);
  assert.equal(cooling.headers['Retry-After'], '45');
  assert.equal(cooling.headers['X-Upstream-Status'], '503');
  assert.equal(calls.length, 3);
  at += 45_000;
  failGrid = false;
  const refreshing = await request();
  assert.equal(refreshing.body.stale, true);
  await new Promise(setImmediate);
  const recovered = await request();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.stale, undefined);
  assert.equal(
    calls.length,
    4,
    'a failed queue task does not poison later tile work',
  );
});

test('twelve queued tiles leave observation capacity and give the next dispatch to observations', async () => {
  const calls = [];
  let release;
  const request = install({
    fetchImpl: (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (calls.length === 1)
        return new Promise((resolve) => {
          release = resolve;
        });
      return Response.json(
        path.includes('/grid/')
          ? syntheticGrid()
          : { results: [], total_results: 0 },
      );
    },
  });
  const first = request('/grid?z=4&x=0&y=1');
  for (let i = 0; i < 100 && !release; i += 1) await new Promise(setImmediate);
  assert.ok(release);
  const tiles = Array.from({ length: 11 }, (_, i) =>
    request(`/grid?z=4&x=${i + 1}&y=1`),
  );
  const observation = request('/observations?scope=global');
  const queuedTile = request('/grid?z=4&x=12&y=1');
  release(Response.json(syntheticGrid()));
  const results = await Promise.all([first, observation, ...tiles, queuedTile]);
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(calls.length, 14);
  assert.equal(calls[1], '/v2/observations');
});
