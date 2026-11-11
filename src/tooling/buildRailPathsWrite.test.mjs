// How the path build writes a feed's packs: the path and schedule packs as
// a pair, never one without the other it indexes; nothing over the size the
// server serves; no collapse in trips without --force; one build per folder
// at a time; and a command line that never starts a build of every feed by
// itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_LOCK,
  FEED_FAILED_EXIT_CODE,
  MIN_TRIP_SHARE,
  acquireDirLock,
  buildExitCode,
  isInside,
  operatorShapeTrips,
  parseBuildArgs,
  scheduleTripsPerDay,
  tripFloorProblem,
  writeFeedPacks,
} from '../../scripts/build-rail-paths.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-rail-write-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A path pack with `trips` trips on one operator shape. */
function pathPack(builtAt, trips, { shapes = 1, source = 'operator' } = {}) {
  return {
    version: 1,
    feedId: 'f',
    builtAt,
    source: { url: 'https://example.test/gtfs.zip' },
    shapes: Array.from({ length: shapes }, () => [0, 0, 0.001, 0.001]),
    dist: Array.from({ length: shapes }, () => [0, 157]),
    shapeSources: Array.from({ length: shapes }, () => source),
    trips: Object.fromEntries(
      Array.from({ length: trips }, (_, i) => [`t${i}`, 0]),
    ),
    routes: { R: [0] },
  };
}

/** A schedule pack with `trips` trips over `days` service days. */
function schedulePack(pathsBuiltAt, trips, days = 4) {
  const from = '2026-11-09';
  const to = new Date(Date.parse(from) + (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    version: 1,
    feedId: 'f',
    builtAt: pathsBuiltAt,
    pathsBuiltAt,
    window: { from, to },
    trips: Object.fromEntries(
      Array.from({ length: trips }, (_, i) => [`t${i}`, { pattern: 0 }]),
    ),
  };
}

const read = async (dir, name) =>
  JSON.parse(await readFile(path.join(dir, name), 'utf8'));
const tempFiles = async (dir) =>
  (await readdir(dir)).filter((name) => name.endsWith('.tmp'));

async function seed(dir, { trips = 10, scheduleTrips = 100 } = {}) {
  await writeFile(
    path.join(dir, 'f.json'),
    JSON.stringify(pathPack('old', trips)),
  );
  await writeFile(
    path.join(dir, 'f.schedule.json'),
    JSON.stringify(schedulePack('old', scheduleTrips)),
  );
}

test('both packs are written as a pair, through temporary names of their own', async (t) => {
  const dir = await tempDir(t);
  await seed(dir);
  const written = await writeFeedPacks(dir, 'f', {
    pack: pathPack('new', 10),
    schedule: schedulePack('new', 100),
  });
  assert.equal(written.removedSchedule, false);
  assert.equal((await read(dir, 'f.json')).builtAt, 'new');
  assert.equal((await read(dir, 'f.schedule.json')).pathsBuiltAt, 'new');
  assert.equal(JSON.parse(written.scheduleText).pathsBuiltAt, 'new');
  assert.deepEqual(await tempFiles(dir), []);
});

test('a schedule that cannot be written leaves the previous path pack in place', async (t) => {
  const dir = await tempDir(t);
  await seed(dir);
  const broken = schedulePack('new', 100);
  broken.trips.t0.startSec = 1n; // JSON cannot hold it.
  await assert.rejects(
    writeFeedPacks(dir, 'f', { pack: pathPack('new', 10), schedule: broken }),
    /BigInt/,
  );
  assert.equal((await read(dir, 'f.json')).builtAt, 'old');
  assert.equal((await read(dir, 'f.schedule.json')).pathsBuiltAt, 'old');
  assert.deepEqual(await tempFiles(dir), []);
});

test('without a schedule the previous one, which indexes the old shapes, is removed', async (t) => {
  const dir = await tempDir(t);
  await seed(dir);
  const written = await writeFeedPacks(dir, 'f', { pack: pathPack('new', 10) });
  assert.equal(written.removedSchedule, true);
  assert.equal(written.scheduleText, null);
  assert.equal((await read(dir, 'f.json')).builtAt, 'new');
  assert.deepEqual((await readdir(dir)).sort(), ['f.json']);
  // Nothing to remove the next time.
  const again = await writeFeedPacks(dir, 'f', { pack: pathPack('newer', 10) });
  assert.equal(again.removedSchedule, false);
});

test('a pack over the size the server serves is not written, and says what thins it', async (t) => {
  const dir = await tempDir(t);
  await seed(dir);
  const pack = pathPack('new', 10);
  const maxBytes = Buffer.byteLength(JSON.stringify(pack)) - 1;
  await assert.rejects(
    writeFeedPacks(dir, 'f', { pack, maxBytes }),
    (error) =>
      /over the .* the server serves/.test(error.message) &&
      /its shapes hold 2 points/.test(error.message) &&
      /staticSimplifyM/.test(error.message),
  );
  const schedule = schedulePack('new', 100);
  await assert.rejects(
    writeFeedPacks(dir, 'f', {
      pack: pathPack('new', 10, { shapes: 0 }),
      schedule,
      maxBytes: Buffer.byteLength(JSON.stringify(schedule)) - 1,
    }),
    /schedule is .* --days/,
  );
  assert.equal((await read(dir, 'f.json')).builtAt, 'old');
  assert.equal((await read(dir, 'f.schedule.json')).pathsBuiltAt, 'old');
});

test('a collapse in trips keeps the previous packs unless --force', async (t) => {
  const dir = await tempDir(t);
  await seed(dir, { trips: 10, scheduleTrips: 100 });
  // The classifier kept nothing.
  await assert.rejects(
    writeFeedPacks(dir, 'f', {
      pack: pathPack('new', 0),
      schedule: schedulePack('new', 0),
    }),
    (error) =>
      /trips on operator shapes 0 against 10/.test(error.message) &&
      /schedule trips per day 0 against 25/.test(error.message) &&
      /--force/.test(error.message),
  );
  // The calendar went missing: the shapes are fine, the timetable is not.
  await assert.rejects(
    writeFeedPacks(dir, 'f', {
      pack: pathPack('new', 10),
      schedule: schedulePack('new', 4),
    }),
    /schedule trips per day 1 against 25/,
  );
  assert.equal((await read(dir, 'f.json')).builtAt, 'old');
  assert.equal((await read(dir, 'f.schedule.json')).pathsBuiltAt, 'old');
  // A shorter window is not a collapse: trips are compared per day.
  await writeFeedPacks(dir, 'f', {
    pack: pathPack('short', 10),
    schedule: schedulePack('short', 30, 1),
  });
  assert.equal((await read(dir, 'f.json')).builtAt, 'short');
  // --force writes what the floor refused.
  await writeFeedPacks(dir, 'f', {
    pack: pathPack('forced', 0),
    schedule: schedulePack('forced', 0),
    force: true,
  });
  assert.equal((await read(dir, 'f.json')).builtAt, 'forced');
  // A first build has nothing to fall from.
  const fresh = await tempDir(t);
  await writeFeedPacks(fresh, 'f', {
    pack: pathPack('first', 0),
    schedule: schedulePack('first', 0),
  });
  assert.equal((await read(fresh, 'f.json')).builtAt, 'first');
});

test('the trip floor counts what the build makes alike each time', () => {
  // Only the operator's shapes count: a shape of any other source does not.

  const pack = pathPack('x', 0, { shapes: 2 });
  pack.shapeSources = ['operator', 'straight'];
  pack.trips = { a: 0, b: 1, c: 1 };
  assert.equal(operatorShapeTrips(pack), 1);
  assert.equal(operatorShapeTrips(null), 0);
  assert.equal(scheduleTripsPerDay(schedulePack('x', 14, 7)), 2);
  assert.equal(MIN_TRIP_SHARE, 0.2);
  assert.equal(tripFloorProblem('trips', 2, 10), null);
  assert.match(tripFloorProblem('trips', 1, 10), /trips 1 against 10/);
  assert.equal(tripFloorProblem('trips', 0, 0), null);
});

test('one build holds a folder’s lock; a second refuses, a dead one’s is taken over', async (t) => {
  const dir = await tempDir(t);
  const held = await acquireDirLock(dir, BUILD_LOCK, { what: 'test build' });
  const record = JSON.parse(await readFile(held.file, 'utf8'));
  assert.equal(record.pid, process.pid);
  await assert.rejects(
    acquireDirLock(dir, BUILD_LOCK, { what: 'test build' }),
    (error) =>
      /another test build holds/.test(error.message) &&
      error.message.includes(String(process.pid)),
  );
  await held.release();
  assert.deepEqual(await readdir(dir), []);

  // A lock whose process is gone.
  const lockFile = path.join(dir, BUILD_LOCK);
  await writeFile(
    lockFile,
    JSON.stringify({ pid: 999_999, time: new Date().toISOString() }),
  );
  const taken = await acquireDirLock(dir, BUILD_LOCK, { alive: () => false });
  assert.equal(JSON.parse(await readFile(lockFile, 'utf8')).pid, process.pid);
  await taken.release();

  // A live process's lock not refreshed for longer than staleMs.
  await writeFile(
    lockFile,
    JSON.stringify({ pid: 4242, time: '2026-01-01T00:00:00.000Z' }),
  );
  const old = await acquireDirLock(dir, BUILD_LOCK, { alive: () => true });
  await old.release();

  // A live, fresh one is respected; release never removes another's lock.
  await writeFile(
    lockFile,
    JSON.stringify({ pid: 4242, time: new Date().toISOString() }),
  );
  await assert.rejects(
    acquireDirLock(dir, BUILD_LOCK, { alive: () => true }),
    /pid 4242/,
  );
  await old.release();
  assert.equal(JSON.parse(await readFile(lockFile, 'utf8')).pid, 4242);
});

test('the command line names its feeds or says --all, and --help needs nothing else', () => {
  assert.throws(() => parseBuildArgs([]), /--feed <id>.*--all/);
  assert.equal(parseBuildArgs(['--all']).all, true);
  assert.deepEqual(parseBuildArgs(['--help']), { help: true });
  assert.deepEqual(parseBuildArgs(['--feed', 'x', '-h']), { help: true });
  assert.throws(() => parseBuildArgs(['--all', '--feed', 'x']), /not both/);
  assert.throws(
    () => parseBuildArgs(['--feed', 'x', '--bogus']),
    /Unknown argument --bogus/,
  );
  const named = parseBuildArgs(['--feed', 'a', '--feed', 'b', '--force']);
  assert.deepEqual(named.feeds, ['a', 'b']);
  assert.equal(named.force, true);
  assert.equal(parseBuildArgs(['--feed', 'a']).force, false);
  // Only registered feeds are built: there is no flag for any other.
  assert.throws(
    () =>
      parseBuildArgs([
        '--extra-feed',
        'test-extra=https://example.test/gtfs.zip',
      ]),
    /Unknown argument --extra-feed/,
  );
});

test('--out may not be src/ or public/ or inside them, but may sit beside them', () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  for (const inside of [
    'src',
    'public',
    path.join('src', 'data', 'packs'),
    // A name that only starts with two dots is still inside.
    path.join('src', '..cache'),
    path.join('public', '..x', 'y'),
  ])
    assert.throws(
      () => parseBuildArgs(['--feed', 'a', '--out', path.join(root, inside)]),
      /--out must not be inside/,
      inside,
    );
  for (const outside of [
    path.join('.cache', 'rail-paths'),
    'src-packs',
    path.join('src', '..', 'packs'),
  ])
    assert.equal(
      parseBuildArgs(['--feed', 'a', '--out', path.join(root, outside)]).out,
      path.resolve(root, outside),
    );
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(path.join(root, 'src'), root), false);
});

test('a build in which any feed fails exits with code 2', () => {
  assert.equal(FEED_FAILED_EXIT_CODE, 2);
  assert.equal(buildExitCode(0), 0);
  // One failure among feeds that built is still a failed build.
  assert.equal(buildExitCode(1), 2);
  assert.equal(buildExitCode(12), 2);
});
