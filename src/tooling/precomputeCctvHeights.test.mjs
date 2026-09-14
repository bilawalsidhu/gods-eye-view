import assert from 'node:assert/strict';
import test from 'node:test';
import {
  batches,
  cellKey,
  mergeCameraSamples,
  mergeSidecar,
  needsSampling,
  nominalPose,
  parseArgs,
  planCells,
  sampleCell,
  samplingPoints,
  withDeadline,
  plausibleHeight,
} from '../../scripts/precompute-cctv-heights.mjs';
import {
  planeSupportPoints,
  poseHash,
  SUPPORT_KEYS,
} from '../data/cctvFootprint.js';

const pose = {
  lat: 30,
  lon: -95,
  headingDeg: 45,
  pitchDeg: -17,
  fovDeg: 74,
  rangeM: 145,
  mountHeightM: 8,
};
const sampledAt = '2026-09-13T12:00:00.000Z';
const camera = (id, overrides = {}) => ({
  id,
  sourceKind: 'test',
  pose: { ...pose, ...overrides },
});

test('nominal poses are hashed exactly as served, never clamped', () => {
  assert.deepEqual(nominalPose({ id: 'a', ...pose }), pose);
  // The server join and the client hash the same raw served values, so a
  // range outside the client's display clamp still round-trips untouched.
  for (const rangeM of [20, 120, 145, 3000]) {
    const result = nominalPose({ id: 'a', ...pose, rangeM });
    assert.equal(result.rangeM, rangeM);
    assert.equal(poseHash(result), poseHash({ ...pose, rangeM }));
  }
  assert.throws(() => nominalPose({ ...pose, rangeM: null }), /invalid rangeM/);
  assert.throws(() => nominalPose({ ...pose, lat: 91 }), /invalid coordinates/);
  assert.equal(pose.rangeM, 145);
});

test('cells have stable per-row longitude widths and handle boundaries', () => {
  assert.equal(cellKey({ lat: 0.001, lon: 0.001 }), '4500,9000');
  assert.equal(cellKey({ lat: 0.019, lon: 0.001 }), '4500,9000');
  assert.equal(cellKey({ lat: 0.021, lon: 0.001 }).split(',')[0], '4501');
  assert.equal(cellKey({ lat: -0.001, lon: 0.001 }).split(',')[0], '4499');
  const column = (lat, lon) => Number(cellKey({ lat, lon }).split(',')[1]);
  assert.equal(column(0.001, 2) - column(0.001, 0), 100);
  assert.equal(column(60.001, 2) - column(60.001, 0), 50);
  assert.equal(cellKey({ lat: 30, lon: 180 }), cellKey({ lat: 30, lon: -180 }));
  for (const lat of [-90, 90])
    assert.match(cellKey({ lat, lon: 0 }), /^\d+,\d+$/);
  assert.throws(() => cellKey({ lat: NaN, lon: 0 }), /Invalid/);
});

test('plans order cells numerically and preserve camera order within cells', () => {
  const cameras = [
    camera('north', { lat: 50 }),
    camera('east', { lon: -90 }),
    camera('a'),
    camera('b'),
  ];
  const plan = planCells(cameras);
  assert.deepEqual(
    plan.map((cell) => cell.cameras.map((item) => item.id)),
    [['a', 'b'], ['east'], ['north']],
  );
  const sparse = planCells([
    camera('ten', { lat: -89.79 }),
    camera('two', { lat: -89.95 }),
  ]);
  assert.deepEqual(
    sparse.map((cell) => cell.cameras[0].id),
    ['two', 'ten'],
  );
  assert.deepEqual(
    cameras.map((item) => item.id),
    ['north', 'east', 'a', 'b'],
  );
});

test('batches cap 16 cameras at 160 points, including partial and empty batches', () => {
  const items = Array.from({ length: 35 }, (_, i) => i);
  const result = batches(items);
  assert.deepEqual(
    result.map((batch) => batch.length),
    [16, 16, 3],
  );
  assert.deepEqual(result.flat(), items);
  assert.deepEqual(batches([], 4), []);
  for (const size of [0, -1, 1.5, Infinity])
    assert.throws(() => batches(items, size));
});

test('plausibility preserves ellipsoid heights without null or string coercion', () => {
  for (const height of [-150, -10.25, 0, 123.456, 9000])
    assert.equal(plausibleHeight(height), height);
  for (const height of [
    -150.001,
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    '0',
    false,
  ])
    assert.equal(plausibleHeight(height), null);
});

test('resume requires both ok status and the current shared pose hash', () => {
  const entry = { status: 'ok', poseHash: poseHash(pose) };
  assert.equal(needsSampling(entry, pose), false);
  for (const key of Object.keys(pose))
    assert.equal(needsSampling(entry, { ...pose, [key]: pose[key] + 1 }), true);
  for (const prior of [
    undefined,
    {},
    { ...entry, status: 'miss' },
    { poseHash: entry.poseHash },
  ])
    assert.equal(needsSampling(prior, pose), true);
  // A complete-looking entry with missing supports is resampled.
  assert.equal(needsSampling({ ...entry, misses: ['tr'] }, pose), true);
  assert.equal(needsSampling({ ...entry, misses: [] }, pose), false);
});

test('entries preserve support ordering, partial misses and retry successes', () => {
  const first = mergeCameraSamples(
    pose,
    [0, 10, null, 12, 13, 14, 15, 16, 17, -151],
    null,
    1,
    sampledAt,
  );
  assert.equal(first.status, 'ok');
  assert.equal(first.mountGroundM, 0);
  assert.deepEqual(Object.keys(first.supports), SUPPORT_KEYS);
  assert.deepEqual(first.misses, ['bm', 'tr']);
  assert.equal(first.supports.bm, null);
  const retried = mergeCameraSamples(
    pose,
    [undefined, null, 11, null, null, null, null, null, null, 18],
    first,
    2,
    sampledAt,
  );
  assert.deepEqual(
    retried.supports,
    Object.fromEntries(SUPPORT_KEYS.map((key, i) => [key, i + 10])),
  );
  assert.deepEqual(retried.misses, []);
  assert.equal(retried.mountGroundM, 0);
  assert.equal(retried.attempts, 2);
  assert.equal(retried.sampledAt, sampledAt);
  // A partial first pass is 'ok' (the mount landed) but still resamples so
  // the missing supports get another chance.
  assert.equal(needsSampling(first, pose), first.misses.length > 0);
});

test('a missing mount stores no heights and stale poses cannot supply retry heights', () => {
  const missing = mergeCameraSamples(
    pose,
    [-151, ...Array(9).fill(10)],
    null,
    3,
    sampledAt,
  );
  assert.equal(missing.status, 'miss');
  assert.deepEqual(missing.misses, ['mount']);
  assert.equal(Object.hasOwn(missing, 'mountGroundM'), false);
  assert.equal(Object.hasOwn(missing, 'supports'), false);
  const previous = mergeCameraSamples(
    { ...pose, rangeM: 200 },
    Array(10).fill(99),
    null,
    1,
    sampledAt,
  );
  const entry = mergeCameraSamples(pose, [], previous, 2, sampledAt);
  assert.equal(entry.status, 'miss');
  assert.deepEqual(entry.misses, ['mount', ...SUPPORT_KEYS]);
});

test('sidecar merging sorts ids, preserves unselected entries and replaces stale heights', () => {
  const old = {
    cameras: { z: { status: 'ok' }, a: { status: 'ok', mountGroundM: 20 } },
  };
  const result = mergeSidecar(
    old,
    { b: { status: 'ok' }, a: { status: 'miss' } },
    sampledAt,
  );
  assert.deepEqual(Object.keys(result.cameras), ['a', 'b', 'z']);
  assert.deepEqual(result.cameras.a, { status: 'miss' });
  assert.equal(old.cameras.a.mountGroundM, 20);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.provider, 'google-photorealistic-3d');
  assert.equal(result.heightReference, 'WGS84-ellipsoid');
  assert.equal(result.generatedAt, sampledAt);
  assert.deepEqual(mergeSidecar(null, {}, sampledAt).cameras, {});
});

test('CLI supports combined pilot filters and rejects malformed flags', () => {
  assert.deepEqual(
    parseArgs(['--kinds', 'a, b', '--limit', '40', '--dry-run']),
    { limit: 40, kinds: ['a', 'b'], dryRun: true },
  );
  assert.equal(parseArgs(['--limit', '0']).limit, 0);
  assert.equal(parseArgs([]).limit, Infinity);
  for (const args of [
    ['--limit'],
    ['--limit', '-1'],
    ['--limit', '1.5'],
    ['--limit', '1e3'],
    ['--kinds'],
    ['--kinds', 'a,'],
    ['--kinds', '--dry-run'],
    ['--unknown'],
  ])
    assert.throws(() => parseArgs(args));
});

test('sampling uses the shared footprint directly and rejects invalid geometry', () => {
  const footprint = planeSupportPoints(pose);
  const expected = [
    footprint.mount,
    ...SUPPORT_KEYS.map((key) => footprint.supports[key]),
  ].map(({ lat, lon }) => ({ lat, lon }));
  assert.deepEqual(samplingPoints(pose), expected);
  assert.equal(expected.length, 10);
  assert.ok(
    expected.every(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
    ),
  );
  assert.throws(
    () => samplingPoints({ ...pose, lat: NaN }),
    /invalid coordinates/,
  );
});

test('failed calls recycle before serial retries in batches of 4, then singly', async () => {
  const cameras = Array.from({ length: 16 }, (_, i) => camera(String(i)));
  const sizes = [];
  const seen = new Map();
  let active = 0;
  let needsRecycle = false;
  let recycled = 0;
  const result = await sampleCell(
    cameras,
    {
      async sample(batch) {
        assert.equal(active, 0);
        assert.equal(needsRecycle, false);
        active += 1;
        sizes.push(batch.length);
        await Promise.resolve();
        active -= 1;
        for (const item of batch)
          seen.set(item.id, (seen.get(item.id) || 0) + 1);
        if (sizes.length === 1) {
          needsRecycle = true;
          throw new Error('timeout');
        }
        return batch.map((item) =>
          seen.get(item.id) === 2 ? [] : Array(10).fill(25),
        );
      },
      async recycle() {
        assert.equal(active, 0);
        needsRecycle = false;
        recycled += 1;
      },
    },
    () => sampledAt,
  );
  assert.deepEqual(sizes, [16, 4, 4, 4, 4, ...Array(16).fill(1)]);
  assert.equal(recycled, 1);
  for (const entry of Object.values(result)) {
    assert.equal(entry.status, 'ok');
    assert.equal(entry.attempts, 3);
  }
});

test('only failed cameras retry; partial successes survive and mount misses stop after three attempts', async () => {
  const calls = [];
  const result = await sampleCell(
    [camera('ok'), camera('partial'), camera('miss')],
    {
      async sample(batch) {
        calls.push(batch.map((item) => item.id));
        return batch.map((item) => {
          if (item.id === 'miss') return [];
          if (item.id === 'partial')
            return calls.length === 1
              ? [10, ...Array(8).fill(11), null]
              : [null, ...Array(8).fill(null), 12];
          return Array(10).fill(10);
        });
      },
      async recycle() {
        assert.fail('No call failed');
      },
    },
    () => sampledAt,
  );
  assert.deepEqual(calls, [
    ['ok', 'partial', 'miss'],
    ['partial', 'miss'],
    ['miss'],
  ]);
  assert.equal(result.ok.attempts, 1);
  assert.equal(result.partial.attempts, 2);
  assert.deepEqual(result.partial.misses, []);
  assert.equal(result.partial.supports.tr, 12);
  assert.equal(result.miss.status, 'miss');
  assert.equal(result.miss.attempts, 3);
});

test('deadline rejects hung calls and passes successful or rejected operations through', async () => {
  assert.equal(await withDeadline(Promise.resolve(42)), 42);
  await assert.rejects(
    withDeadline(Promise.reject(new Error('provider failed'))),
    /provider failed/,
  );
  await assert.rejects(withDeadline(new Promise(() => {}), 5), /timed out/);
});

test('a resumed camera keeps its valid heights when the retry only fails', async () => {
  const prior = mergeCameraSamples(
    pose,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    undefined,
    1,
    't0',
  );
  const partial = {
    ...prior,
    supports: { ...prior.supports, tr: null },
    misses: ['tr'],
  };
  const sampler = {
    sample: async (batch) => batch.map(() => Array(10).fill(undefined)),
    recycle: async () => {},
  };
  const entries = await sampleCell([{ id: 'cam', pose }], sampler, () => 't1', {
    cam: partial,
  });
  assert.equal(entries.cam.status, 'ok');
  assert.equal(entries.cam.mountGroundM, 1);
  assert.equal(entries.cam.supports.bl, 2);
  assert.deepEqual(entries.cam.misses, ['tr']);
});
