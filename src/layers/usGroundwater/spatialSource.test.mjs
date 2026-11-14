import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sample from '../../../fixtures/us-groundwater/v1/expected-pack.json' with { type: 'json' };
import { createSpatialWellSource } from './spatialSource.js';
function harness(duplicate = false) {
  let index = {
    schemaVersion: 1,
    kind: 'gev-well-spatial-index',
    fallbackAcquisition: sample.acquisitions[0],
    regions: [],
  };
  const bodies = new Map();
  const calls = [];
  for (let i = 0; i < 6; i++) {
    const pack = structuredClone(sample);
    pack.records = [structuredClone(sample.records[duplicate ? 0 : i])];
    pack.records[0].longitude = duplicate ? 1 : i * 10 + 1;
    pack.records[0].latitude = 1;
    const body = JSON.stringify(pack);
    const hash = createHash('sha256').update(body).digest('hex');
    index.regions.push({
      url: `${hash}.json`,
      sha256: hash,
      count: 1,
      bounds: duplicate ? [0, 0, 5, 5] : [i * 10, 0, i * 10 + 5, 5],
    });
    bodies.set(`/well-index-v1/${hash}.json`, body);
  }
  const fetchImpl = async (path, opts) => {
    path = new URL(path).pathname;
    calls.push(path);
    opts.signal.throwIfAborted();
    return new Response(
      path.endsWith('index.json') ? JSON.stringify(index) : bodies.get(path),
    );
  };
  return {
    source: createSpatialWellSource({ fetchImpl }),
    calls,
    index,
    bodies,
  };
}
test('viewport switches spatial packs; broad view stays bounded and deduplicates IDs', async () => {
  const h = harness();
  const a = await h.source.getSnapshot({ bounds: [0, 0, 5, 5] });
  const b = await h.source.getSnapshot({ bounds: [20, 0, 25, 5] });
  assert.notEqual(a.records[0].id, b.records[0].id);
  h.calls.length = 0;
  const wide = await h.source.getSnapshot();
  assert.equal(wide.records.length, 6);
  assert.equal(h.calls.length, 5, 'index plus four uncached immutable packs');
  assert.match(wide.coverage.description, /all 6/);
  const d = harness(true);
  assert.equal((await d.source.getSnapshot()).records.length, 1);
});
test('empty partial coverage is valid, and a new valid index batch becomes visible', async () => {
  const h = harness();
  const removed = h.index.regions.splice(0);
  assert.equal((await h.source.getSnapshot()).records.length, 0);
  h.index.regions.push(removed[0]);
  assert.equal((await h.source.getSnapshot()).records.length, 1);
});

test('conflicting records sharing a source ID are refused rather than overwritten', async () => {
  const h = harness(true);
  const tile = h.index.regions[1];
  const pack = JSON.parse(h.bodies.get('/well-index-v1/' + tile.url));
  pack.records[0].name = 'Different reported metadata';
  const body = JSON.stringify(pack);
  tile.sha256 = createHash('sha256').update(body).digest('hex');
  tile.url = `${tile.sha256}.json`;
  h.bodies.set('/well-index-v1/' + tile.url, body);
  await assert.rejects(h.source.getSnapshot(), /Conflicting source ID/);
});
test('hash tampering and malformed index fail closed; cancellation rejects', async () => {
  const h = harness();
  h.bodies.set('/well-index-v1/' + h.index.regions[0].url, '{}');
  await assert.rejects(h.source.getSnapshot({ bounds: [0, 0, 5, 5] }), /hash/);
  h.index.regions[0].url = '../outside';
  await assert.rejects(h.source.getSnapshot(), /tile/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.source.getSnapshot({ signal: controller.signal }));
});
test('newer viewport aborts old fetch and stale completion never returns a pack', async () => {
  let resolve;
  let oldSignal;
  let count = 0;
  const h = harness();
  const source = createSpatialWellSource({
    fetchImpl: async (path, options) => {
      if (++count === 1) {
        oldSignal = options.signal;
        return new Promise((r) => {
          resolve = r;
        });
      }
      return new Response(JSON.stringify({ ...h.index, regions: [] }));
    },
  });
  const old = source.getSnapshot();
  const rejection = assert.rejects(old);
  await source.getSnapshot();
  assert.equal(oldSignal.aborted, true);
  resolve(new Response(JSON.stringify(h.index)));
  await rejection;
  source.cancel();
});
import { GRID_SIZES, validateCountGrids, countView } from './countGrids.js';
function grids(points) {
  return {
    schemaVersion: 1,
    kind: 'gev-well-count-grids',
    centerMethod: 'record-mean',
    total: points.length,
    levels: GRID_SIZES.map((size) => {
      const cells = new Map();
      for (const [lon, lat] of points) {
        const x = Math.floor((lon + 180) / size),
          y = Math.floor((lat + 90) / size),
          key = `${x}:${y}`;
        if (!cells.has(key))
          cells.set(key, {
            bounds: [
              x * size - 180,
              y * size - 90,
              Math.min(180, (x + 1) * size - 180),
              Math.min(90, (y + 1) * size - 90),
            ],
            count: 0,
            center: [0, 0],
          });
        cells.get(key).count++;
        cells.get(key).center[0] += lon;
        cells.get(key).center[1] += lat;
      }
      return {
        degrees: size,
        total: points.length,
        cells: [...cells.values()].map((c) => ({
          ...c,
          center: c.center.map((x) => x / c.count),
        })),
      };
    }),
  };
}
function addCounts(h, points) {
  const value = grids(points),
    body = JSON.stringify(value),
    sha = createHash('sha256').update(body).digest('hex');
  h.index.indexedRecords = points.length;
  h.index.aggregates = { url: `${sha}.counts.json`, sha256: sha };
  h.bodies.set(`/well-index-v1/${sha}.counts.json`, body);
  return value;
}

test('revisited tiles reuse verified bytes without sharing mutable records or concealing changed index hashes', async () => {
  const h = harness();
  const bounds = [0, 0, 5, 5];
  const first = await h.source.getSnapshot({ bounds });
  const name = first.records[0].name;
  first.records[0].name = 'caller mutation';
  h.calls.length = 0;
  const next = await h.source.getSnapshot({ bounds });
  assert.equal(next.records[0].name, name);
  assert.deepEqual(h.calls, ['/well-index-v1/index.json']);
  const tile = h.index.regions[0];
  const changed = JSON.parse(h.bodies.get('/well-index-v1/' + tile.url));
  changed.records[0].name = 'New source metadata';
  const body = JSON.stringify(changed);
  tile.sha256 = createHash('sha256').update(body).digest('hex');
  tile.url = tile.sha256 + '.json';
  h.bodies.set('/well-index-v1/' + tile.url, body);
  assert.equal(
    (await h.source.getSnapshot({ bounds })).records[0].name,
    'New source metadata',
  );
});

test('hierarchical twelve separates into two sixes without inventing coincident locations', () => {
  const points = [
    ...Array(6).fill([1.001, 1.001]),
    ...Array(6).fill([1.1, 1.1]),
  ];
  const value = validateCountGrids(grids(points), 12);
  const wide = countView(value, [0, 0, 2, 2], 'test', 1);
  assert.deepEqual(
    wide.cells.map((c) => c.count),
    [12],
  );
  const fine = countView(value, [0, 0, 2, 2], 'test', 4096);
  assert.deepEqual(
    fine.cells.map((c) => c.count),
    [6, 6],
  );
  fine.cells.forEach((c, i) =>
    c.center.forEach((v) => assert.ok(Math.abs(v - [1.001, 1.1][i]) < 1e-12)),
  );
  assert.equal(
    fine.cells.reduce((n, c) => n + c.count, 0),
    12,
  );
});

test('reconciled manifest total accompanies narrow detail and complete count views', async () => {
  const h = harness();
  addCounts(
    h,
    Array.from({ length: 6 }, (_, i) => [i * 10 + 1, 1]),
  );
  const detail = await h.source.getSnapshot({ bounds: [0, 0, 1.5, 1.5] });
  assert.equal(detail.records.length, 1);
  assert.equal(detail.catalogTotal, h.index.indexedRecords);
  const other = await h.source.getSnapshot({ bounds: [20, 0, 21.5, 1.5] });
  assert.equal(other.records.length, 1);
  assert.equal(other.catalogTotal, 6);
  const overview = await h.source.getSnapshot();
  assert.equal(overview.catalogTotal, 6);
  h.index.indexedRecords = 7;
  await assert.rejects(h.source.getSnapshot(), /accounting/);
});
test('count grids conserve totals, align, nest, and reject overlaps or tampering', () => {
  const points = [
      [-179.9, 1],
      [179.9, 1],
      [1, 1],
      [1.01, 1],
    ],
    value = grids(points);
  assert.equal(validateCountGrids(value, 4), value);
  for (const l of value.levels)
    assert.equal(
      l.cells.reduce((n, c) => n + c.count, 0),
      4,
    );
  assert.equal(
    countView(value, [170, -5, -170, 5], 'test').cells.reduce(
      (n, c) => n + c.count,
      0,
    ),
    2,
  );
  for (const mutate of [
    (v) => v.levels.reverse(),
    (v) => v.levels[0].cells.push(v.levels[0].cells[0]),
    (v) => v.levels[1].cells[0].count++,
    (v) => (v.levels[2].cells[0].bounds[0] += 0.1),
  ]) {
    const bad = structuredClone(value);
    mutate(bad);
    assert.throws(() => validateCountGrids(bad, 4));
  }
  assert.equal(countView(value, [60, -5, 61, 5], 'test').cells.length, 0);
  assert.equal(countView(value, null, 'No visible ellipsoid').cells.length, 0);
});
test('overview covers all source rows, detail loads every sparse fragmented pack, dense detail falls back to complete counts', async () => {
  const h = harness();
  addCounts(
    h,
    Array.from({ length: 6 }, (_, i) => [i * 10 + 1, 1]),
  );
  const wide = await h.source.getSnapshot();
  assert.equal(wide.kind, 'gev-us-groundwater-wells');
  assert.equal(
    wide.records.length,
    6,
    'wide sparse views need no arbitrary span cutoff',
  );
  assert.equal(h.calls.length, 8);
  const near = await h.source.getSnapshot({ bounds: [0, 0, 2, 2] });
  assert.equal(near.records.length, 1);
  // Six acquisition fragments in one cell, fewer than the actual record budget.
  for (const t of h.index.regions) {
    const p = JSON.parse(h.bodies.get('/well-index-v1/' + t.url));
    p.records[0].longitude = 0.1;
    p.records[0].latitude = 0.1;
    const body = JSON.stringify(p),
      hash = createHash('sha256').update(body).digest('hex');
    t.url = hash + '.json';
    t.sha256 = hash;
    t.bounds = [0, 0, 0.5, 0.5];
    h.bodies.set('/well-index-v1/' + t.url, body);
  }
  addCounts(
    h,
    Array.from({ length: 6 }, () => [0.1, 0.1]),
  );
  const sparse = await h.source.getSnapshot({ bounds: [0, 0, 0.25, 0.25] });
  assert.equal(sparse.kind, 'gev-us-groundwater-wells');
  assert.match(sparse.coverage.description, /all 6/);
  assert.equal(sparse.records.length, 6);
  for (const t of h.index.regions) t.count = 500;
  addCounts(
    h,
    Array.from({ length: 3000 }, () => [0.1, 0.1]),
  );
  const dense = await h.source.getSnapshot({ bounds: [0, 0, 0.25, 0.25] });
  assert.equal(dense.kind, 'gev-well-count-view');
  assert.match(dense.reason, /budget/);
  const none = await h.source.getSnapshot({ bounds: null });
  assert.equal(none.cells.length, 0);
});

test('weighted cluster centers follow records, hierarchy tampering fails, and verified count bytes are cached', async () => {
  const h = harness();
  const g = addCounts(h, [
    [1, 1],
    [1.01, 1],
    [1.02, 1],
    [1.03, 1],
    [1.04, 1],
    [1.05, 1],
  ]);
  const mean = (1 + 1.01 + 1.02 + 1.03 + 1.04 + 1.05) / 6;
  assert.ok(Math.abs(g.levels[0].cells[0].center[0] - mean) < 1e-12);
  validateCountGrids(g, 6);
  const bad = structuredClone(g);
  bad.levels[0].cells[0].center[0] += 0.01;
  assert.throws(() => validateCountGrids(bad, 6), /hierarchy/);
  const outside = structuredClone(g);
  outside.levels[0].cells[0].center = [999, 0];
  assert.throws(() => validateCountGrids(outside, 6), /center/);
  h.calls.length = 0;
  await h.source.getSnapshot({ bounds: null });
  assert.equal(h.calls.length, 1);
  h.calls.length = 0;
  await h.source.getSnapshot();
  assert.equal(h.calls.filter((x) => x.endsWith('.counts.json')).length, 1);
  h.calls.length = 0;
  await h.source.getSnapshot();
  assert.equal(
    h.calls.length,
    1,
    'both counts and immutable detail bytes cached; mutable index revalidated',
  );
  h.calls.length = 0;
  await h.source.getSnapshot({ bounds: null });
  assert.equal(h.calls.length, 1);
});

test('dense and sparse neighbors share weighted counts and exact source records without double counting', async () => {
  const h = harness();
  // Dense metadata is deliberately never fetched; sparse fixtures carry exact IDs/readings.
  for (const t of h.index.regions) {
    t.count = 500;
    t.bounds = [0, 0, 0.5, 0.5];
    t.bytes = 100000;
  }
  const denseUrls = h.index.regions.map((t) => t.url);
  const sparse = [1.01, 1.04].map((lon, i) => {
    const p = structuredClone(sample);
    p.records = [structuredClone(sample.records[i])];
    p.records[0].longitude = lon;
    p.records[0].latitude = 1.01;
    const body = JSON.stringify(p),
      sha = createHash('sha256').update(body).digest('hex');
    const tile = {
      url: sha + '.json',
      sha256: sha,
      count: 1,
      bytes: body.length,
      bounds: [lon - 0.001, 1, lon + 0.001, 1.02],
    };
    h.index.regions.push(tile);
    h.bodies.set('/well-index-v1/' + tile.url, body);
    return p.records[0];
  });
  addCounts(h, [
    ...Array.from({ length: 3000 }, () => [0.1, 0.1]),
    ...sparse.map((r) => [r.longitude, r.latitude]),
  ]);
  const wide = await h.source.getSnapshot({ bounds: [0, 0, 2, 2] });
  assert.equal(wide.total, 3002);
  assert.equal(
    wide.cells.reduce((n, c) => n + c.count, 0),
    3000,
  );
  assert.deepEqual(wide.detailPack.records, sparse);
  assert.equal(
    h.calls.some((url) => denseUrls.some((name) => url.endsWith(name))),
    false,
  );
  assert.equal(h.calls.length, 4);
  h.calls.length = 0;
  const unresolved = await h.source.getSnapshot({
    bounds: [0, 0, 2, 2],
    detailPriority: () => Infinity,
  });
  assert.equal(
    unresolved.detailPack,
    undefined,
    'unresolvable wide-view cells never expose an arbitrary detail island',
  );
  assert.equal(
    unresolved.cells.reduce((n, c) => n + c.count, 0),
    3002,
  );
  assert.equal(
    h.calls.length,
    1,
    'only index refresh; no ineligible detail reads',
  );
  const near = await h.source.getSnapshot({ bounds: [1, 1, 1.1, 1.1] });
  assert.equal(near.catalogTotal, 3002);
  assert.deepEqual(near.records, sparse);
  const again = await h.source.getSnapshot({ bounds: [0, 0, 2, 2] });
  assert.equal(
    again.cells.reduce((n, c) => n + c.count, 0) +
      again.detailPack.records.length,
    3002,
  );
  const bad = structuredClone(again);
  bad.cells.push({
    bounds: [1, 1, 1.03125, 1.03125],
    center: [1.01, 1.01],
    count: 1,
  });
  const { validateCountView } = await import('./countGrids.js');
  assert.throws(() => validateCountView(bad), /overlaps/);
});

test('catalog publication waits for admitted snapshot and failed refresh keeps last-good summary', async () => {
  const h = harness();
  let index = {
    ...h.index,
    indexedRecords: 6,
    catalogRecords: 6,
    unmappedRecords: 0,
  };
  const published = [];
  const source = createSpatialWellSource({
    onCatalog: (s) => published.push(s),
    fetchImpl: async (url) => {
      const p = new URL(url).pathname;
      return new Response(
        p.endsWith('index.json') ? JSON.stringify(index) : h.bodies.get(p),
      );
    },
  });
  await source.getSnapshot();
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    catalogRecords: 6,
    mappedRecords: 6,
    unmappedRecords: 0,
    distinctPhysicalWells: null,
  });
  index = {
    schemaVersion: 999,
    kind: 'invalid',
    sourceKind: 'USGWD',
    children: [],
    regions: [],
    indexedRecords: 123,
    catalogRecords: 987,
    unmappedRecords: 864,
  };
  await assert.rejects(source.getSnapshot());
  assert.equal(published.length, 1);
  assert.equal(published[0].catalogRecords, 6);
});

test('allowlisted HTTPS data origin loads root and hashed detail inside version directory', async () => {
  const h = harness(),
    calls = [];
  const base = 'https://data.example.test/wells/releases/synthetic-001/';
  const source = createSpatialWellSource({
    base,
    allowedDataOrigins: ['https://data.example.test'],
    fetchImpl: async (url, options) => {
      assert.ok(url.startsWith(base));
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-cache');
      calls.push(url);
      const relative = url.slice(base.length);
      return new Response(
        relative === 'index.json'
          ? JSON.stringify(h.index)
          : h.bodies.get('/well-index-v1/' + relative),
      );
    },
  });
  const pack = await source.getSnapshot({ bounds: [0, 0, 5, 5] });
  assert.equal(pack.records.length, 1);
  assert.deepEqual(calls, [base + 'index.json', base + h.index.regions[0].url]);
});

test('remote hash tampering and manifest URL escape still fail closed', async () => {
  const h = harness(),
    calls = [];
  const base = 'https://data.example.test/wells/';
  const source = createSpatialWellSource({
    base,
    allowedDataOrigins: ['https://data.example.test'],
    fetchImpl: async (url) => {
      assert.ok(url.startsWith(base));
      calls.push(url);
      return new Response(
        url === base + 'index.json' ? JSON.stringify(h.index) : '{}',
      );
    },
  });
  await assert.rejects(source.getSnapshot({ bounds: [0, 0, 5, 5] }), /hash/);
  calls.length = 0;
  h.index.regions[0].url = 'https://evil.example.test/tile.json';
  await assert.rejects(source.getSnapshot(), /tile/);
  assert.deepEqual(calls, [base + 'index.json']);
});

test('a cached child must still match the current reference length and cap', async () => {
  const h = harness();
  const child = JSON.stringify({
    ...h.index,
    sourceKind: 'USGWD',
    sourceState: 'Alaska',
    coverageComplete: false,
    indexedRecords: 1,
    regions: [h.index.regions[0]],
  });
  const sha256 = createHash('sha256').update(child).digest('hex');
  const ref = {
    state: 'Alaska',
    directory: 'states/Alaska/',
    url: `states/Alaska/${sha256}.index.json`,
    sha256,
    bytes: Buffer.byteLength(child),
    count: 1,
    bounds: [0, 0, 2, 2],
  };
  const root = {
    ...h.index,
    sourceKind: 'USGWD',
    indexedRecords: 1,
    catalogRecords: 1,
    unmappedRecords: 0,
    children: [ref],
    regions: [],
  };
  const calls = [];
  const source = createSpatialWellSource({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname.replace('/well-index-v1/', '');
      calls.push(path);
      return new Response(
        path === 'index.json'
          ? JSON.stringify(root)
          : path === ref.url
            ? child
            : h.bodies.get(
                `/well-index-v1/${path.replace('states/Alaska/', '')}`,
              ),
      );
    },
  });
  const bounds = [0, 0, 1.5, 1.5];
  assert.equal((await source.getSnapshot({ bounds })).records.length, 1);
  const exactBytes = ref.bytes;
  for (const bytes of [exactBytes + 1, exactBytes - 1]) {
    calls.length = 0;
    ref.bytes = bytes;
    await assert.rejects(
      source.getSnapshot({ bounds }),
      /byte mismatch|byte limit/,
    );
    assert.deepEqual(
      calls,
      ['index.json'],
      'the cached child is checked again',
    );
  }
});
