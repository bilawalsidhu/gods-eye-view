import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sample from '../../../fixtures/us-groundwater/v1/expected-pack.json' with { type: 'json' };
import { GRID_SIZES, countView } from './countGrids.js';
import {
  createPartitionedCountLoader,
  COUNT_FETCH_LIMITS,
} from './partitionedCounts.js';
import { createSpatialWellSource } from './spatialSource.js';

function fixture(points) {
  const files = new Map();
  const save = (value, suffix = 'counts.json') => {
    const body = JSON.stringify(value),
      sha256 = createHash('sha256').update(body).digest('hex'),
      url = `${sha256}.${suffix}`;
    files.set(url, body);
    return { url, sha256, bytes: Buffer.byteLength(body) };
  };
  const levels = GRID_SIZES.map((degrees) => {
    const groups = new Map();
    for (const [lon, lat] of points) {
      const west = Math.floor((lon + 180) / degrees) * degrees - 180,
        south = Math.floor((lat + 90) / degrees) * degrees - 90,
        key = `${west}:${south}`;
      if (!groups.has(key))
        groups.set(key, {
          bounds: [
            west,
            south,
            Math.min(west + degrees, 180),
            Math.min(south + degrees, 90),
          ],
          count: 0,
          center: [0, 0],
        });
      const c = groups.get(key);
      c.count++;
      c.center[0] += lon;
      c.center[1] += lat;
    }
    return {
      degrees,
      total: points.length,
      cells: [...groups.values()].map((c) => ({
        ...c,
        center: c.center.map((x) => x / c.count),
      })),
    };
  });
  const wrap = (levels_, total = points.length) => ({
    schemaVersion: 1,
    kind: 'gev-well-count-grids',
    centerMethod: 'record-mean',
    total,
    levels: levels_,
  });
  const reference = {
    schemaVersion: 2,
    kind: 'gev-well-partitioned-counts',
    total: points.length,
    overview: save(wrap(levels.slice(0, 4))),
    levels: levels.slice(4).map((level) => ({
      degrees: level.degrees,
      cellCount: level.cells.length,
      chunks: levels[2].cells.map((parent) => {
        const cells = level.cells.filter(
          (c) =>
            c.bounds[0] >= parent.bounds[0] &&
            c.bounds[1] >= parent.bounds[1] &&
            c.bounds[2] <= parent.bounds[2] &&
            c.bounds[3] <= parent.bounds[3],
        );
        return {
          ...save({
            ...wrap([{ ...level, total: parent.count, cells }], parent.count),
            parentBounds: parent.bounds,
          }),
          bounds: parent.bounds,
          count: parent.count,
          cellCount: cells.length,
        };
      }),
    })),
  };
  const read = async (ref) => JSON.parse(files.get(ref.url));
  return { reference, files, read, save, levels };
}

test('national overview reads one file; complete regional subtrees conserve boundaries and dateline counts', async () => {
  const points = Array.from({ length: 70 }, (_, i) => [-170 + i * 2, 1]);
  const f = fixture(points),
    loader = createPartitionedCountLoader(),
    calls = [];
  const value = await loader.load(
    f.reference,
    points.length,
    [-180, -90, 180, 90],
    4096,
    async (ref) => {
      calls.push(ref.url);
      return f.read(ref);
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(value.capped, true);
  assert.equal(
    countView(value.grids, [-180, -90, 180, 90], '').cells.reduce(
      (n, c) => n + c.count,
      0,
    ),
    70,
  );
  const edge = fixture([
    [-0.01, 0.01],
    [0, 0.01],
    [0.01, 0.01],
    [1.999, 0.01],
    [2.001, 0.01],
    [-179.99, 1],
    [179.99, 1],
  ]);
  const run = async (bounds) =>
    countView(
      (await loader.load(edge.reference, 7, bounds, 4096, edge.read)).grids,
      bounds,
      '',
    );
  const view = await run([-0.02, -0.1, 2.02, 0.1]);
  assert.equal(
    view.cells.reduce((n, c) => n + c.count, 0),
    5,
  );
  assert.equal(
    new Set(view.cells.map((c) => JSON.stringify(c.bounds))).size,
    view.cells.length,
  );
  const dateline = await run([179.9, 0, -179.9, 2]);
  assert.equal(
    dateline.cells.reduce((n, c) => n + c.count, 0),
    2,
  );
  const empty = await run([100, 50, 101, 51]);
  assert.equal(empty.cells.length, 0);
  assert.equal(empty.total, 7);
  let replayReads = 0;
  await loader.load(
    edge.reference,
    7,
    [-0.02, -0.1, 2.02, 0.1],
    4096,
    async (ref) => {
      replayReads++;
      return edge.read(ref);
    },
  );
  assert.equal(replayReads, 0);
  view.cells[0].count = 999;
  assert.equal(
    (await run([-0.02, -0.1, 2.02, 0.1])).cells.reduce(
      (n, c) => n + c.count,
      0,
    ),
    5,
    'view mutation cannot poison cached evidence',
  );
});

test('manifest/chunk tampering refuses incomplete or overlapping populations', async () => {
  for (const mutate of [
    (r) => r.levels[0].chunks.pop(),
    (r) => r.levels[0].chunks.push(r.levels[0].chunks[0]),
    (r) => r.levels[0].chunks[0].count++,
    (r) => (r.levels[1].chunks[0].url = 'https://outside.invalid/data'),
    (r) => r.levels.reverse(),
    (r) => r.levels[0].cellCount++,
  ]) {
    const f = fixture([
      [0.01, 0.01],
      [2.01, 0.01],
    ]);
    mutate(f.reference);
    await assert.rejects(
      createPartitionedCountLoader().load(
        f.reference,
        2,
        [0, 0, 3, 1],
        4096,
        f.read,
      ),
    );
  }
  const f = fixture([
      [0.01, 0.01],
      [0.02, 0.01],
    ]),
    part = f.reference.levels[0].chunks[0];
  const bad = JSON.parse(f.files.get(part.url));
  bad.levels[0].cells[0].center[0] = 0.1;
  f.files.set(part.url, JSON.stringify(bad));
  await assert.rejects(
    createPartitionedCountLoader().load(
      f.reference,
      2,
      [0, 0, 1, 1],
      4096,
      f.read,
    ),
    /weighted/,
  );
});

test('many viewport replays keep aggregate cache byte/cell/entry bounded', async () => {
  const f = fixture(Array.from({ length: 110 }, (_, i) => [-170 + i * 2, 1])),
    loader = createPartitionedCountLoader();
  for (let i = 0; i < 110; i++)
    await loader.load(
      f.reference,
      110,
      [-170 + i * 2, 0, -169 + i * 2, 2],
      4096,
      f.read,
    );
  const s = loader.getCacheStats();
  assert(s.bytes <= COUNT_FETCH_LIMITS.bytes);
  assert(s.cells <= COUNT_FETCH_LIMITS.cells);
  assert(s.entries <= COUNT_FETCH_LIMITS.entries);
});

test('parent totals alone cannot conceal inconsistent intermediate geography', async () => {
  const f = fixture([
    [0.1, 0.1],
    [0.6, 0.1],
  ]);
  const ref = f.reference.levels[0].chunks[0];
  const body = JSON.parse(f.files.get(ref.url));
  // Same 2-degree total and weighted center, but false distribution between
  // the already validated half-degree parents. A recomputed hash is not enough.
  body.levels[0].cells = [
    { bounds: [0.25, 0, 0.375, 0.125], count: 2, center: [0.35, 0.1] },
  ];
  f.reference.levels[0].chunks[0] = { ...ref, ...f.save(body), cellCount: 1 };
  f.reference.levels[0].cellCount = 1;
  await assert.rejects(
    createPartitionedCountLoader().load(
      f.reference,
      2,
      [0, 0, 1, 1],
      4096,
      f.read,
    ),
    /hierarchy/,
  );
});

function sourceFixture() {
  const points = sample.records.map((_, i) => [i * 10 + 0.01, 0.01]),
    f = fixture(points),
    calls = [];
  const index = {
    schemaVersion: 1,
    kind: 'gev-well-spatial-index',
    indexedRecords: 6,
    aggregates: f.reference,
    fallbackAcquisition: sample.acquisitions[0],
    regions: [],
  };
  for (const [i, [lon, lat]] of points.entries()) {
    const pack = structuredClone(sample);
    pack.records = [pack.records[i]];
    pack.records[0].longitude = lon;
    pack.records[0].latitude = lat;
    index.regions.push({
      ...f.save(pack, 'json'),
      bounds: [i * 10, 0, i * 10 + 0.5, 0.5],
      count: 1,
    });
  }
  const fetchImpl = async (url, opts) => {
    opts.signal.throwIfAborted();
    const name = new URL(url).pathname.split('/').at(-1);
    calls.push(name);
    return new Response(
      name === 'index.json' ? JSON.stringify(index) : f.files.get(name),
    );
  };
  return { ...f, index, calls, fetchImpl };
}

test('source verifies new chunk hashes/lengths, null view skips counts, legacy remains supported elsewhere', async () => {
  const f = sourceFixture(),
    source = createSpatialWellSource({ fetchImpl: f.fetchImpl });
  const none = await source.getSnapshot({ bounds: null });
  assert.equal(none.cells.length, 0);
  assert.deepEqual(f.calls, ['index.json']);
  const detail = await source.getSnapshot({ bounds: [0, 0, 0.02, 0.02] });
  assert.equal(detail.catalogTotal, 6);
  assert.equal(detail.records.length, 1);
  const bad = sourceFixture(),
    ref = bad.reference.levels[0].chunks[0];
  const original = bad.files.get(ref.url);
  bad.files.set(ref.url, original.replace('"count":1', '"count":9'));
  await assert.rejects(
    createSpatialWellSource({ fetchImpl: bad.fetchImpl }).getSnapshot({
      bounds: [0, 0, 0.02, 0.02],
    }),
    /hash/,
  );
  const short = sourceFixture();
  short.reference.overview.bytes--;
  await assert.rejects(
    createSpatialWellSource({ fetchImpl: short.fetchImpl }).getSnapshot({
      bounds: [0, 0, 0.02, 0.02],
    }),
  );
});

test('a stale fine request cannot commit after a newer viewport; verified partial cache safely replays', async () => {
  const f = sourceFixture(),
    blocked = f.reference.levels[0].chunks[0].url;
  let release, started;
  const ready = new Promise((r) => (started = r));
  const source = createSpatialWellSource({
    fetchImpl: async (url, opts) => {
      if (new URL(url).pathname.endsWith(blocked)) {
        started();
        await new Promise((r) => (release = r));
      }
      return f.fetchImpl(url, opts);
    },
  });
  const old = source.getSnapshot({ bounds: [0, 0, 0.02, 0.02] });
  const rejected = assert.rejects(old);
  await ready;
  const current = await source.getSnapshot({ bounds: [10, 0, 10.02, 0.02] });
  release();
  await rejected;
  assert.equal(current.records[0].id, sample.records[1].id);
});
