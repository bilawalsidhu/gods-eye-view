import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import {
  createRouteNames,
  localStatic,
  openZip,
  parseLocalGtfs,
  readTripEnds,
} from '../../scripts/build-rail-paths.mjs';
import { classifyTrain } from '../data/railFeeds.js';

/** A minimal stored (uncompressed) zip. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(locals.length / 3, 8);
  end.writeUInt16LE(locals.length / 3, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-rail-local-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A GTFS in a top-level folder: a train from Venezia into Austria, a
 * domestic train, a train inside Italy, and a bus.
 */
const GTFS_FILES = {
  'GTFS_2026/agency.txt':
    'agency_id,agency_name,agency_url,agency_timezone\n01,Example Rail,https://example.test,Europe/Vienna\n',
  'GTFS_2026/routes.txt': [
    'route_id,agency_id,route_short_name,route_type',
    'I3,01,I3,2',
    'A9,01,A9,2',
    'SV1,01,SV1,3',
  ].join('\n'),
  'GTFS_2026/trips.txt': [
    'route_id,service_id,trip_id,trip_short_name',
    'I3,TA,it-domestic,R 134',
    'A9,TA,cross-border,EC 134',
    'A9,TA,at-domestic,RJ 650',
    'SV1,TA,bus,',
  ].join('\n'),
  'GTFS_2026/stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon',
    'it:22021:1,Venezia Santa Lucia,45.441,12.321',
    'it:22021:2,Tarvisio Citta Boscoverde,46.507,13.583',
    'at:42:1:1,Villach Hauptbahnhof,46.618,13.848',
    'at:42:2:1,Klagenfurt Hauptbahnhof,46.616,14.312',
    'at:49:1:1,Wien Hauptbahnhof,48.185,16.376',
  ].join('\n'),
  'GTFS_2026/stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'it-domestic,09:56:00,09:56:00,it:22021:1,1',
    'it-domestic,12:41:00,12:41:00,it:22021:2,2',
    'cross-border,12:57:00,12:57:00,it:22021:2,1',
    'cross-border,13:30:00,13:32:00,at:42:1:1,2',
    'cross-border,17:07:00,17:07:00,at:49:1:1,3',
    'at-domestic,08:00:00,08:00:00,at:42:2:1,1',
    'at-domestic,12:00:00,12:00:00,at:49:1:1,2',
    'bus,08:00:00,08:00:00,at:42:1:1,1',
    'bus,08:30:00,08:30:00,at:42:2:1,2',
  ].join('\n'),
};

/**
 * A feed whose category rule needs each trip's ends (`staticTripEnds:
 * true`): a trip is international when it stops in more than one country.
 */
const ENDS_FEED = Object.freeze({
  id: 'test-ends',
  staticTripEnds: true,
  staticTripRename: (trip, routeId, { ends } = {}) =>
    `${(ends?.countries ?? []).length > 1 ? 'INT' : 'DOM'}~${routeId}`,
  classify: (routeId) =>
    String(routeId).startsWith('INT~')
      ? { category: 'international', mode: 'rail' }
      : String(routeId).startsWith('DOM~')
        ? { category: 'national', mode: 'rail' }
        : null,
});

test('--local-gtfs names a feed and a zip path, made absolute', () => {
  const parsed = parseLocalGtfs('test-ends=downloads/GTFS_2026.zip');
  assert.equal(parsed.id, 'test-ends');
  assert.ok(path.isAbsolute(parsed.file));
  assert.equal(path.basename(parsed.file), 'GTFS_2026.zip');
  // A Windows path keeps its drive letter.
  assert.equal(
    parseLocalGtfs('irish-rail=C:\\Users\\me\\Downloads\\gtfs.zip').file,
    path.resolve('C:\\Users\\me\\Downloads\\gtfs.zip'),
  );
  for (const bad of ['', 'test-ends', 'test-ends=', '=x.zip', 'Bad_Id=x.zip'])
    assert.throws(() => parseLocalGtfs(bad), /--local-gtfs/, bad);
});

test('a local zip stands in for a download, by name only, and is left as it was', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'GTFS_2026.zip');
  const bytes = makeZip(GTFS_FILES);
  await writeFile(file, bytes);
  const before = await stat(file);
  const got = await localStatic(file);
  assert.equal(got.file, file);
  assert.equal(got.localName, 'GTFS_2026.zip');
  assert.equal(got.lastModified, before.mtime.toUTCString());
  // Reading it through the build leaves the file unchanged.
  const zip = await openZip(got.file);
  await readTripEnds(ENDS_FEED, zip);
  await zip.handle.close();
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  await assert.rejects(localStatic(path.join(dir, 'missing.zip')));
  await assert.rejects(localStatic(dir), /not a file/);
});

test('staticTripEnds gives each rail trip its ends and every country it stops in', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'feed.zip');
  await writeFile(file, makeZip(GTFS_FILES));
  const zip = await openZip(file);
  t.after(() => zip.handle.close());
  const feed = ENDS_FEED;
  const ends = await readTripEnds(feed, zip);
  assert.deepEqual([...ends.keys()].sort(), [
    'at-domestic',
    'cross-border',
    'it-domestic',
  ]);
  assert.deepEqual(ends.get('cross-border').countries, ['AT', 'IT']);
  assert.deepEqual(ends.get('at-domestic').countries, ['AT']);
  assert.deepEqual(ends.get('it-domestic').countries, ['IT']);
  assert.equal(ends.get('cross-border').from.name, 'Tarvisio Citta Boscoverde');
  assert.equal(ends.get('cross-border').to.name, 'Wien Hauptbahnhof');

  const names = await createRouteNames(feed, zip);
  const route = names.route({ route_id: 'A9', route_type: '2' });
  const category = (tripId, shortName) =>
    classifyTrain(
      feed,
      names.trip({ trip_id: tripId, trip_short_name: shortName }, route),
    )?.category ?? null;
  assert.equal(category('cross-border', 'EC 134'), 'international');
  assert.equal(category('at-domestic', 'RJ 650'), 'national');
  assert.equal(names.route({ route_id: 'SV1', route_type: '3' }), null);
});
