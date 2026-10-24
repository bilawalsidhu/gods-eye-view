import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FIX_FLAGS,
  createTrack,
  mergeHistory,
  readFix,
  sampleAt,
} from '../../../src/data/contactPlayback.js';
import {
  HISTORY_PROVENANCES,
  historyPlaybackFixes,
} from '../../../src/data/historyRecords.js';
import { createMemoryHistoryStore } from '../../../src/testSupport/historyMemoryStore.mjs';
import {
  readAllPages,
  runHistoryConformance,
} from '../../../src/testSupport/historyConformance.mjs';
import { HistoryStoreError, openHistoryDayStore } from './dayStore.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const DAY = 86_400_000;

// Day files are created with a WAL switch that syncs to disk; a RAM-backed
// directory, where there is one, keeps hundreds of them fast.
const TEMP_ROOT = existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
function tempDir(t) {
  const dir = mkdtempSync(path.join(TEMP_ROOT, 'gev-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function openStore(t, options = {}) {
  const store = openHistoryDayStore({
    dir: options.dir ?? tempDir(t),
    now: () => NOW,
    ...options,
  });
  t.after(() => store.close());
  return store;
}
const record = (key, t, extra = {}) => ({
  source: 'adsb',
  key,
  t,
  lat: 30,
  lon: -97,
  timeKind: 'vehicle',
  provenance: 'observed',
  ...extra,
});
const all = { source: 'adsb', fromMs: 0, toMs: NOW + DAY };
const codeOf = (work) => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof HistoryStoreError, error.message);
    return error.code;
  }
  return 'none';
};

runHistoryConformance({
  test,
  label: 'day store',
  // Two open days at most, so cases that span days also exercise reopening.
  open: (options, t) => openStore(t, { maxOpenDays: 2, ...options }),
});

/** Deterministic PRNG (mulberry32): a failing seed reproduces exactly. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('the day store matches the reference store after random operations', async (t) => {
  // Keys that stress byte order and quoting; times on a coarse grid across
  // two midnights, so ties, repeats and conflicts are common.
  const KEYS = [
    'a',
    'B',
    'k1',
    '～',
    '\u{1F600}',
    "'; DROP TABLE fixes; --",
    'ñ',
  ];
  const SOURCES = ['adsb', 'ais'];
  let operations = 0,
    returned = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rand = random(seed);
    const pick = (items) => items[Math.floor(rand() * items.length)];
    let clock = Date.parse('2026-10-24T20:00:00Z');
    const now = () => clock;
    const dir = tempDir(t);
    const real = openHistoryDayStore({
      dir,
      now,
      retentionDays: 2,
      maxOpenDays: 2,
    });
    const reference = createMemoryHistoryStore({ now, retentionDays: 2 });
    const time = () =>
      Date.parse('2026-10-23T22:00:00Z') +
      Math.floor(rand() * 40) * 3_600_000 +
      pick([0, 0, 1, 999]);
    const written = [];
    try {
      for (let step = 0; step < 30; step++) {
        const where = `seed ${seed} step ${step}`;
        const roll = rand();
        clock += Math.floor(rand() * 3 * 3_600_000);
        if (roll < 0.45) {
          const records = Array.from(
            { length: 1 + Math.floor(rand() * 30) },
            () => {
              if (written.length && rand() < 0.2) {
                const prior = pick(written);
                return rand() < 0.5 ? prior : { ...prior, lat: prior.lat + 1 };
              }
              const r = {
                source: pick(SOURCES),
                key: pick(KEYS),
                t: time(),
                lat: Math.round((rand() * 180 - 90) * 1e6) / 1e6,
                lon: rand() * 360 - 180,
                heightM: rand() < 0.5 ? rand() * 12000 : null,
                timeKind: pick(['vehicle', 'feed', 'receipt']),
                provenance: pick(HISTORY_PROVENANCES),
                flags: pick([0, 0, 16, 8, 32]),
              };
              if (rand() < 0.05) r.lat = 91;
              written.push(r);
              return r;
            },
          );
          const coverage =
            rand() < 0.5
              ? [
                  (() => {
                    const from = time();
                    return {
                      source: pick(SOURCES),
                      fromMs: from,
                      toMs: from + Math.floor(rand() * 6) * 3_600_000,
                    };
                  })(),
                ]
              : [];
          assert.deepEqual(
            real.write({ records, coverage }),
            reference.write({ records, coverage }),
            where,
          );
          operations += 1;
        } else if (roll < 0.85) {
          const from = time();
          const query = {
            source: pick(SOURCES),
            fromMs: from,
            toMs: from + Math.floor(rand() * 30) * 3_600_000,
            provenance:
              rand() < 0.5
                ? ['observed']
                : HISTORY_PROVENANCES.filter(() => rand() < 0.6),
          };
          if (!query.provenance.length) query.provenance = ['derived'];
          if (rand() < 0.3)
            query.keys = KEYS.filter(() => rand() < 0.4).concat('k1');
          const pageSize = 1 + Math.floor(rand() * 6);
          const pages = await readAllPages(real, query, pageSize);
          assert.deepEqual(
            pages,
            await readAllPages(reference, query, pageSize),
            where,
          );
          returned += pages.length;
          assert.deepEqual(
            real.coverage(query),
            reference.coverage(query),
            where,
          );
          operations += 1;
        } else {
          assert.deepEqual(
            real.prune().droppedDays,
            reference.prune().droppedDays,
            where,
          );
          operations += 1;
        }
      }
    } finally {
      real.close();
    }
  }
  assert.ok(operations >= 1100, `non-vacuous: ${operations} operations`);
  assert.ok(returned >= 1000, `non-vacuous: ${returned} records compared`);
});

test('a recorded ADS-B capture plays back as recorded and holds through a recorder outage', async (t) => {
  // 846 extended squitters over Austin, decoded by dump1090-fa into fixes of
  // six aircraft (src/data/fixtures/README.md), placed at 10:00 UTC today.
  const capture = JSON.parse(
    readFileSync(
      new URL(
        '../../../src/data/fixtures/adsb-austin-capture-timed.json',
        import.meta.url,
      ),
    ),
  );
  const base = Date.parse('2026-10-25T10:00:00Z');
  const records = Object.entries(capture.dump1090).flatMap(([icao, aircraft]) =>
    aircraft.fixes.map(([ms, lat, lon]) =>
      record(icao, base + ms, { lat, lon, receivedAt: base + ms + 250 }),
    ),
  );
  assert.equal(records.length, 235);
  const store = openStore(t);
  // The recorder ran 0–40 s and 60–95 s of the capture; it was down between.
  const outage = [base + 40_000, base + 60_000];
  const result = store.write({
    records,
    coverage: [
      { source: 'adsb', fromMs: base, toMs: outage[0] },
      { source: 'adsb', fromMs: outage[1], toMs: base + 95_000 },
    ],
  });
  assert.equal(result.accepted, records.length);
  const window = { source: 'adsb', fromMs: base, toMs: base + 95_000 };
  const { intervals } = store.coverage(window);
  assert.equal(intervals.length, 2);

  let held = 0,
    interpolated = 0,
    exact = 0;
  for (const icao of Object.keys(capture.dump1090)) {
    const stored = await readAllPages(store, { ...window, keys: [icao] }, 7);
    const ownRecords = records.filter((r) => r.key === icao);
    assert.equal(stored.length, ownRecords.length, icao);
    const play = (coverage) => {
      const track = createTrack();
      mergeHistory(track, historyPlaybackFixes(stored, { coverage }));
      return track;
    };
    const track = play(intervals);
    const continuous = play([{ fromMs: base, toMs: base + 95_000 }]);
    assert.equal(track.count, stored.length);
    for (let i = 0; i < track.count; i++) {
      const fix = readFix(track, i);
      assert.ok(fix.flags & FIX_FLAGS.VEHICLE_TIME);
      assert.ok(!(fix.flags & FIX_FLAGS.LIVE));
    }
    const out = {};
    // At each recorded time playback is exactly the recorded position.
    for (const r of ownRecords) {
      sampleAt(track, r.t, out);
      assert.equal(out.lat, r.lat);
      assert.equal(out.lon, r.lon);
      exact += 1;
    }
    // Between fixes: interpolate inside coverage, hold across the outage.
    for (let i = 1; i < stored.length; i++) {
      const a = stored[i - 1],
        b = stored[i];
      const mid = (a.t + b.t) / 2;
      sampleAt(track, mid, out);
      const spansOutage = a.t < outage[1] && b.t > outage[0];
      if (spansOutage) {
        assert.equal(
          out.motion,
          'unknown',
          `${icao} ${a.t - base}–${b.t - base}`,
        );
        assert.equal(out.lat, a.lat);
        assert.equal(out.lon, a.lon);
        // The control: with the outage covered, the same span interpolates.
        sampleAt(continuous, mid, out);
        assert.notEqual(out.motion, 'unknown');
        held += 1;
      } else {
        assert.notEqual(out.motion, 'unknown', `${icao} ${a.t - base}`);
        assert.ok(Math.abs(out.lat - (a.lat + b.lat) / 2) < 1e-9);
        interpolated += 1;
      }
    }
  }
  assert.ok(held >= 5, `non-vacuous outage: ${held}`);
  assert.ok(interpolated > 150, `non-vacuous interpolation: ${interpolated}`);
  assert.equal(exact, records.length);
});

for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago'])
  test(`one file per UTC day, named by the UTC date in ${zone}`, (t) => {
    // UTC+14 and UTC-11: a local date is a day ahead or behind for most hours.
    const previous = process.env.TZ;
    process.env.TZ = zone;
    t.after(() => {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    });
    const times = [
      Date.parse('2026-10-24T23:00:00Z'),
      Date.parse('2026-10-25T00:00:00Z'),
    ];
    // The zone is in effect: one of the two has a local date that is not its UTC date.
    assert.ok(
      times.some((ms) => new Date(ms).getDate() !== new Date(ms).getUTCDate()),
    );
    const store = openStore(t);
    store.write({ records: times.map((ms) => record('a', ms)) });
    assert.deepEqual(
      readdirSync(store.dir).filter((n) => n.endsWith('.sqlite')),
      ['2026-10-24.sqlite', '2026-10-25.sqlite'],
    );
    assert.deepEqual(
      store.days().map((d) => d.day),
      ['2026-10-24', '2026-10-25'],
    );
  });

test('a query across more days than stay open reads every day', async (t) => {
  const store = openStore(t, { maxOpenDays: 2, retentionDays: 30 });
  const records = Array.from({ length: 9 }, (_, i) =>
    record('a', NOW - i * DAY),
  );
  store.write({ records });
  for (const pageSize of [1, 4, 1000])
    assert.equal((await readAllPages(store, all, pageSize)).length, 9);
});
test('records and coverage survive closing and reopening', (t) => {
  const dir = tempDir(t);
  const first = openHistoryDayStore({ dir, now: () => NOW });
  first.write({
    records: [record('a', NOW - 1000, { heightM: 1234.5 })],
    coverage: [{ source: 'adsb', fromMs: NOW - 2000, toMs: NOW }],
  });
  first.close();
  assert.equal(
    codeOf(() => first.query(all)),
    'closed',
  );
  assert.equal(
    codeOf(() => first.write({})),
    'closed',
  );
  first.close();
  const second = openStore(t, { dir });
  assert.equal(second.query(all).records[0].heightM, 1234.5);
  assert.deepEqual(second.coverage(all).intervals, [
    { fromMs: NOW - 2000, toMs: NOW },
  ]);
});

test('a read-only opener sees committed writes and changes nothing', (t) => {
  const dir = tempDir(t);
  const writer = openStore(t, { dir });
  writer.write({ records: [record('a', NOW - 1000)] });
  const reader = openStore(t, { dir, readOnly: true });
  assert.equal(reader.query(all).records.length, 1);
  writer.write({ records: [record('b', NOW - 1000)] });
  assert.equal(reader.query(all).records.length, 2);
  assert.equal(
    codeOf(() => reader.write({ records: [record('c', NOW)] })),
    'read_only',
  );
  assert.equal(
    codeOf(() => reader.prune()),
    'read_only',
  );
  // A reader of a directory that does not exist creates nothing.
  const missing = path.join(dir, 'missing');
  const empty = openStore(t, { dir: missing, readOnly: true });
  assert.deepEqual(empty.query(all).records, []);
  assert.equal(existsSync(missing), false);
});

test('an unreadable day is reported, skipped and never overwritten', (t) => {
  const dir = tempDir(t);
  const store = openStore(t, { dir });
  store.write({
    records: [record('a', NOW - 2 * DAY), record('a', NOW)],
  });
  const garbage = Buffer.from('not a database, but someone may want it back');
  writeFileSync(path.join(dir, '2026-10-24.sqlite'), garbage);
  // A day database of a future schema is not this store's either.
  const future = new DatabaseSync(path.join(dir, '2026-10-22.sqlite'));
  future.exec(
    "CREATE TABLE meta (name TEXT PRIMARY KEY, value); INSERT INTO meta VALUES ('schema_version', 2)",
  );
  future.close();
  const page = store.query(all);
  assert.deepEqual(
    page.records.map((r) => r.t),
    [NOW - 2 * DAY, NOW],
  );
  assert.deepEqual(page.unreadableDays, ['2026-10-22', '2026-10-24']);
  const result = store.write({
    records: [record('b', NOW - DAY), record('b', NOW - 1)],
    coverage: [
      { source: 'adsb', fromMs: NOW - DAY - 10, toMs: NOW - DAY + 10 },
    ],
  });
  assert.deepEqual(result.rejected, [{ index: 0, reason: 'unreadable_day' }]);
  assert.equal(result.accepted, 1);
  assert.deepEqual(result.coverage.rejected, [
    { index: 0, reason: 'unreadable_day' },
  ]);
  assert.deepEqual(readFileSync(path.join(dir, '2026-10-24.sqlite')), garbage);
  assert.deepEqual(store.coverage(all).unreadableDays, [
    '2026-10-22',
    '2026-10-24',
  ]);
});

test('a day file cut off while being created is created again', (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, '2026-10-25.sqlite'), '');
  const headerOnly = new DatabaseSync(path.join(dir, '2026-10-24.sqlite'));
  headerOnly.exec('PRAGMA journal_mode = WAL');
  headerOnly.close();
  const reader = openStore(t, { dir, readOnly: true });
  assert.deepEqual(reader.query(all), {
    records: [],
    nextCursor: null,
    unreadableDays: [],
  });
  const store = openStore(t, { dir });
  const result = store.write({
    records: [record('a', NOW), record('a', NOW - DAY)],
  });
  assert.equal(result.accepted, 2);
  assert.equal(store.query(all).records.length, 2);
});

test('damage past the header is found as it is read, and the healthy days still answer', (t) => {
  const dir = tempDir(t);
  const seed = openHistoryDayStore({ dir, now: () => NOW });
  seed.write({
    records: [
      record('healthy', NOW - 2 * DAY),
      ...Array.from({ length: 5000 }, (_, i) => record(`k${i}`, NOW - i)),
    ],
  });
  seed.close();
  // Zero the second half: the header and schema pages still read.
  const file = path.join(dir, '2026-10-25.sqlite');
  const bytes = readFileSync(file);
  bytes.fill(0, bytes.length >> 1);
  writeFileSync(file, bytes);
  const reader = openStore(t, { dir, readOnly: true });
  const page = reader.query({ ...all, limit: 10_000 });
  assert.deepEqual(
    page.records.map((r) => r.key),
    ['healthy'],
  );
  assert.deepEqual(page.unreadableDays, ['2026-10-25']);
  assert.deepEqual(reader.coverage(all).unreadableDays, ['2026-10-25']);
  // The writer checks a file it did not create before adding to it.
  const writer = openStore(t, { dir });
  const result = writer.write({ records: [record('new', NOW)] });
  assert.deepEqual(result.rejected, [{ index: 0, reason: 'unreadable_day' }]);
  assert.equal(result.accepted, 0);
  assert.deepEqual(readFileSync(file), bytes);
});

test('a page that ends early still names every unreadable day in the range', (t) => {
  const dir = tempDir(t);
  const store = openStore(t, { dir });
  store.write({
    records: [record('a', NOW - 3 * DAY), record('b', NOW - 3 * DAY + 1)],
  });
  writeFileSync(path.join(dir, '2026-10-24.sqlite'), 'damaged');
  const page = store.query({ ...all, limit: 1 });
  assert.equal(page.records.length, 1);
  assert.ok(page.nextCursor);
  assert.deepEqual(page.unreadableDays, ['2026-10-24']);
});

test('a forged or foreign cursor is refused', (t) => {
  const store = openStore(t);
  store.write({ records: [record('a', NOW - 2), record('b', NOW - 1)] });
  const { nextCursor } = store.query({ ...all, limit: 1 });
  const value = JSON.parse(Buffer.from(nextCursor, 'base64url').toString());
  const forge = (patch) =>
    Buffer.from(JSON.stringify({ ...value, ...patch })).toString('base64url');
  for (const cursor of [
    forge({ v: 2 }),
    forge({ t: -1 }),
    forge({ t: 1.5 }),
    forge({ t: 'x' }),
    forge({ key: 7 }),
    forge({ q: undefined }),
    Buffer.from('[]').toString('base64url'),
    '%%%',
  ])
    assert.equal(
      codeOf(() => store.query({ ...all, limit: 1, cursor })),
      'invalid_cursor',
      cursor,
    );
  assert.equal(
    codeOf(() => store.query({ ...all, limit: 1, cursor: forge({ q: '[]' }) })),
    'cursor_mismatch',
  );
});

test('with one open day, coverage across midnight still lands in both days', (t) => {
  const store = openStore(t, { maxOpenDays: 1 });
  const midnight = Date.parse('2026-10-25T00:00:00Z');
  const result = store.write({
    records: [record('a', midnight - 1000), record('a', midnight + 1000)],
    coverage: [
      {
        source: 'adsb',
        fromMs: midnight - 3_600_000,
        toMs: midnight + 3_600_000,
      },
    ],
  });
  assert.equal(result.accepted, 2);
  assert.equal(result.coverage.accepted, 1);
  assert.deepEqual(store.coverage(all).intervals, [
    { fromMs: midnight - 3_600_000, toMs: midnight + 3_600_000 },
  ]);
  assert.equal(store.query(all).records.length, 2);
});

test('a day file is only read as the day and schema its meta names', (t) => {
  const dir = tempDir(t);
  const store = openStore(t, { dir });
  store.write({ records: [record('a', NOW - 3 * DAY)] });
  store.close();
  const make = (name, sql) => {
    const db = new DatabaseSync(path.join(dir, name));
    db.exec(sql);
    db.close();
  };
  // No version row; version 0; another SQLite database with no meta table.
  make(
    '2026-10-23.sqlite',
    "CREATE TABLE meta (name TEXT PRIMARY KEY, value); INSERT INTO meta VALUES ('day', '2026-10-23')",
  );
  make(
    '2026-10-24.sqlite',
    "CREATE TABLE meta (name TEXT PRIMARY KEY, value); INSERT INTO meta VALUES ('schema_version', 0), ('day', '2026-10-24')",
  );
  make('2026-10-21.sqlite', 'CREATE TABLE other (x)');
  // A real day file renamed to another day.
  writeFileSync(
    path.join(dir, '2026-10-25.sqlite'),
    readFileSync(path.join(dir, '2026-10-22.sqlite')),
  );
  for (const readOnly of [true, false]) {
    const reopened = openStore(t, { dir, readOnly });
    const page = reopened.query(all);
    assert.deepEqual(
      page.records.map((r) => r.t),
      [NOW - 3 * DAY],
    );
    assert.deepEqual(page.unreadableDays, [
      '2026-10-21',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    reopened.close();
  }
});

test('pruning checkpoints the open write-ahead logs before measuring', (t) => {
  const dir = tempDir(t);
  const store = openStore(t, { dir });
  store.write({
    records: Array.from({ length: 2000 }, (_, i) => record(`k${i}`, NOW - i)),
  });
  const wal = path.join(dir, '2026-10-25.sqlite-wal');
  assert.ok(readFileSync(wal).length > 0);
  const { bytes } = store.prune();
  assert.equal(readFileSync(wal).length, 0);
  // The total counts the database and its shared-memory index; the log is empty.
  const size = (suffix) =>
    readFileSync(path.join(dir, `2026-10-25.sqlite${suffix}`)).length;
  assert.equal(bytes, size('') + size('-shm'));
});

test('pruning deletes only day files and never today', (t) => {
  const dir = tempDir(t);
  const store = openStore(t, { dir, retentionDays: 1 });
  store.write({
    records: [
      record('a', NOW - 3 * DAY),
      record('a', NOW - DAY),
      record('a', NOW),
    ],
  });
  const strangers = [
    'notes.txt',
    '2026-13-01.sqlite',
    '2026-02-30.sqlite',
    '2026-10-01.sqlite.bak',
    '26-10-01.sqlite',
  ];
  for (const name of strangers) writeFileSync(path.join(dir, name), name);
  mkdirSync(path.join(dir, '2026-10-02.sqlite'));
  const result = store.prune();
  assert.deepEqual(result.droppedDays, ['2026-10-22', '2026-10-24']);
  const left = readdirSync(dir).sort();
  for (const name of [...strangers, '2026-10-02.sqlite', '2026-10-25.sqlite'])
    assert.ok(left.includes(name), name);
  assert.ok(
    !left.some((n) => n.startsWith('2026-10-22') || n.startsWith('2026-10-24')),
  );
  assert.deepEqual(
    store.query(all).records.map((r) => r.t),
    [NOW],
  );
});

test('the byte cap drops the oldest days first and reports what it cannot drop', (t) => {
  const dir = tempDir(t);
  const store = openStore(t, { dir, retentionDays: 30 });
  for (let day = 4; day >= 0; day--)
    store.write({
      records: Array.from({ length: 2000 }, (_, i) =>
        record(`k${i}`, NOW - day * DAY - i),
      ),
    });
  store.close();
  const sizes = openStore(t, { dir, readOnly: true }).days();
  assert.equal(sizes.length, 5);
  const keep = sizes.at(-1).bytes + sizes.at(-2).bytes;
  const capped = openStore(t, { dir, retentionDays: 30, maxBytes: keep });
  const result = capped.prune();
  assert.deepEqual(result.droppedDays, [
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
  ]);
  assert.equal(result.overBudget, false);
  assert.ok(result.bytes <= keep);
  const tiny = openStore(t, { dir, retentionDays: 30, maxBytes: 1 });
  capped.close();
  const over = tiny.prune();
  assert.deepEqual(over.droppedDays, ['2026-10-24']);
  assert.equal(over.overBudget, true);
  assert.equal(tiny.query({ ...all, limit: 10_000 }).records.length, 2000);
});

test('rows stay compact: under 160 bytes each with both indexes', (t) => {
  const store = openStore(t);
  const n = 20_000;
  store.write({
    records: Array.from({ length: n }, (_, i) =>
      record(
        `a${(i % 500).toString(16).padStart(6, '0')}`,
        NOW - 3_600_000 + i * 100,
        {
          lat: 30 + i / 1e6,
          lon: -97 - i / 1e6,
          heightM: 10_000,
          bearingDeg: 90,
          receivedAt: NOW - 3_600_000 + i * 100 + 300,
        },
      ),
    ),
  });
  store.prune();
  const bytes = store.days().reduce((sum, d) => sum + d.bytes, 0);
  assert.ok(bytes / n < 160, `${(bytes / n).toFixed(1)} B/row`);
});

test('options are checked when the store opens', (t) => {
  const dir = tempDir(t);
  assert.throws(() => openHistoryDayStore({}), TypeError);
  assert.throws(
    () => openHistoryDayStore({ dir, retentionDays: 0 }),
    RangeError,
  );
  assert.throws(
    () => openHistoryDayStore({ dir, retentionDays: 1.5 }),
    RangeError,
  );
  assert.throws(() => openHistoryDayStore({ dir, maxBytes: 0 }), RangeError);
  for (const maxOpenDays of [0, -1, 1.5, NaN])
    assert.throws(() => openHistoryDayStore({ dir, maxOpenDays }), RangeError);
});
