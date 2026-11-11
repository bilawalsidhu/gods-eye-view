import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  buildPack,
  buildSchedule,
  entryStream,
  fillTimes,
  finishShape,
  frequencyDepartures,
  isRailRouteType,
  openZip,
  parseGtfsTime,
  parseRecord,
  projectStops,
  readCsv,
  resolveServiceDays,
  simplifyFlat,
} from '../../scripts/build-rail-paths.mjs';
import { createRailPath } from '../data/railPaths.js';
import { createSchedule, tripStops } from '../data/railSchedule.js';

/** A minimal zip writer: stored or deflated entries, no zip64. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, text, deflate } of files) {
    const data = Buffer.from(text, 'utf8');
    const body = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
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

const D = 1 / 111_320;

/** Straight east along the equator in `step`-metre steps, as shapes.txt rows. */
function shapeRows(id, steps, step) {
  const rows = [];
  for (let i = 0; i <= steps; i++)
    rows.push(`${id},0,${(i * step * D).toFixed(6)},${i * 10}`);
  // Out of order on purpose: the build sorts by sequence.
  return rows.reverse();
}

async function withZip(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-build-rail-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'feed.zip');
  await writeFile(file, makeZip(files));
  const zip = await openZip(file);
  t.after(() => zip.handle.close());
  return zip;
}

test('rail route types are the tram, metro and railway families', () => {
  for (const type of [
    '0',
    '1',
    '2',
    ' 2 ',
    '5',
    '7',
    '12',
    '100',
    '109',
    '401',
    '900',
    // Extended funicular, as basic 7 is.
    '1400',
  ])
    assert.ok(isRailRouteType(type), type);
  for (const type of ['3', '4', '6', '11', '200', '700', '1000', '', 'x'])
    assert.equal(isRailRouteType(type), false, type);
});

test('CSV records honour quotes and trim padded fields', () => {
  assert.deepEqual(parseRecord('a, b ,c\r'), ['a', 'b', 'c']);
  assert.deepEqual(parseRecord('1,"x, ""y""",z'), ['1', 'x, "y"', 'z']);
});

test('the zip reader streams stored and deflated entries', async (t) => {
  const zip = await withZip(t, [
    { name: 'stored.txt', text: 'h\n1\n' },
    {
      name: 'gtfs/routes.txt',
      text: 'route_id,route_long_name\nR1,"A, B\nC"\nR2,D\n',
      deflate: true,
    },
  ]);
  assert.deepEqual([...zip.entries.keys()].sort(), [
    'gtfs/routes.txt',
    'stored.txt',
  ]);
  const rows = [];
  const count = await readCsv(
    await entryStream(zip, zip.entries.get('gtfs/routes.txt')),
    (row) => rows.push(row),
  );
  assert.equal(count, 2);
  assert.deepEqual(rows, [
    { route_id: 'R1', route_long_name: 'A, B\nC' },
    { route_id: 'R2', route_long_name: 'D' },
  ]);
});

test('a shape is sorted, rounded, simplified and measured; a chord is dropped', () => {
  const triples = [2, 0, 2000 * D, 0, 0, 0, 1, 0, 1000 * D, 1, 0, 1000 * D];
  const shape = finishShape(triples);
  assert.deepEqual(
    shape.flat.length,
    4,
    'collinear middle point simplified away',
  );
  assert.equal(shape.rawPoints, 3, 'duplicate point removed');
  // Haversine metres, a little under the 111,320 m/degree used to place it.
  assert.ok(Math.abs(shape.dist[1] - 2000) < 5, String(shape.dist[1]));
  // Sparse vertices on straight track (MBTA commuter lines run 2-3.3 km
  // between vertices) are track, not a chord.
  assert.equal(finishShape([0, 0, 0, 1, 0, 3000 * D]).dropped, undefined);
  const chord = finishShape([0, 0, 0, 1, 0, 6000 * D]);
  assert.match(chord.dropped, /^vertex gap 59\d\d m$/);
  assert.match(finishShape([0, 0, 0]).dropped, /fewer than two points/);
});

test('simplification keeps every corner beyond the tolerance', () => {
  const flat = [
    0,
    0,
    0,
    1000 * D,
    0.5 * D,
    1500 * D,
    0,
    2000 * D,
    500 * D,
    2000 * D,
  ];
  const simple = simplifyFlat(flat, 1);
  assert.deepEqual(simple, [0, 0, 0, 2000 * D, 500 * D, 2000 * D]);
});

test('a pack keeps classified rail routes, dedupes shapes and maps trips', async (t) => {
  const zip = await withZip(t, [
    {
      name: 'routes.txt',
      text: 'route_id, route_type, route_long_name\nR1, 2, "Main, line"\nR2,2,Other\nB1,3,Bus\n',
      deflate: true,
    },
    {
      name: 'trips.txt',
      text: [
        'route_id,service_id,trip_id,shape_id',
        'R1,wk,t1,A',
        'R1,wk,t2,A2',
        'R1,wk,t3,CHORD',
        'R1,wk,t4,',
        'R2,wk,t5,A',
        'B1,wk,t6,BUS',
      ].join('\n'),
      deflate: true,
    },
    {
      name: 'shapes.txt',
      text: [
        'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
        ...shapeRows('A', 20, 100),
        ...shapeRows('A2', 20, 100),
        'CHORD,0,0,1',
        `CHORD,0,${(8000 * D).toFixed(6)},2`,
        ...shapeRows('BUS', 5, 100),
      ].join('\n'),
      deflate: true,
    },
  ]);
  const feed = {
    id: 'test-feed',
    classify: (routeId) =>
      routeId === 'R1' || routeId === 'B1'
        ? { category: 'local', mode: 'rail' }
        : null,
  };
  const { pack, stats } = await buildPack(feed, zip, {
    url: 'https://example.test/gtfs.zip',
    lastModified: null,
  });
  assert.equal(pack.version, 1);
  assert.equal(pack.feedId, 'test-feed');
  assert.equal(pack.shapes.length, 1, 'identical shapes stored once');
  assert.deepEqual(pack.shapes[0], [0, 0, 0, 0.01797]);
  assert.equal(pack.dist[0].length, 2);
  assert.deepEqual({ ...pack.trips }, { t1: 0, t2: 0 });
  assert.deepEqual({ ...pack.routes }, { R1: [0] });
  assert.equal(
    stats.railRoutes,
    1,
    'the bus route and the unclassified route are out',
  );
  assert.equal(stats.shapesDropped, 1);
  assert.equal(stats.shapelessTrips, 1);
  assert.equal(stats.tripsMapped, 2);
  assert.equal(JSON.parse(JSON.stringify(pack)).trips.t1, 0);
});

test('GTFS times parse past midnight; blanks and junk are NaN', () => {
  assert.equal(parseGtfsTime('25:30:00'), 91_800);
  assert.equal(parseGtfsTime(' 7:05:09 '), 25_509);
  assert.ok(Number.isNaN(parseGtfsTime('')));
  assert.ok(Number.isNaN(parseGtfsTime('7:5:00')));
});

test('calendars resolve to concrete service days with exceptions', () => {
  const day = (text) => Date.parse(`${text}T00:00:00Z`) / 86_400_000;
  const days = resolveServiceDays(
    [
      {
        service_id: 'WK',
        monday: '1',
        tuesday: '1',
        wednesday: '1',
        thursday: '1',
        friday: '1',
        saturday: '0',
        sunday: '0',
        start_date: '20260101',
        end_date: '20261105',
      },
    ],
    [
      { service_id: 'WK', date: '20261104', exception_type: '2' },
      { service_id: 'X', date: '20261108', exception_type: '1' },
      { service_id: 'Y', date: '20261108', exception_type: '2' },
    ],
    day('2026-11-02'),
    day('2026-11-08'),
  );
  assert.deepEqual(days.get('WK'), [
    day('2026-11-02'),
    day('2026-11-03'),
    day('2026-11-05'),
  ]);
  assert.deepEqual(days.get('X'), [day('2026-11-08')]);
  assert.equal(days.has('Y'), false);
});

test('blank stop times are filled by distance between timed stops', () => {
  const arr = [0, NaN, NaN, 300, 400];
  const dep = [0, NaN, NaN, NaN, 400];
  assert.equal(fillTimes(arr, dep, [0, 100, 200, 300, 350]), true);
  assert.deepEqual(arr, [0, 100, 200, 300, 400]);
  assert.deepEqual(dep, [0, 100, 200, 300, 400]);
  assert.equal(fillTimes([NaN, 5], [NaN, 5], [0, 1]), false);
});

test('stops project onto a shape in order, binding a twice-passed stop to the first pass', () => {
  // Out along the equator and back 20 m north of it.
  const path = createRailPath([0, 0, 0, 2000 * D, 20 * D, 2000 * D, 20 * D, 0]);
  const { dist, maxOffsetM } = projectStops(path, [
    { lat: 0, lon: 0 },
    // Nearer the return line (5 m) than the outbound (15 m).
    { lat: 15 * D, lon: 1000 * D },
    { lat: 20 * D, lon: 0 },
  ]);
  assert.ok(Math.abs(dist[1] - 1000) < 2, String(dist[1]));
  assert.ok(Math.abs(dist[2] - 4020) < 2, String(dist[2]));
  assert.ok(maxOffsetM < 16);
  // Never backwards, even when a stop lies behind the previous one.
  const back = projectStops(path, [
    { lat: 0, lon: 1500 * D },
    { lat: 0, lon: 500 * D },
  ]);
  assert.ok(back.dist[1] >= back.dist[0]);
});

test('a stop offset is in great-circle metres, not the path projection', () => {
  // North along the meridian; the flat projection is true only at 30°N.
  const path = createRailPath([0, 0, 30, 0, 60, 0]);
  const eastAt60 =
    (500 / (6_371_008.8 * Math.cos(Math.PI / 3))) * (180 / Math.PI);
  const { maxOffsetM } = projectStops(path, [
    { lat: 0, lon: 0 },
    { lat: 60, lon: eastAt60 },
  ]);
  // The projection alone reads 866 m (500 m × cos 30° / cos 60°).
  assert.ok(Math.abs(maxOffsetM - 500) < 5, String(maxOffsetM));
});

const east = (m) => (m * D).toFixed(6);

function scheduleZip(t) {
  return withZip(t, [
    {
      name: 'agency.txt',
      text: 'agency_id,agency_name,agency_url,agency_timezone\nA,Test,https://example.test,America/New_York\n',
    },
    {
      name: 'calendar.txt',
      text: [
        'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
        'WK,1,1,1,1,1,0,0,20260101,20261231',
        'WE,0,0,0,0,0,1,1,20260101,20261231',
      ].join('\n'),
    },
    {
      name: 'calendar_dates.txt',
      text: 'service_id,date,exception_type\nWK,20261106,2\nHOL,20261107,1\n',
    },
    {
      name: 'routes.txt',
      text: 'route_id,route_type,route_color\nR1,2,ff0000\nB1,3,\n',
    },
    {
      name: 'trips.txt',
      text: [
        'route_id,service_id,trip_id,shape_id,trip_headsign,trip_short_name,direction_id',
        'R1,WK,t1,S,East,101,0',
        'R1,WK,t2,S,East,103,0',
        'R1,WE,t3,S,East,105,0',
        'R1,HOL,t4,,East,107,1',
        'R1,OLD,t5,S,East,109,0',
        'B1,WK,b1,S,,,',
      ].join('\n'),
      deflate: true,
    },
    {
      name: 'stops.txt',
      text: [
        'stop_id,stop_name,stop_lat,stop_lon,parent_station,stop_timezone,platform_code',
        'P,Parent Station,0,0.00001,,,',
        // A hair east of (0, 0), which the build reads as no coordinates.
        'A1,Alpha 1,0,0.000001,P,,1',
        'Bst,Bravo,0,' + east(1000) + ',,,',
        'C,Charlie,0,' + east(3000) + ',,America/Chicago,',
        'X,Unused,1,1,,,',
      ].join('\n'),
    },
    {
      name: 'stop_times.txt',
      text: [
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
        't1,08:30:00,08:30:00,C,9,,',
        't1,08:00:00,08:00:00,A1,1,,',
        't1,,,Bst,5,,',
        't2,09:00:00,09:00:00,A1,1,,',
        't2,,,Bst,5,,',
        't2,09:30:00,09:30:00,C,9,,',
        't3,23:50:00,23:50:00,A1,1,,',
        't3,,,Bst,5,,',
        't3,24:20:00,24:20:00,C,9,,',
        't4,10:00:00,10:00:00,A1,1,,',
        't4,10:30:00,10:30:00,C,2,1,1',
        't5,07:00:00,07:00:00,A1,1,,',
        't5,07:30:00,07:30:00,C,9,,',
        'b1,07:00:00,07:00:00,A1,1,,',
        'b1,07:30:00,07:30:00,X,2,,',
      ].join('\n'),
      deflate: true,
    },
    {
      name: 'shapes.txt',
      text: [
        'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
        ...shapeRows('S', 40, 100),
      ].join('\n'),
    },
  ]);
}

const railFeed = (extra = {}) => ({
  id: 'test-feed',
  classify: () => ({ category: 'local', mode: 'rail' }),
  ...extra,
});

test('a schedule pack resolves services, shares patterns and run times, and keeps served stops', async (t) => {
  const zip = await scheduleZip(t);
  const feed = railFeed();
  const { pack: paths } = await buildPack(feed, zip, { url: 'x' });
  const { schedule, stats } = await buildSchedule(
    feed,
    zip,
    { url: 'x' },
    paths,
    { from: '2026-11-05', days: 4 },
  );
  assert.equal(schedule.version, 1);
  assert.equal(schedule.timezone, 'America/New_York');
  assert.deepEqual(schedule.window, { from: '2026-11-05', to: '2026-11-08' });
  assert.equal(schedule.pathsBuiltAt, paths.builtAt);
  assert.deepEqual(Object.keys(schedule.trips).sort(), [
    't1',
    't2',
    't3',
    't4',
  ]);
  const { t1, t2, t3, t4 } = schedule.trips;
  assert.equal(t1.pattern, t2.pattern);
  assert.equal(t1.pattern, t3.pattern);
  assert.notEqual(t1.pattern, t4.pattern);
  assert.equal(t1.profile, t2.profile, 'equal run times share one array');
  assert.equal(t1.profile, t3.profile);
  assert.deepEqual(schedule.profiles[t1.profile], [0, 0, 600, 600, 1800, 1800]);
  assert.equal(t1.startSec, 8 * 3600);
  assert.equal(t3.startSec, 23 * 3600 + 50 * 60);
  assert.deepEqual(
    {
      name: t1.name,
      headsign: t1.headsign,
      direction: t1.direction,
      route: t1.route,
    },
    { name: '101', headsign: 'East', direction: 0, route: 'R1' },
  );
  // t3 ends past midnight, so the pack looks one day back.
  assert.equal(stats.lookbackDays, 1);
  assert.deepEqual(
    { ...schedule.services },
    {
      WK: ['2026-11-04', '2026-11-05'],
      WE: ['2026-11-07', '2026-11-08'],
      HOL: ['2026-11-07'],
    },
  );
  assert.deepEqual(
    { ...schedule.routes },
    { R1: { type: 2, color: 'FF0000' } },
  );
  const ids = schedule.stops.map((stop) => stop.id);
  assert.deepEqual(ids.sort(), ['A1', 'Bst', 'C', 'P']);
  const byId = Object.fromEntries(
    schedule.stops.map((stop) => [stop.id, stop]),
  );
  assert.equal(schedule.stops[byId.A1.parent].id, 'P');
  assert.equal(byId.A1.platform, '1');
  assert.equal(byId.C.tz, 'America/Chicago');
  assert.equal(byId.Bst.tz, undefined);
  const shaped = schedule.patterns[t1.pattern];
  assert.equal(shaped.shape, 0);
  assert.deepEqual(shaped.seq, [1, 5, 9]);
  assert.ok(Math.abs(shaped.dist[1] - 1000) < 5, String(shaped.dist[1]));
  assert.ok(Math.abs(shaped.dist[2] - 3000) < 5, String(shaped.dist[2]));
  const bare = schedule.patterns[t4.pattern];
  assert.equal(
    bare.shape,
    null,
    'a position feed draws a shapeless trip between stops',
  );
  assert.deepEqual(bare.pass, [0, 1]);
  assert.ok(Math.abs(bare.dist[1] - 3000) < 5);
  assert.equal(stats.patternsShapeless, 1);

  // The browser module reads it back: the 24:20:00 arrival lands in Chicago
  // time on the next day.
  const live = createSchedule(JSON.parse(JSON.stringify(schedule)));
  const stops = tripStops(
    live,
    { tripId: 't3', serviceDate: '2026-11-07' },
    Date.parse('2026-11-08T04:55:00Z'),
  );
  assert.deepEqual(
    stops.map((stop) => [stop.stopId, stop.scheduledArrival, stop.state]),
    [
      ['A1', '23:50', 'passed'],
      ['Bst', '00:00', 'next'],
      ['C', '23:20', 'upcoming'],
    ],
  );
});

test('no line is invented where the GTFS has no shape', async (t) => {
  const zip = await scheduleZip(t);
  {
    const feed = railFeed();
    const { pack: paths } = await buildPack(feed, zip, { url: 'x' });
    assert.equal(paths.shapes.length, 1);
    assert.deepEqual(paths.shapeSources, ['operator']);
    const { schedule, stats } = await buildSchedule(
      feed,
      zip,
      { url: 'x' },
      paths,
      { from: '2026-11-05' },
    );
    const pattern = schedule.patterns[schedule.trips.t4.pattern];
    assert.equal(pattern.shape, null, 'the shapeless trip gets no shape');
    // Great-circle metres between the two stops, a little under 3 km.
    assert.equal(pattern.dist.length, 2);
    assert.ok(Math.abs(pattern.dist[1] - 3000) < 5, String(pattern.dist[1]));

    assert.equal(stats.patternsShapeless, 1);
    assert.equal(paths.shapes.length, 1, 'the path pack is left as built');
  }
  const chord = [
    ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'].join(),
    `S,0,0,1`,
    `S,0,${(6000 * D).toFixed(6)},2`,
  ].join('\n');
  const sparse = await withZip(t, [
    { name: 'routes.txt', text: 'route_id,route_type\nR1,2\n' },
    {
      name: 'trips.txt',
      text: 'route_id,service_id,trip_id,shape_id\nR1,WK,t1,S\n',
    },
    { name: 'shapes.txt', text: chord },
  ]);
  const { pack, stats } = await buildPack(
    railFeed({ positions: 'schedule' }),
    sparse,
    { url: 'x' },
  );
  assert.equal(pack.shapes.length, 0, 'a chord is dropped on every feed');
  assert.equal(stats.shapesDropped, 1);
});

test('frequency windows give one departure per headway before each end', () => {
  const h = (hours, minutes = 0) => hours * 3600 + minutes * 60;
  // Santiago's Tren Nos: back-to-back windows of different headways.
  assert.deepEqual(
    frequencyDepartures([h(6), h(6, 10), 600, h(6, 10), h(6, 42), 480]),
    [h(6), h(6, 10), h(6, 18), h(6, 26), h(6, 34)],
  );
  // Overlapping windows do not repeat a departure; malformed rows add none.
  assert.deepEqual(
    frequencyDepartures([
      ...[h(7), h(7, 20), 600],
      ...[h(7, 10), h(7, 11), 600],
      ...[h(8), h(9), 0],
      ...[Number.NaN, h(9), 600],
      ...[h(9), h(8), 600],
    ]),
    [h(7), h(7, 10)],
  );
  // One row is capped at a run a minute for a day.
  assert.equal(frequencyDepartures([0, 2 * 86_400, 1]).length, 1440);
});

test('a frequency-based trip becomes one run per departure on its template', async (t) => {
  const zip = await withZip(t, [
    {
      name: 'agency.txt',
      text: 'agency_id,agency_name,agency_url,agency_timezone\nA,Test,https://example.test,America/Santiago\n',
    },
    {
      name: 'calendar.txt',
      text: [
        'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
        'L,1,1,1,1,1,0,0,20261003,20261231',
      ].join('\n'),
    },
    { name: 'routes.txt', text: 'route_id,route_type\nMTN,0\nMTR,0\n' },
    {
      name: 'trips.txt',
      text: [
        'route_id,service_id,trip_id,shape_id,trip_headsign,direction_id',
        'MTN,L,MTN-I-L-M01,S,Nos,0',
        'MTN,L,MTN-I-L-M02,S,Nos,0',
        'MTR,L,MTR-I-L-1,S,Rancagua,0',
      ].join('\n'),
    },
    {
      name: 'frequencies.txt',
      text: [
        'trip_id,start_time,end_time,headway_secs,exact_times',
        'MTN-I-L-M01,06:00:00,06:10:00,600,0',
        'MTN-I-L-M02,06:10:00,06:30:00,480,0',
        'MTN-I-L-M02,23:58:00,24:10:00,1200,0',
      ].join('\n'),
    },
    {
      name: 'stops.txt',
      text: [
        'stop_id,stop_name,stop_lat,stop_lon',
        'A,Alpha,0,' + east(10),
        'B,Bravo,0,' + east(2000),
      ].join('\n'),
    },
    {
      name: 'stop_times.txt',
      text: [
        'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
        // Templates timed from 00:00:00, as the DTPM file has them.
        'MTN-I-L-M01,00:00:00,00:00:00,A,1',
        'MTN-I-L-M01,00:05:00,00:05:00,B,2',
        'MTN-I-L-M02,00:00:00,00:00:00,A,1',
        'MTN-I-L-M02,00:05:00,00:05:00,B,2',
        'MTR-I-L-1,07:00:00,07:00:00,A,1',
        'MTR-I-L-1,07:04:00,07:04:00,B,2',
      ].join('\n'),
    },
    {
      name: 'shapes.txt',
      text: [
        'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
        ...shapeRows('S', 25, 100),
      ].join('\n'),
    },
  ]);
  const feed = railFeed();
  const { pack: paths } = await buildPack(feed, zip, { url: 'x' });
  const { schedule, stats } = await buildSchedule(
    feed,
    zip,
    { url: 'x' },
    paths,
    { from: '2026-11-10', days: 1 },
  );

  assert.deepEqual(Object.keys(schedule.trips).sort(), [
    'MTN-I-L-M01@06:00:00',
    'MTN-I-L-M02@06:10:00',
    'MTN-I-L-M02@06:18:00',
    'MTN-I-L-M02@06:26:00',
    'MTN-I-L-M02@23:58:00',
    'MTR-I-L-1',
  ]);
  const runs = Object.entries(schedule.trips).filter(([id]) =>
    id.startsWith('MTN'),
  );
  assert.deepEqual(
    runs.map(([, trip]) => trip.startSec),
    [21_600, 22_200, 22_680, 23_160, 86_280],
  );
  // Every run shares its template's pattern and run times.
  assert.equal(new Set(runs.map(([, trip]) => trip.pattern)).size, 1);
  assert.equal(new Set(runs.map(([, trip]) => trip.profile)).size, 1);
  assert.deepEqual(schedule.profiles[runs[0][1].profile], [0, 0, 300, 300]);
  assert.equal(runs[0][1].headsign, 'Nos');
  assert.equal(schedule.trips['MTR-I-L-1'].startSec, 25_200);
  assert.equal(stats.frequencyTrips, 2);
  assert.equal(stats.frequencyRuns, 5);
  assert.equal(stats.tripsKept, 6);
  // The 23:58 run arrives after midnight: the pack looks a day back for it.
  assert.equal(stats.lookbackDays, 1);
  assert.deepEqual([...schedule.services.L], ['2026-11-09', '2026-11-10']);
  // The browser module times a run from its own start (Santiago is UTC-3
  // in November).
  const live = createSchedule(JSON.parse(JSON.stringify(schedule)));
  const stops = tripStops(
    live,
    { tripId: 'MTN-I-L-M02@06:18:00', serviceDate: '2026-11-10' },
    Date.parse('2026-11-10T09:20:00Z'),
  );
  assert.deepEqual(
    stops.map((stop) => [stop.stopId, stop.scheduledArrival, stop.state]),
    [
      ['A', '06:18', 'passed'],
      ['B', '06:23', 'next'],
    ],
  );
});
