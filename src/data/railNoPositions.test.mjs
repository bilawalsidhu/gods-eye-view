import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { PbfWriter } from 'pbf';
import {
  NO_TRAIN_POSITION_BOX,
  NO_TRAIN_POSITION_COUNTRIES,
  isNoTrainPositionPoint,
  isNoTrainPositionStop,
  stopIdCountry,
} from './railNoPositions.js';
import { buildRailSnapshot } from './railProxy.js';
import { createRunIndex } from './railScheduleIndex.js';
import {
  buildPack,
  buildSchedule,
  openZip,
} from '../../scripts/build-rail-paths.mjs';

const KYIV = [50.45, 30.52];
const LVIV = [49.84, 24.03];
const SIMFEROPOL = [44.95, 34.1];
const AMSTERDAM = [52.37, 4.9];
const PRZEMYSL = [49.78, 22.77];
const CHISINAU = [47.0, 28.86];

/** A fake feed: every vehicle and route is a train, so only the rule drops. */
function fakeFeed(extra = {}) {
  return Object.freeze({
    id: 'test-no-positions',
    name: 'Test',
    format: 'gtfs-rt',
    classify: () => ({ category: 'international', mode: 'rail' }),
    ...extra,
  });
}

test('the area is Ukraine, Crimea included, behind a cheap box', () => {
  assert.deepEqual(NO_TRAIN_POSITION_COUNTRIES, ['UA']);
  for (const [lat, lon] of [KYIV, LVIV, SIMFEROPOL, [48.0, 37.8]])
    assert.equal(isNoTrainPositionPoint(lat, lon), true, `${lat},${lon}`);
  for (const [lat, lon] of [AMSTERDAM, PRZEMYSL, CHISINAU, [53.9, 27.56]])
    assert.equal(isNoTrainPositionPoint(lat, lon), false, `${lat},${lon}`);
  // Outside the box nothing more is computed.
  assert.ok(NO_TRAIN_POSITION_BOX.west > 22 && NO_TRAIN_POSITION_BOX.east < 41);
  for (const bad of [NaN, null, undefined])
    assert.equal(isNoTrainPositionPoint(bad, 30), false);
});

test('stations on the border fall on their own side (OpenStreetMap positions)', () => {
  // Outside Ukraine, within 1 km of the border: on the Tisa (Bocicoi), by
  // the Polish crossing (Medyka) and on the Slovak line (Čierna nad Tisou).
  for (const [name, lat, lon] of [
    ['Bocicoi', 47.95743, 24.02333],
    ['Valea Vișeului', 47.91463, 24.15557],
    ['Sighetu Marmației', 47.9358, 23.88536],
    ['Medyka', 49.80248, 22.93929],
    ['Čierna nad Tisou št. hr.', 48.43209, 22.13597],
    ['Záhony', 48.4017, 22.18376],
  ])
    assert.equal(isNoTrainPositionPoint(lat, lon), false, name);
  // Inside Ukraine, as close to the border.
  for (const [name, lat, lon] of [
    ['Uhniv', 50.37859, 23.73241],
    ['Korchiv', 50.39422, 23.83512],
    ['Teresva', 47.99573, 23.70047],
    ['Solotvyno-Likarnia', 47.96591, 23.86276],
  ])
    assert.equal(isNoTrainPositionPoint(lat, lon), true, name);
});

test('a stop is left out when its id names Ukraine or its position is inside', () => {
  assert.equal(stopIdCountry('ua:22005:1:1'), 'UA');
  assert.equal(stopIdCountry('Pua:22005'), 'UA');
  assert.equal(stopIdCountry('de:09162:6'), 'DE');
  assert.equal(stopIdCountry('8000105'), null);
  // A Ukrainian stop the outline would put in Hungary (Chop, on the border).
  assert.equal(
    isNoTrainPositionStop({ id: 'ua:22005:1:1', lat: 48.43, lon: 22.1 }),
    true,
  );
  // A stop whose id names Poland, at a position the outline puts in
  // Ukraine (Shehyni, across the border from Medyka): its id does not keep
  // it.
  assert.equal(
    isNoTrainPositionStop({ id: 'pl:1:1', lat: 49.7949, lon: 22.9768 }),
    true,
  );
  // Border stations on their own side stay, by id or by position alone.
  for (const [id, lat, lon] of [
    ['pl:1:2', 49.80248, 22.93929], // Medyka
    ['hu:1:1', 48.4017, 22.18376], // Záhony
    ['sk:1:1', 48.43209, 22.13597], // Čierna nad Tisou
    ['ro:1:1', 47.95743, 24.02333], // Bocicoi
    ['5001', 49.80248, 22.93929],
  ])
    assert.equal(isNoTrainPositionStop({ id, lat, lon }), false, id);
  assert.equal(
    isNoTrainPositionStop({ id: '9001', lat: LVIV[0], lon: LVIV[1] }),
    true,
  );
  assert.equal(isNoTrainPositionStop(null), false);
});

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

/**
 * Wien–Budapest, Budapest–Chop (a `ua:` stop the outline would miss),
 * Budapest–Lviv (an id without a country, inside the outline) and
 * Sighet–Bocicoi (a Romanian halt on the border river, which a coarser
 * outline would place in Ukraine).
 */
const GTFS = {
  'agency.txt':
    'agency_id,agency_name,agency_url,agency_timezone\n1,Test,https://example.invalid,Europe/Vienna\n',
  'routes.txt': 'route_id,route_short_name,route_type\nR,EC,2\n',
  'trips.txt': [
    'route_id,service_id,trip_id,trip_short_name',
    'R,daily,vienna-budapest,EC 1',
    'R,daily,budapest-chop,EC 2',
    'R,daily,budapest-lviv,EC 3',
    'R,daily,sighet-bocicoi,R 4',
  ].join('\n'),
  'stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon',
    'at:49:1,Wien Hauptbahnhof,48.185,16.376',
    'hu:55:1,Budapest-Keleti,47.500,19.083',
    'ua:22005:1:1,Chop,48.43,22.1',
    '9001,Lviv,49.84,24.03',
    '43820,Sighetu Marmaţiei,47.9358,23.88536',
    '43753,Bocicoi Hm.,47.95743,24.02333',
  ].join('\n'),
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'vienna-budapest,08:00:00,08:00:00,at:49:1,1',
    'vienna-budapest,10:40:00,10:40:00,hu:55:1,2',
    'budapest-chop,11:00:00,11:00:00,hu:55:1,1',
    'budapest-chop,16:00:00,16:00:00,ua:22005:1:1,2',
    'budapest-lviv,12:00:00,12:00:00,hu:55:1,1',
    'budapest-lviv,20:00:00,20:00:00,9001,2',
    'sighet-bocicoi,09:00:00,09:00:00,43820,1',
    'sighet-bocicoi,09:20:00,09:20:00,43753,2',
  ].join('\n'),
  'calendar.txt': [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'daily,1,1,1,1,1,1,1,20260101,20271231',
  ].join('\n'),
};

async function buildFake(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-rail-no-pos-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'feed.zip');
  await writeFile(file, makeZip(GTFS));
  const zip = await openZip(file);
  t.after(() => zip.handle.close());
  const feed = fakeFeed();
  const { pack } = await buildPack(feed, zip, { url: 'x' });
  return buildSchedule(feed, zip, { url: 'x' }, pack, {
    from: '2026-11-09',
    days: 2,
  });
}

test('the build leaves out every timetable trip that stops in Ukraine', async (t) => {
  const { schedule, stats } = await buildFake(t);
  assert.deepEqual(Object.keys(schedule.trips).sort(), [
    'sighet-bocicoi',
    'vienna-budapest',
  ]);
  assert.equal(stats.tripsNoPositions, 2);
  assert.deepEqual(schedule.stops.map((stop) => stop.name).sort(), [
    'Bocicoi Hm.',
    'Budapest-Keleti',
    'Sighetu Marmaţiei',
    'Wien Hauptbahnhof',
  ]);
});

test('a kept stop records no country', async (t) => {
  const { schedule } = await buildFake(t);
  for (const stop of schedule.stops) {
    assert.equal(Object.hasOwn(stop, 'cc'), false, stop.name);
    assert.equal(Object.hasOwn(stop, 'country'), false, stop.name);
  }
});

test('a left-out trip has no runs for a reported train to take', async (t) => {
  const { schedule } = await buildFake(t);
  const runs = createRunIndex(schedule);
  for (const tripId of ['budapest-chop', 'budapest-lviv'])
    assert.deepEqual(runs.runsOf(tripId), [], tripId);
  assert.ok(runs.runsOf('vienna-budapest').length > 0);
});

/** A GTFS-RT VehiclePositions message with one vehicle per position. */
function encodeVehicles(positions) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, 1_794_000_000);
  writer.writeBytesField(1, header.finish());
  positions.forEach(([lat, lon], i) => {
    const entity = new PbfWriter();
    entity.writeStringField(1, `v${i}`);
    const vehicle = new PbfWriter();
    const trip = new PbfWriter();
    trip.writeStringField(1, `trip-${i}`);
    trip.writeStringField(5, 'R');
    vehicle.writeBytesField(1, trip.finish());
    const position = new PbfWriter();
    position.writeFloatField(1, lat);
    position.writeFloatField(2, lon);
    vehicle.writeBytesField(2, position.finish());
    vehicle.writeVarintField(5, 1_793_999_990);
    entity.writeBytesField(4, vehicle.finish());
    writer.writeBytesField(2, entity.finish());
  });
  return writer.finish();
}

test('a live GPS position in Ukraine is dropped and counted, never sent', () => {
  const snapshot = buildRailSnapshot(
    fakeFeed({ url: 'https://example.invalid/vp' }),
    encodeVehicles([AMSTERDAM, KYIV, SIMFEROPOL, PRZEMYSL]),
    1_794_000_000_000,
  );
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.dropped, 2);
  for (const train of snapshot.trains)
    assert.equal(isNoTrainPositionPoint(train.lat, train.lon), false);
});

test('an adapter position (Irish Rail XML) in Ukraine is dropped too', () => {
  const position = (code, [lat, lon]) => `
  <objTrainPositions>
    <TrainStatus>R</TrainStatus>
    <TrainLatitude>${lat}</TrainLatitude>
    <TrainLongitude>${lon}</TrainLongitude>
    <TrainCode>${code}</TrainCode>
    <TrainDate>06 Nov 2026</TrainDate>
    <PublicMessage>${code}</PublicMessage>
    <Direction>Northbound</Direction>
  </objTrainPositions>`;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfObjTrainPositions xmlns="http://api.irishrail.ie/realtime/">${position('A101', AMSTERDAM)}${position('A102', LVIV)}
</ArrayOfObjTrainPositions>`;
  const snapshot = buildRailSnapshot(
    fakeFeed({ format: 'irish-rail-xml', url: 'https://example.invalid/xml' }),
    new TextEncoder().encode(body),
    1_794_000_000_000,
  );
  assert.deepEqual(
    snapshot.trains.map((train) => train.id),
    ['A101'],
  );
  assert.equal(snapshot.dropped, 1);
});
