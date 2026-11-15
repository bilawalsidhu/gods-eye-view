import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { USGWD_ACQUISITION } from './records.fixture.mjs';
import { createSpatialWellSource } from './spatialSource.js';
// These tests cover tiling, hashing and accounting, which do not depend on the
// record format: stand-in records skip USGWD admission (tested elsewhere).
const loose = (pack) => pack;
const standIn = (i) => ({ id: `T-${i}`, name: `Record ${i}` });
const packOf = (record) => ({
  schemaVersion: 1,
  kind: 'gev-us-groundwater-wells',
  mode: 'snapshot',
  coverage: { country: 'US', complete: false, indexed: true },
  acquisitions: [{ ...USGWD_ACQUISITION }],
  records: [record],
});
function harness(duplicate = false) {
  let index = {
    schemaVersion: 1,
    kind: 'gev-well-spatial-index',
    fallbackAcquisition: { ...USGWD_ACQUISITION },
    regions: [],
  };
  const bodies = new Map();
  const calls = [];
  for (let i = 0; i < 6; i++) {
    const pack = packOf(standIn(duplicate ? 0 : i));
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
    source: createSpatialWellSource({ fetchImpl, validatePack: loose }),
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
    validatePack: loose,
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
import { GRID_SIZES, countView } from './countGrids.js';
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
  const value = grids(points);
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

test('count views conserve totals across the dateline and empty views', () => {
  const points = [
      [-179.9, 1],
      [179.9, 1],
      [1, 1],
      [1.01, 1],
    ],
    value = grids(points);
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
  assert.equal(countView(value, [60, -5, 61, 5], 'test').cells.length, 0);
  assert.equal(countView(value, null, 'No visible ellipsoid').cells.length, 0);
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
    validatePack: loose,
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
    validatePack: loose,
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
    validatePack: loose,
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
    validatePack: loose,
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

test('real USGWD records pass the default admission end to end; tampering refuses', async () => {
  const { usgwdPack, usgwdRecord } = await import('./records.fixture.mjs');
  const serve = (pack) => {
    const body = JSON.stringify(pack),
      sha256 = createHash('sha256').update(body).digest('hex');
    const index = {
      schemaVersion: 1,
      kind: 'gev-well-spatial-index',
      fallbackAcquisition: { ...USGWD_ACQUISITION },
      regions: [
        { url: `${sha256}.json`, sha256, count: 1, bounds: [-98, 30, -97, 31] },
      ],
    };
    return createSpatialWellSource({
      fetchImpl: async (url) =>
        new Response(url.endsWith('index.json') ? JSON.stringify(index) : body),
    });
  };
  const bounds = [-98, 30, -97, 31];
  const pack = await serve(usgwdPack([usgwdRecord(7)])).getSnapshot({ bounds });
  assert.equal(pack.records.length, 1);
  assert.equal(pack.records[0].metadata.sourceRecordId, 'SYN_7');
  const bad = usgwdPack([usgwdRecord(7)]);
  bad.records[0].latitude += 0.001;
  await assert.rejects(
    serve(bad).getSnapshot({ bounds }),
    /Invalid historical/,
  );
});
