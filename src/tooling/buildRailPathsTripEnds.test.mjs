import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import {
  buildPack,
  buildSchedule,
  createRouteNames,
  openZip,
  readTripEnds,
} from '../../scripts/build-rail-paths.mjs';
import { classifyTrain, getRegisteredRailFeed } from '../data/railFeeds.js';

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

async function withZip(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-rail-ends-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'feed.zip');
  await writeFile(file, makeZip(files));
  const zip = await openZip(file);
  t.after(() => zip.handle.close());
  return zip;
}

/** A small KTMB-like GTFS: an ETS run KL–JB, an ETS run KL–Hat Yai, a bus. */
const KTMB_FILES = {
  'agency.txt':
    'agency_id,agency_name,agency_url,agency_timezone\nktmb,KTMB,https://ktmb.com.my,Asia/Kuala_Lumpur\n',
  'routes.txt': [
    'route_id,route_short_name,route_type',
    'ETS,ETS,2',
    'KC05_KB18,Seremban,2',
    'B1,Bus,3',
  ].join('\n'),
  'trips.txt': [
    'route_id,service_id,trip_id',
    'ETS,daily,9001',
    'ETS,daily,9002',
    'KC05_KB18,daily,2001',
    'B1,daily,b1',
  ].join('\n'),
  'stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon',
    '19100,KL SENTRAL,3.134167,101.686111',
    '37500,JB SENTRAL,1.463147,103.764445',
    '22700,SEREMBAN,2.719169,101.940792',
    '99000,HAT YAI,7.0033,100.4687',
    '50600,BATU CAVES,3.237796,101.681215',
  ].join('\n'),
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    // Out of order on purpose: the ends come from stop_sequence.
    '9001,08:40:00,08:42:00,22700,2',
    '9001,08:00:00,08:00:00,19100,1',
    '9001,12:00:00,12:00:00,37500,3',
    '9002,09:00:00,09:00:00,19100,1',
    '9002,17:00:00,17:00:00,99000,2',
    '2001,07:00:00,07:00:00,50600,1',
    '2001,07:30:00,07:30:00,19100,2',
    'b1,07:00:00,07:00:00,19100,1',
    'b1,07:30:00,07:30:00,22700,2',
  ].join('\n'),
  'calendar.txt': [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'daily,1,1,1,1,1,1,1,20260101,20271231',
  ].join('\n'),
  'calendar_dates.txt': [
    'service_id,date,exception_type',
    // Far outside any build window: read and ignored.
    'daily,20271225,2',
    'daily,20261110,2',
  ].join('\n'),
};

test('readTripEnds keeps rail trips only, ends by stop_sequence, with states', async (t) => {
  const zip = await withZip(t, KTMB_FILES);
  const ends = await readTripEnds(getRegisteredRailFeed('ktmb'), zip);
  assert.deepEqual([...ends.keys()].sort(), ['2001', '9001', '9002']);
  const ets = ends.get('9001');
  assert.equal(ets.from.name, 'KL SENTRAL');
  assert.equal(ets.to.name, 'JB SENTRAL');
  assert.deepEqual([ets.from.state, ets.to.state], ['MY-14', 'MY-01']);
  assert.deepEqual(ets.countries, ['MY']);
  assert.deepEqual(ends.get('9002').countries, ['MY', 'TH']);
});

test('a feed with staticTripEnds names each trip by where it runs', async (t) => {
  const zip = await withZip(t, KTMB_FILES);
  const feed = getRegisteredRailFeed('ktmb');
  const names = await createRouteNames(feed, zip);
  const etsKl = names.trip(
    { trip_id: '9001' },
    names.route({ route_id: 'ETS', route_type: '2' }),
  );
  assert.equal(etsKl, 'ETS~X~ETS');
  assert.equal(classifyTrain(feed, etsKl).category, 'national');
  const etsHatYai = names.trip({ trip_id: '9002' }, 'ETS');
  assert.equal(classifyTrain(feed, etsHatYai).category, 'international');
  assert.equal(
    classifyTrain(feed, names.trip({ trip_id: '2001' }, 'KC05_KB18')).category,
    'local',
  );
  assert.equal(names.route({ route_id: 'B1', route_type: '3' }), null);
});

test('the packs carry the scoped route ids, and the realtime trip resolves to one', async (t) => {
  const zip = await withZip(t, KTMB_FILES);
  const feed = getRegisteredRailFeed('ktmb');
  const names = await createRouteNames(feed, zip);
  const { pack } = await buildPack(feed, zip, { url: 'x' }, names);
  const { schedule } = await buildSchedule(feed, zip, { url: 'x' }, pack, {
    names,
    from: '2026-11-09',
    days: 3,
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(schedule.trips).map(([id, trip]) => [id, trip.route]),
    ),
    { 9001: 'ETS~X~ETS', 9002: 'ETS~B~ETS', 2001: 'KC05_KB18~X~KC05_KB18' },
  );
  assert.deepEqual(schedule.services.daily, ['2026-11-09', '2026-11-11']);
});
