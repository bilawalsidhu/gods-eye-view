import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRainfolkWellSource,
  RAINFOLK_WELL_RELEASE,
  WELL_LIMITS,
  WellIntegrityError,
} from './source.js';
import { publishRelease, publishedRecord } from './release.fixture.mjs';

const TEXAS = [-107, 25, -93, 37];
const AUSTIN = [-98, 30, -97.5, 30.5];
const AUSTIN_EAST = [-97.5, 30, -97, 30.5];
const VIEW = [-97.9, 30.1, -97.6, 30.4];

const austin = (records, extra = {}) =>
  publishRelease(
    [{ name: 'Texas', bounds: TEXAS, tiles: [{ bounds: AUSTIN, records }] }],
    extra,
  );
const sourceFor = (published) =>
  createRainfolkWellSource({
    release: published.release,
    fetchImpl: published.fetchImpl,
  });

test('the pinned release is a SHA-256 and a malformed one is refused', () => {
  assert.match(RAINFOLK_WELL_RELEASE, /^[a-f0-9]{64}$/);
  assert.throws(
    () => createRainfolkWellSource({ release: 'latest' }),
    /Invalid Rainfolk well release/,
  );
});

test('a view loads its records once, slimmed to what the map and card use', async () => {
  const published = await austin(
    [
      publishedRecord(1, { depthFt: 120, capacityGpm: 15, constructed: 1987 }),
      publishedRecord(2, { lon: -97.8, lat: 30.2 }),
      publishedRecord(3, { lon: -97.55, lat: 30.45 }),
    ],
    { indexedRecords: 12452285 },
  );
  const source = sourceFor(published);
  const snapshot = await source.getSnapshot({ bounds: VIEW });
  assert.equal(snapshot.limited, false);
  assert.equal(snapshot.total, 12452285);
  assert.deepEqual(
    snapshot.records.map((r) => r.recordId),
    ['SYN_1', 'SYN_2'],
    'the third record is in the tile but outside the view',
  );
  assert.deepEqual(snapshot.records[0], {
    id: `USGWD-${'a'.repeat(64)}-SYN_1`,
    recordId: 'SYN_1',
    state: 'Texas',
    longitude: -97.74,
    latitude: 30.27,
    depthFt: 120,
    capacityGpm: 15,
    screenDepthFt: null,
    screenLengthFt: null,
    constructedYear: '1987',
    reportedYear: null,
  });
  assert.equal(published.requests.length, 3, 'root, state index, one tile');
  for (const { url, options } of published.requests) {
    assert.ok(url.startsWith('https://data.rainfolk.org/usgwd/'));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, undefined, 'hash-named files may be cached');
  }
  await source.getSnapshot({ bounds: VIEW });
  await source.getSnapshot({ bounds: [-97.8, 30.2, -97.7, 30.3] });
  assert.equal(published.requests.length, 3, 'checked files are not re-read');
});

test('a wide view, no view and a crowded view are limited without loading tiles', async () => {
  const published = await publishRelease([
    {
      name: 'Texas',
      bounds: TEXAS,
      tiles: [
        { bounds: AUSTIN, records: [publishedRecord(1)], count: 500 },
        { bounds: AUSTIN_EAST, records: [], count: 500 },
        { bounds: [-98, 30.5, -97.5, 31], records: [], count: 500 },
        { bounds: [-97.5, 30.5, -97, 31], records: [], count: 500 },
        { bounds: [-98, 29.5, -97.5, 30], records: [], count: 500 },
      ],
    },
  ]);
  const source = sourceFor(published);
  const limited = { records: [], total: 1, limited: true };
  assert.deepEqual(await source.getSnapshot({ bounds: null }), limited);
  assert.deepEqual(
    await source.getSnapshot({ bounds: [-100, 30, -97, 31] }),
    limited,
    `wider than ${WELL_LIMITS.spanDegrees} degrees`,
  );
  assert.equal(published.requests.length, 1, 'only the root index so far');
  assert.deepEqual(
    await source.getSnapshot({ bounds: [-98.2, 29.8, -97.2, 30.8] }),
    limited,
    `more than ${WELL_LIMITS.records} records in view`,
  );
  assert.equal(published.requests.length, 2, 'state index, but no tile');
  const one = await source.getSnapshot({ bounds: VIEW });
  assert.equal(one.limited, false);
  assert.equal(one.records.length, 1);
});

test('a record that cannot be placed is skipped and its neighbours stay', async () => {
  const published = await austin([
    publishedRecord(1),
    { ...publishedRecord(2), latitude: 'north' },
    { ...publishedRecord(3), id: 7 },
    publishedRecord(4, { lon: -90 }),
    { id: 'bare', longitude: -97.7, latitude: 30.3 },
  ]);
  const { records } = await sourceFor(published).getSnapshot({ bounds: VIEW });
  assert.deepEqual(
    records.map((r) => r.id),
    [`USGWD-${'a'.repeat(64)}-SYN_1`, 'bare'],
  );
  assert.equal(records[1].recordId, 'bare');
  assert.equal(records[1].depthFt, null);
});

test('a file that does not match its hash is an integrity failure', async () => {
  const published = await austin([publishedRecord(1)]);
  const path = published.tilePath();
  published.files.set(path, published.files.get(path).replace('SYN_1', 'EVIL'));
  await assert.rejects(
    sourceFor(published).getSnapshot({ bounds: VIEW }),
    WellIntegrityError,
  );
});

test('an index that points outside its own hash-named files is refused', async () => {
  const published = await publishRelease([
    { name: 'Texas', bounds: TEXAS, tiles: [] },
  ]);
  const root = JSON.parse(published.files.get('index.json'));
  root.children[0].url = 'states/Texas/../../other.index.json';
  const body = JSON.stringify(root);
  const { createHash } = await import('node:crypto');
  const release = createHash('sha256').update(body).digest('hex');
  const source = createRainfolkWellSource({
    release,
    fetchImpl: async () => new Response(body),
  });
  await assert.rejects(
    source.getSnapshot({ bounds: VIEW }),
    WellIntegrityError,
  );
});

test('an unreachable file is a plain failure, and a cancelled load stops', async () => {
  const published = await austin([publishedRecord(1)]);
  published.files.delete(published.tilePath());
  await assert.rejects(
    sourceFor(published).getSnapshot({ bounds: VIEW }),
    (error) =>
      !(error instanceof WellIntegrityError) && /HTTP 404/.test(error.message),
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    sourceFor(await austin([publishedRecord(1)])).getSnapshot({
      bounds: VIEW,
      signal: cancelled.signal,
    }),
    { name: 'AbortError' },
  );
});
