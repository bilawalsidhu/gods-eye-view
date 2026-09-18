import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CELESTRAK_SNAPSHOT_GROUPS,
  CELESTRAK_SNAPSHOT_SCHEMA,
  CELESTRAK_SNAPSHOT_URL,
  celestrakSnapshotGroup,
  clearCelestrakSnapshotCache,
  isTleText,
  loadCelestrakSnapshot,
  normalizeCelestrakSnapshot,
  tleTextStats,
} from '../../server/providers/space/celestrak-snapshot.js';
import {
  DEFAULT_SKIP_IF_FRESH_HOURS,
  mergeSnapshot,
  parseRefreshArgs,
  refreshCelestrakSnapshot,
} from '../../scripts/refresh-celestrak-snapshot.mjs';

const tleFor = (satnum, name) =>
  [
    name,
    `1 ${satnum}U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927`,
    `2 ${satnum}  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`,
  ].join('\r\n') + '\r\n';

const PREVIOUS_AT = '2026-09-17T06:00:00.000Z';
const NOW = new Date('2026-09-18T12:00:00.000Z');

function previousSnapshot() {
  return {
    schema: CELESTRAK_SNAPSHOT_SCHEMA,
    fetchedAt: PREVIOUS_AT,
    source: 'fixture',
    groups: {
      stations: {
        fetchedAt: PREVIOUS_AT,
        lines: 3,
        satellites: 1,
        tle: tleFor('25544', 'ISS (ZARYA)'),
      },
      geo: {
        fetchedAt: PREVIOUS_AT,
        lines: 3,
        satellites: 1,
        tle: tleFor('40000', 'OLD GEO'),
      },
    },
  };
}

/** A refresh harness with an in-memory file and a scripted upstream. */
function harness({ previous = previousSnapshot(), upstream, groups }) {
  const files = new Map();
  const url = new URL('file:///snapshot/celestrak-active-snapshot.json');
  if (previous) files.set(String(url), JSON.stringify(previous));
  const calls = [];
  const logs = [];
  const run = (overrides = {}) =>
    refreshCelestrakSnapshot({
      groups,
      url,
      fetchImpl: async (target) => {
        const group = new URL(target).searchParams.get('GROUP');
        calls.push(group);
        return upstream(group);
      },
      readFile: async (target) => {
        if (!files.has(String(target))) throw new Error('ENOENT');
        return files.get(String(target));
      },
      writeFile: async (target, text) => {
        files.set(String(target), text);
      },
      now: () => NOW,
      sleep: async () => {},
      log: (line) => logs.push(line),
      ...overrides,
    });
  return { run, files, url, calls, logs };
}

test('snapshot helpers validate TLE text, count records and normalise a document', () => {
  assert.equal(isTleText('No GP data found'), false);
  assert.equal(isTleText('<html>503</html>'), false);
  assert.equal(isTleText(tleFor('25544', 'ISS')), true);
  assert.deepEqual(tleTextStats(tleFor('25544', 'ISS')), {
    lines: 3,
    satellites: 1,
    bytes: Buffer.byteLength(tleFor('25544', 'ISS')),
  });
  assert.deepEqual(CELESTRAK_SNAPSHOT_GROUPS, [
    'stations',
    'visual',
    'gps-ops',
    'glo-ops',
    'galileo',
    'geo',
    'starlink',
  ]);
  assert.equal(normalizeCelestrakSnapshot(null), null);
  assert.equal(
    normalizeCelestrakSnapshot({ schema: 'other/1', groups: {} }),
    null,
  );
  const normalized = normalizeCelestrakSnapshot({
    ...previousSnapshot(),
    groups: {
      ...previousSnapshot().groups,
      broken: { fetchedAt: PREVIOUS_AT, tle: 'No GP data found' },
      '../escape': { fetchedAt: PREVIOUS_AT, tle: tleFor('1', 'X') },
    },
  });
  assert.deepEqual(Object.keys(normalized.groups), ['stations', 'geo']);
  assert.equal(normalized.groups.stations.fetchedAtMs, Date.parse(PREVIOUS_AT));
  assert.equal(normalized.groups.stations.satellites, 1);
  const entry = celestrakSnapshotGroup(normalized, 'stations');
  assert.equal(entry.fetchedAt, PREVIOUS_AT);
  assert.equal(celestrakSnapshotGroup(normalized, 'starlink'), null);
  // A raw (un-normalised) document is tolerated too.
  assert.equal(
    celestrakSnapshotGroup(previousSnapshot(), 'geo').fetchedAtMs,
    Date.parse(PREVIOUS_AT),
  );
});

test('refresh CLI flags: --dry-run and --skip-if-fresh (hours default to 6 without a value)', () => {
  assert.deepEqual(parseRefreshArgs([]), {
    dryRun: false,
    skipIfFreshHours: null,
  });
  assert.deepEqual(parseRefreshArgs(['--skip-if-fresh', '6']), {
    dryRun: false,
    skipIfFreshHours: 6,
  });
  assert.deepEqual(parseRefreshArgs(['--dry-run', '--skip-if-fresh']), {
    dryRun: true,
    skipIfFreshHours: DEFAULT_SKIP_IF_FRESH_HOURS,
  });
  assert.deepEqual(parseRefreshArgs(['--skip-if-fresh=1.5', '--dry-run']), {
    dryRun: true,
    skipIfFreshHours: 1.5,
  });
  assert.equal(
    parseRefreshArgs(['--skip-if-fresh', 'soon']).skipIfFreshHours,
    6,
  );
});

test('mergeSnapshot keeps a failed group from the previous snapshot and only moves fetchedAt when something refreshed', () => {
  const fresh = tleFor('25544', 'ISS (ZARYA)');
  const { snapshot, summary } = mergeSnapshot({
    previous: previousSnapshot(),
    results: [
      { group: 'stations', ok: true, tle: fresh },
      { group: 'geo', ok: false, error: 'CelesTrak HTTP 503' },
      { group: 'visual', ok: false, error: 'CelesTrak timed out' },
      { group: 'gps-ops', ok: true, tle: 'No GP data found' },
    ],
    now: NOW,
  });
  assert.equal(snapshot.schema, CELESTRAK_SNAPSHOT_SCHEMA);
  assert.equal(snapshot.fetchedAt, NOW.toISOString());
  assert.match(snapshot.source, /^https:\/\/celestrak\.org\//);
  assert.deepEqual(Object.keys(snapshot.groups), ['stations', 'geo']);
  assert.equal(snapshot.groups.stations.fetchedAt, NOW.toISOString());
  assert.equal(snapshot.groups.stations.tle, fresh);
  assert.equal(snapshot.groups.stations.lines, 3);
  assert.equal(
    snapshot.groups.geo.fetchedAt,
    PREVIOUS_AT,
    'failed group keeps its previous entry',
  );
  assert.equal(snapshot.groups.geo.tle, previousSnapshot().groups.geo.tle);
  assert.deepEqual(
    summary.map((row) => [row.group, row.status]),
    [
      ['stations', 'refreshed'],
      ['geo', 'kept-previous'],
      ['visual', 'missing'],
      ['gps-ops', 'missing'],
    ],
  );
  assert.equal(summary[1].detail, 'CelesTrak HTTP 503');

  // Nothing refreshed → the previous document survives untouched, fetchedAt included.
  const unchanged = mergeSnapshot({
    previous: previousSnapshot(),
    results: [{ group: 'stations', ok: false, error: 'CelesTrak HTTP 403' }],
    now: NOW,
  });
  assert.equal(unchanged.snapshot.fetchedAt, PREVIOUS_AT);
  assert.deepEqual(Object.keys(unchanged.snapshot.groups), ['stations', 'geo']);

  // No previous file and every group failed → nothing to write.
  assert.equal(
    mergeSnapshot({
      previous: null,
      results: [{ group: 'stations', ok: false, error: 'x' }],
      now: NOW,
    }).snapshot,
    null,
  );
});

test('refreshCelestrakSnapshot fetches politely, merges on failure, never throws, and honours --dry-run / --skip-if-fresh', async () => {
  const fresh = tleFor('25544', 'ISS (ZARYA)');
  const h = harness({
    groups: ['stations', 'geo', 'visual'],
    upstream: (group) => {
      if (group === 'stations') return new Response(fresh);
      if (group === 'geo')
        return new Response('service unavailable', { status: 503 });
      throw new TypeError('fetch failed');
    },
  });
  const gaps = [];
  const written = await h.run({
    sleep: async (ms) => {
      gaps.push(ms);
    },
  });
  assert.equal(written.status, 'written');
  assert.equal(written.fetchedAt, NOW.toISOString());
  assert.deepEqual(written.groups, {
    stations: {
      status: 'refreshed',
      lines: 3,
      bytes: Buffer.byteLength(fresh),
    },
    geo: {
      status: 'kept-previous',
      lines: 3,
      bytes: Buffer.byteLength(previousSnapshot().groups.geo.tle),
    },
    visual: { status: 'missing', lines: 0, bytes: 0 },
  });
  // Sequential and polite: one 300 ms gap between groups (retry backoff for
  // the failing groups also goes through the injected sleep).
  assert.ok(
    gaps.filter((ms) => ms === 300).length === 2,
    'a gap before the 2nd and 3rd group',
  );
  assert.equal(h.calls[0], 'stations');
  assert.equal(
    h.calls.filter((g) => g === 'geo').length,
    2,
    'one retry for a 503',
  );
  const file = JSON.parse(h.files.get(String(h.url)));
  assert.equal(file.schema, CELESTRAK_SNAPSHOT_SCHEMA);
  assert.deepEqual(Object.keys(file.groups), ['stations', 'geo']);
  assert.equal(file.groups.geo.fetchedAt, PREVIOUS_AT);
  assert.equal(file.groups.stations.tle, fresh);
  // Summary lines only — the TLE body is never printed.
  assert.ok(h.logs.every((line) => !line.includes('1 25544U')));
  assert.ok(h.logs.some((line) => /stations: refreshed · 3 lines/.test(line)));

  // --skip-if-fresh: the file is now 0 h old → no fetch, no write.
  const before = h.calls.length;
  const skipped = await h.run({ skipIfFreshHours: 6 });
  assert.equal(skipped.status, 'skipped');
  assert.equal(h.calls.length, before);
  // Older than the threshold → refreshed again.
  const refreshed = await h.run({
    skipIfFreshHours: 6,
    now: () => new Date(NOW.getTime() + 7 * 3600_000),
  });
  assert.equal(refreshed.status, 'written');
  assert.ok(h.calls.length > before);

  // --dry-run: fetch + report, but the file is left exactly as it was.
  const snapshotBefore = h.files.get(String(h.url));
  const dry = await h.run({ dryRun: true });
  assert.equal(dry.status, 'dry-run');
  assert.equal(dry.groups.stations.status, 'refreshed');
  assert.equal(h.files.get(String(h.url)), snapshotBefore);

  // A broken file system is reported, not thrown (this runs as `prebuild`).
  const failed = await h.run({
    writeFile: async () => {
      throw new Error('EROFS');
    },
  });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /EROFS/);
});

test('refreshCelestrakSnapshot with no previous file and a dead upstream writes nothing and still resolves', async () => {
  const h = harness({
    previous: null,
    groups: ['stations'],
    upstream: () => new Response('nope', { status: 500 }),
  });
  const result = await h.run();
  assert.equal(result.status, 'empty');
  assert.equal(h.files.size, 0);
  assert.equal(result.groups.stations.status, 'missing');
});

test('loadCelestrakSnapshot resolves relative to the module, caches, and returns null for a missing or corrupt file', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-celestrak-'));
  t.after(async () => {
    clearCelestrakSnapshotCache();
    await rm(dir, { recursive: true, force: true });
  });
  assert.match(
    CELESTRAK_SNAPSHOT_URL.pathname,
    /\/data\/celestrak-active-snapshot\.json$/,
  );
  assert.equal(
    CELESTRAK_SNAPSHOT_URL.href,
    new URL('../../data/celestrak-active-snapshot.json', import.meta.url).href,
    'the bundled file is found next to the code (import.meta.url), not under process.cwd()',
  );
  const fixture = pathToFileURL(path.join(dir, 'snapshot.json'));
  await writeFile(fixture, JSON.stringify(previousSnapshot()));
  const loaded = await loadCelestrakSnapshot({ url: fixture });
  assert.equal(loaded.schema, CELESTRAK_SNAPSHOT_SCHEMA);
  assert.equal(loaded.fetchedAt, PREVIOUS_AT);
  assert.deepEqual(Object.keys(loaded.groups), ['stations', 'geo']);
  assert.equal(loaded.groups.stations.fetchedAtMs, Date.parse(PREVIOUS_AT));
  assert.ok(isTleText(loaded.groups.stations.tle));
  // Cached: rewriting the file does not change the answer until forced.
  await writeFile(fixture, 'corrupt {');
  assert.equal(await loadCelestrakSnapshot({ url: fixture }), loaded);
  assert.equal(
    await loadCelestrakSnapshot({ url: fixture, force: true }),
    null,
  );
  assert.equal(
    await loadCelestrakSnapshot({
      url: pathToFileURL(path.join(dir, 'missing.json')),
    }),
    null,
  );
  // An injected reader that throws is a null, never an exception.
  assert.equal(
    await loadCelestrakSnapshot({
      url: 'memory://none',
      readFile: async () => {
        throw new Error('boom');
      },
    }),
    null,
  );
});

test('the bundled snapshot ships every client group as valid TLE text', async (t) => {
  t.after(() => clearCelestrakSnapshotCache());
  const raw = JSON.parse(await readFile(CELESTRAK_SNAPSHOT_URL, 'utf8'));
  assert.equal(raw.schema, CELESTRAK_SNAPSHOT_SCHEMA);
  assert.ok(Number.isFinite(Date.parse(raw.fetchedAt)));
  const snapshot = await loadCelestrakSnapshot({ force: true });
  assert.ok(snapshot, 'the shipped snapshot must load');
  for (const group of CELESTRAK_SNAPSHOT_GROUPS) {
    const entry = celestrakSnapshotGroup(snapshot, group);
    assert.ok(entry, `${group} is missing from the bundled snapshot`);
    assert.ok(entry.satellites > 0, `${group} carries no TLE records`);
    assert.equal(entry.lines, raw.groups[group].lines);
  }
  assert.ok(
    celestrakSnapshotGroup(snapshot, 'starlink').satellites > 1000,
    'DENSE mode needs the Starlink shell',
  );
});
