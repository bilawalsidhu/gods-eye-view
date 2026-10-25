import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FIX_FLAGS,
  createTrack,
  mergeHistory,
  advance,
  readFix,
  sampleAt,
  seek,
  setRate,
} from '../../../src/data/contactPlayback.js';
import {
  HISTORY_PROVENANCES,
  HISTORY_REPLAY_POLICY,
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
  // Each fix reaches the recorder 20 to 35 s after its own time, as through
  // an aggregator; the jitter is fixed so a failure reproduces.
  const latency = (ms) => 20_000 + ((ms * 7919) % 15_000);
  const heard = Object.entries(capture.dump1090).flatMap(([icao, aircraft]) =>
    aircraft.fixes.map(([ms, lat, lon]) =>
      record(icao, base + ms, {
        lat,
        lon,
        receivedAt: base + ms + latency(ms),
      }),
    ),
  );
  assert.equal(heard.length, 235);
  // The recorder was down from 40 to 60 s on its own clock: fixes that
  // arrived then were never recorded, whatever their own time.
  const outage = [base + 40_000, base + 60_000];
  const records = heard.filter(
    (r) => r.receivedAt < outage[0] || r.receivedAt > outage[1],
  );
  const lost = heard.length - records.length;
  assert.ok(lost >= 20, `non-vacuous outage: ${lost} fixes lost`);
  const store = openStore(t);
  const end = base + 140_000;
  const result = store.write({
    records,
    coverage: [
      { source: 'adsb', fromMs: base, toMs: outage[0] },
      { source: 'adsb', fromMs: outage[1], toMs: end },
    ],
  });
  assert.equal(result.accepted, records.length);
  const window = { source: 'adsb', fromMs: base, toMs: end };
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
    const continuous = play([{ fromMs: base, toMs: end }]);
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
      // On the recorder's clock: was it down between hearing a and b?
      const spansOutage =
        Math.min(a.receivedAt, b.receivedAt) < outage[1] &&
        Math.max(a.receivedAt, b.receivedAt) > outage[0];
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
  assert.ok(interpolated > 120, `non-vacuous interpolation: ${interpolated}`);
  assert.equal(exact, records.length);
});

test('a stored track replays on the playback clock: seek, 4x, hold through the outage, pause', async (t) => {
  // One aircraft north at 100 m/s, a fix every 10 s, heard 25 s late; the
  // recorder was down from 120 to 150 s on its clock, so the fixes timed
  // 100, 110 and 120 s were never recorded.
  const base = Date.parse('2026-10-25T10:00:00Z');
  const fixes = [];
  for (let dt = 0; dt <= 300_000; dt += 10_000) {
    const receivedAt = base + dt + 25_000;
    if (receivedAt > base + 120_000 && receivedAt < base + 150_000) continue;
    fixes.push(
      record('a1b2c3', base + dt, {
        lat: 30 + (dt / 1000) * (100 / 111_320),
        receivedAt,
      }),
    );
  }
  const store = openStore(t);
  store.write({
    records: fixes,
    coverage: [
      { source: 'adsb', fromMs: base, toMs: base + 120_000 },
      { source: 'adsb', fromMs: base + 150_000, toMs: base + 400_000 },
    ],
  });
  const window = { source: 'adsb', fromMs: base, toMs: base + 400_000 };
  const stored = await readAllPages(store, window, 9);
  const play = (policy) => {
    const track = createTrack({ policy });
    mergeHistory(
      track,
      historyPlaybackFixes(stored, {
        coverage: store.coverage(window).intervals,
      }),
    );
    return track;
  };
  const track = play(HISTORY_REPLAY_POLICY);
  const newest = stored.at(-1).t;
  const wall = base + DAY; // replayed a day later
  const clocks = (mono) => ({ wallNowMs: wall + mono, monoNowMs: mono });
  // The live policy calls every recorded motion stale: its newest report
  // is a day behind the wall clock.
  const live = play({});
  seek(live, base + 5000, clocks(0));
  setRate(live, 1, clocks(0));
  assert.equal(advance(live, clocks(16), {}).motion, 'stale');
  seek(track, base, clocks(0));
  setRate(track, 4, clocks(0));
  const out = {};
  let previous = base,
    moving = 0,
    held = 0;
  for (let mono = 16; mono < 120_000; mono += 16) {
    advance(track, clocks(mono), out);
    // Report time moves at exactly 4x the monotonic clock, up to the newest fix.
    assert.ok(
      Math.abs(out.displayT - Math.min(newest, previous + 64)) < 1e-6,
      `${mono}: ${out.displayT - base}`,
    );
    previous = out.displayT;
    const next = stored.findIndex((r) => r.t > out.displayT);
    if (next <= 0) continue;
    const a = stored[next - 1],
      b = stored[next];
    if (a.t === 90_000 + base) {
      // 90 s to 130 s spans the outage: hold the last recorded position.
      assert.equal(out.motion, 'unknown');
      assert.equal(out.lat, a.lat);
      held += 1;
    } else {
      const f = (out.displayT - a.t) / (b.t - a.t);
      assert.equal(out.motion, 'moving');
      assert.ok(Math.abs(out.lat - (a.lat + (b.lat - a.lat) * f)) < 1e-9);
      assert.ok(Math.abs(out.segmentSpeedMps - 100) < 0.5);
      moving += 1;
    }
  }
  assert.ok(held > 500 && moving > 3000, `held ${held}, moving ${moving}`);
  assert.equal(out.displayT, newest);
  assert.equal(out.phase, 'held');
  // Pause holds report time; a seek back replays the same positions.
  setRate(track, 0, clocks(120_000));
  advance(track, clocks(121_000), out);
  assert.equal(out.phase, 'paused');
  assert.equal(out.displayT, newest);
  seek(track, base + 45_000, clocks(122_000));
  advance(track, clocks(122_000), out);
  assert.ok(Math.abs(out.lat - (30 + 45 * (100 / 111_320))) < 1e-9);
});

test('a track longer than playback holds is replayed through windows of the store', async (t) => {
  // contactPlayback retains 128 fixes per track: mergeHistory keeps the
  // newest 128 of what it is given, without marking the track truncated, so
  // a replay reads the window around its clock from the store instead.
  const base = Date.parse('2026-10-25T08:00:00Z');
  const fixes = Array.from({ length: 300 }, (_, i) =>
    record('long', base + i * 10_000, {
      lat: 30 + i / 1e4,
      receivedAt: base + i * 10_000,
    }),
  );
  const store = openStore(t);
  store.write({
    records: fixes,
    coverage: [{ source: 'adsb', fromMs: base, toMs: base + 3_600_000 }],
  });
  const all = await readAllPages(
    store,
    { source: 'adsb', fromMs: base, toMs: base + 3_600_000 },
    100,
  );
  const coverage = store.coverage({
    source: 'adsb',
    fromMs: base,
    toMs: base + 3_600_000,
  }).intervals;
  const whole = createTrack();
  mergeHistory(whole, historyPlaybackFixes(all, { coverage }));
  assert.equal(whole.count, 128);
  assert.equal(readFix(whole, 0).t, fixes[172].t);
  // A window of 100 fixes around the 50th keeps every one of them.
  const from = fixes[0].t,
    to = fixes[99].t;
  const window = await readAllPages(
    store,
    { source: 'adsb', fromMs: from, toMs: to },
    100,
  );
  const track = createTrack();
  mergeHistory(track, historyPlaybackFixes(window, { coverage }));
  assert.equal(track.count, 100);
  const out = {};
  sampleAt(track, fixes[50].t + 5000, out);
  assert.equal(out.motion, 'moving');
  assert.ok(Math.abs(out.lat - (fixes[50].lat + fixes[51].lat) / 2) < 1e-9);
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

const STORE_URL = new URL('./dayStore.js', import.meta.url).href;
/** Run a module in a child Node process with `env`; resolves on exit. */
function child(source, env = {}) {
  const proc = spawn(
    process.execPath,
    ['--no-warnings', '--input-type=module', '-e', source],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => (stdout += chunk));
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) =>
    proc.on('close', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    ),
  );
  return { proc, exited, stdout: () => stdout };
}

test('one writer per directory: a second is refused, readers are not, and a dead writer frees it', async (t) => {
  const dir = tempDir(t);
  const writer = openStore(t, { dir });
  writer.write({ records: [record('a', NOW - 1000)] });
  assert.equal(
    codeOf(() => openHistoryDayStore({ dir, now: () => NOW })),
    'locked',
  );
  // Another process is refused too, and may still read.
  const other = await child(
    `import { openHistoryDayStore } from ${JSON.stringify(STORE_URL)};
     const dir = process.env.DIR, now = () => Number(process.env.NOW);
     try { openHistoryDayStore({ dir, now }); console.log('opened'); }
     catch (error) { console.log(error.code); }
     const reader = openHistoryDayStore({ dir, now, readOnly: true });
     console.log(reader.query({ source: 'adsb', fromMs: 0, toMs: now() }).records.length);`,
    { DIR: dir, NOW: String(NOW) },
  ).exited;
  assert.equal(other.stdout, 'locked\n1\n', other.stderr);
  writer.close();
  // A writer killed without closing leaves no lock behind.
  const killed = await child(
    `import { writeSync } from 'node:fs';
     import { openHistoryDayStore } from ${JSON.stringify(STORE_URL)};
     openHistoryDayStore({ dir: process.env.DIR });
     writeSync(1, 'held\\n');
     process.kill(process.pid, 'SIGKILL');`,
    { DIR: dir },
  ).exited;
  assert.equal(killed.stdout, 'held\n', killed.stderr);
  // Windows reports a forced exit as an exit code, not a signal.
  if (process.platform !== 'win32') assert.equal(killed.signal, 'SIGKILL');
  const next = openStore(t, { dir });
  assert.equal(next.query(all).records.length, 1);
});

test('a writer killed while writing loses no committed batch and leaves none half written', async (t) => {
  const dir = tempDir(t);
  const size = 200;
  // Each batch is one day's transaction: `size` records keyed by batch.
  // The child reports a batch on stdout once `write` has returned.
  const writer = child(
    `import { writeSync } from 'node:fs';
     import { openHistoryDayStore } from ${JSON.stringify(STORE_URL)};
     const now = Number(process.env.NOW);
     const store = openHistoryDayStore({ dir: process.env.DIR, now: () => now });
     for (let batch = 0; ; batch++) {
       const records = Array.from({ length: ${size} }, (_, i) => ({
         source: 'adsb', key: 'b' + batch + '-' + i, t: now - 3_600_000 + batch,
         lat: 30, lon: -97, timeKind: 'vehicle', provenance: 'observed',
       }));
       store.write({ records });
       writeSync(1, batch + '\\n');
     }`,
    { DIR: dir, NOW: String(NOW) },
  );
  const batchesOf = (records) => {
    const counts = new Map();
    for (const { key } of records) {
      const batch = Number(key.slice(1, key.indexOf('-')));
      counts.set(batch, (counts.get(batch) ?? 0) + 1);
    }
    return counts;
  };
  const reported = () => writer.stdout().split('\n').filter(Boolean).length;
  while (reported() < 20) await new Promise((r) => setTimeout(r, 5));
  // A reader in this process sees whole batches while the writer runs.
  const reader = openStore(t, { dir, readOnly: true });
  const seen = batchesOf(await readAllPages(reader, all, 10_000));
  assert.ok(seen.size >= 20);
  for (const count of seen.values()) assert.equal(count, size);
  reader.close();
  writer.proc.kill('SIGKILL');
  const { signal, stdout } = await writer.exited;
  if (process.platform !== 'win32') assert.equal(signal, 'SIGKILL');
  const committed = stdout.split('\n').filter(Boolean).map(Number);
  const store = openStore(t, { dir });
  const { unreadableDays } = store.query(all);
  assert.deepEqual(unreadableDays, []);
  const counts = batchesOf(await readAllPages(store, all, 10_000));
  // Every reported batch is there, whole; at most the one in flight follows.
  for (const batch of committed) assert.equal(counts.get(batch), size);
  assert.ok(counts.size - committed.length <= 1);
  for (const [batch, count] of counts) {
    assert.equal(count, size, `batch ${batch}`);
    assert.ok(batch <= committed.length);
  }
  const file = new DatabaseSync(path.join(dir, '2026-10-25.sqlite'));
  t.after(() => file.close());
  assert.equal(
    file.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
});

test('a failed write rolls back its day, keeps the days before it, and may be resent', (t) => {
  const dir = tempDir(t);
  const store = openStore(t, { dir });
  store.write({ records: [record('x', NOW - 60_000)] });
  // A trigger stands in for a storage error in the middle of a day's batch.
  const file = new DatabaseSync(path.join(dir, '2026-10-25.sqlite'));
  t.after(() => file.close());
  file.exec(`CREATE TRIGGER fail BEFORE INSERT ON fixes WHEN NEW.key = 'boom'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  const batch = [
    record('a', NOW - DAY),
    record('c', NOW - 30_000),
    record('boom', NOW - 20_000),
    record('d', NOW - 10_000),
  ];
  assert.throws(() => store.write({ records: batch }), /injected failure/);
  const keys = () => store.query(all).records.map((r) => r.key);
  // Yesterday committed; today's batch, `c` included, did not.
  assert.deepEqual(keys(), ['a', 'x']);
  file.exec('DROP TRIGGER fail');
  const resent = store.write({ records: batch });
  assert.deepEqual(
    [resent.accepted, resent.repeats, resent.rejected],
    [3, 1, []],
  );
  assert.deepEqual(keys(), ['a', 'x', 'c', 'boom', 'd']);
  assert.deepEqual(store.query(all).unreadableDays, []);
  // A day file that cannot be opened is an error, not an unreadable day.
  if (process.platform !== 'linux') return;
  store.close();
  const tomorrow = { now: () => NOW + DAY };
  const before = openHistoryDayStore({ dir, ...tomorrow });
  before.write({ records: [record('f0', NOW + DAY - 1000)] });
  before.close();
  symlinkSync('/dev/full', path.join(dir, '2026-10-26.sqlite-wal'));
  const later = openStore(t, { dir, ...tomorrow });
  const next = [record('e', NOW - 5000), record('f', NOW + DAY)];
  assert.throws(() => later.write({ records: next }), /unable to open/);
  rmSync(path.join(dir, '2026-10-26.sqlite-wal'));
  const retry = later.write({ records: next });
  assert.deepEqual([retry.accepted, retry.repeats], [1, 1]);
  assert.deepEqual(
    later.query({ ...all, toMs: NOW + 2 * DAY }).unreadableDays,
    [],
  );
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

test('a day file of schema version 1, as first written, stays readable and writable', (t) => {
  const dir = tempDir(t);
  const v1 = new DatabaseSync(path.join(dir, '2026-10-24.sqlite'));
  v1.exec(
    readFileSync(
      new URL('../../../src/data/fixtures/history-day-v1.sql', import.meta.url),
      'utf8',
    ),
  );
  v1.close();
  const D = Date.parse('2026-10-24T00:00:00Z');
  const fix = (key, s, lat, extra = {}) => ({
    source: 'adsb',
    key,
    t: D + s * 1000,
    lat,
    lon: -97.7,
    heightM: NaN,
    bearingDeg: NaN,
    receivedAt: NaN,
    timeKind: 'vehicle',
    provenance: 'observed',
    flags: 0,
    ...extra,
  });
  const expected = [
    fix('a1b2c3', 10, 30.009765625, {
      heightM: 1234.5,
      bearingDeg: 271.25,
      receivedAt: D + 10_400,
    }),
    fix('ñu', 15, 30.0146484375, { timeKind: 'feed' }),
    fix('～', 15, -0.5, { lon: 179.999, provenance: 'simulated' }),
    fix('\u{1F600}', 15, 30.0146484375, {
      timeKind: 'receipt',
      provenance: 'derived',
    }),
    fix('a1b2c3', 20, 30.01953125, {
      heightM: 1240,
      bearingDeg: 270,
      receivedAt: D + 20_350,
      flags: FIX_FLAGS.FLOOR,
    }),
    fix('a1b2c3', 90, 30.087890625, {
      receivedAt: D + 90_300,
      flags: FIX_FLAGS.BREAK,
    }),
  ];
  const day = {
    source: 'adsb',
    fromMs: D,
    toMs: D + DAY - 1,
    provenance: [...HISTORY_PROVENANCES],
  };
  const reader = openStore(t, { dir, readOnly: true });
  assert.deepEqual(reader.query(day), {
    records: expected,
    nextCursor: null,
    unreadableDays: [],
  });
  assert.deepEqual(reader.coverage(day).intervals, [
    { fromMs: D, toMs: D + 30_000 },
    { fromMs: D + 60_000, toMs: D + 120_000 },
  ]);
  reader.close();
  const writer = openStore(t, { dir });
  const { heightM, bearingDeg, receivedAt, ...stored } = expected[3];
  const result = writer.write({
    records: [stored, record('new', D + 100_000)],
  });
  assert.deepEqual([result.accepted, result.repeats], [1, 1]);
  writer.write({ records: [record('today', NOW)] });
  // While the schema is version 1, a new day file has exactly its tables.
  const schema = (name) => {
    const db = new DatabaseSync(path.join(dir, name), { readOnly: true });
    try {
      return db
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name',
        )
        .all();
    } finally {
      db.close();
    }
  };
  assert.deepEqual(schema('2026-10-25.sqlite'), schema('2026-10-24.sqlite'));
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
  capped.close();
  const tiny = openStore(t, { dir, retentionDays: 30, maxBytes: 1 });
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
