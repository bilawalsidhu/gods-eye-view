// Stops a GTFS gives no coordinates, or (0, 0) as some feeds do for foreign
// stations their international trains serve: left out of their runs, never
// placed by guesswork, so no line is ever drawn to (0, 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  buildPack,
  buildSchedule,
  hasStopCoordinates,
  openZip,
  readTripEnds,
} from '../../scripts/build-rail-paths.mjs';

/** A minimal zip writer: deflated entries, no zip64. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, text } of files) {
    const data = Buffer.from(text, 'utf8');
    const body = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// A line 20 km due east from 51° N 7° E (in Germany), x in metres.
const LAT = 51;
const LON = 7;
const DLON = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const lonAt = (x) => LON + x * DLON;
const at = (x) => `${LAT.toFixed(6)},${lonAt(x).toFixed(6)}`;

async function feedZip(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-unlocated-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'feed.zip');
  await writeFile(
    file,
    makeZip([
      {
        name: 'agency.txt',
        text: 'agency_id,agency_name,agency_url,agency_timezone\nA,Test,https://example.test,Europe/Berlin\n',
      },
      {
        name: 'calendar.txt',
        text: 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,1,1,20260101,20261231\n',
      },
      { name: 'routes.txt', text: 'route_id,route_type\nR1,2\n' },
      {
        name: 'trips.txt',
        text: [
          'route_id,service_id,trip_id,shape_id',
          'R1,WK,t1,',
          'R1,WK,t2,',
          'R1,WK,t3,',
          'R1,WK,t4,',
        ].join('\n'),
      },
      {
        name: 'stops.txt',
        text: [
          'stop_id,stop_name,stop_lat,stop_lon,parent_station',
          `A,Alpha,${at(0)},`,
          `C,Charlie,${at(20_000)},`,
          // (0, 0) in the feed, parent and all.
          'PZ,Zeta (Westf.),0,0,',
          'Z,Zeta (Westf.),0,0,PZ',
          'Y,Ypsilon,0,0,',
          // Blank coordinates are none either.
          'Q,Quebec,,,',
        ].join('\n'),
      },
      {
        name: 'stop_times.txt',
        text: [
          'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
          't1,08:00:00,08:00:00,A,1',
          't1,08:10:00,08:10:00,Z,2',
          't1,08:20:00,08:20:00,C,3',
          't2,09:00:00,09:00:00,A,1',
          't2,09:10:00,09:10:00,Y,2',
          't2,09:20:00,09:20:00,C,3',
          't3,10:00:00,10:00:00,A,1',
          't3,10:10:00,10:10:00,Y,2',
          't4,11:00:00,11:00:00,A,1',
          't4,11:10:00,11:10:00,Q,2',
          't4,11:20:00,11:20:00,C,3',
        ].join('\n'),
      },
    ]),
  );
  const zip = await openZip(file);
  t.after(() => zip.handle.close());
  return zip;
}

const feed = {
  id: 'test-feed',
  classify: () => ({ category: 'regional', mode: 'rail' }),
};
const options = { from: '2026-11-09', days: 2 };

/** Every vertex of every shape the pack holds, as [lat, lon]. */
function vertices(pack) {
  const out = [];
  for (const flat of pack.shapes)
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

const stopNames = (schedule, id) =>
  schedule.patterns[schedule.trips[id].pattern].stops.map(
    (k) => schedule.stops[k].name,
  );

test('(0, 0) and blank coordinates are no coordinates', () => {
  assert.equal(hasStopCoordinates(0, 0), false);
  assert.equal(hasStopCoordinates(-0, 0), false);
  assert.equal(hasStopCoordinates(Number.NaN, 7), false);
  assert.equal(hasStopCoordinates(undefined, undefined), false);
  assert.equal(hasStopCoordinates(0, 0.00001), true);
  assert.equal(hasStopCoordinates(51.68, 7.81), true);
});

test('an unlocated stop is left out of its runs, never drawn to (0, 0)', async (t) => {
  const zip = await feedZip(t);
  const { pack } = await buildPack(feed, zip, { url: 'x' });
  const { schedule, stats } = await buildSchedule(
    feed,
    zip,
    { url: 'x' },
    pack,
    options,
  );
  // t1, t2 and t4 keep their two located stops; t3 has only one left.
  assert.deepEqual(Object.keys(schedule.trips).sort(), ['t1', 't2', 't4']);
  for (const id of ['t1', 't2', 't4'])
    assert.deepEqual(stopNames(schedule, id), ['Alpha', 'Charlie']);
  // The stop's times go with it.
  const t1 = schedule.trips.t1;
  assert.deepEqual(schedule.profiles[t1.profile], [0, 0, 1200, 1200]);
  assert.deepEqual(schedule.patterns[t1.pattern].seq, [1, 3]);
  assert.equal(stats.tripsUnknownStop, 1);
  assert.equal(stats.tripsStopsLeftOut, 3);
  assert.equal(stats.stopsLeftOut, 3);
  // Nothing is guessed: no stop without coordinates, nor its parent, is in
  // the pack.
  for (const id of ['Z', 'PZ', 'Y', 'Q'])
    assert.equal(
      schedule.stops.find((s) => s.id === id),
      undefined,
      id,
    );
  assert.ok(schedule.stops.every((s) => hasStopCoordinates(s.lat, s.lon)));
  assert.ok(vertices(pack).every(([lat, lon]) => hasStopCoordinates(lat, lon)));
});

test('a run ends at its last located stop when its last has no coordinates', async (t) => {
  const zip = await feedZip(t);
  const ends = await readTripEnds({}, zip);
  assert.equal(ends.get('t1').from.name, 'Alpha');
  assert.equal(ends.get('t1').to.name, 'Charlie');
  // t3: Alpha, then Ypsilon at (0, 0).
  assert.equal(ends.get('t3').to.name, 'Alpha');
  assert.deepEqual(ends.get('t3').countries, ['DE']);
});
