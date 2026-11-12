import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeTrips,
  createSchedule,
  formatRelative,
  liveDelaySec,
  schedulePackEndMs,
  scheduledPosition,
  tripStops,
} from './railSchedule.js';
import {
  formatClock,
  localDate,
  serviceDayOriginMs,
  zonedTimeToEpochMs,
} from './railTimeZones.js';

const MIN = 60_000;
const H = 3_600_000;

/**
 * Four stops on one shape, New York time except the last (Chicago). Run
 * times: A 0, B arrive +5 min / leave +6 min, C +15 min, D +25 min.
 */
function pack(overrides = {}) {
  return {
    version: 1,
    feedId: 'test-feed',
    timezone: 'America/New_York',
    window: { from: '2026-10-31', to: '2026-11-03' },
    routes: { R: { type: 2, short: 'R' } },
    stops: [
      { id: 'A', name: 'Alpha', lat: 40, lon: -74 },
      {
        id: 'B1',
        name: 'Track 1',
        lat: 40,
        lon: -73.99,
        parent: 4,
        platform: '1',
      },
      { id: 'C', name: 'Charlie', lat: 40, lon: -73.97 },
      { id: 'D', name: 'Delta', lat: 40, lon: -73.94, tz: 'America/Chicago' },
      { id: 'B', name: 'Bravo', lat: 40, lon: -73.99 },
    ],
    patterns: [
      {
        shape: 0,
        stops: [0, 1, 2, 3],
        seq: [1, 2, 3, 4],
        dist: [0, 1000, 3000, 6000],
      },
      { shape: null, stops: [0, 2], seq: [1, 2], dist: [0, 2500] },
    ],
    profiles: [
      [0, 0, 300, 360, 900, 900, 1500, 1500],
      [0, 0, 600, 600],
    ],
    services: {
      SAT: ['2026-10-31'],
      SUN: ['2026-11-01'],
      DAILY: ['2026-10-31', '2026-11-01', '2026-11-02'],
    },
    trips: {
      morning: {
        pattern: 0,
        profile: 0,
        startSec: 8 * 3600,
        route: 'R',
        service: 'SUN',
        headsign: 'Delta',
        name: '101',
        direction: 0,
      },
      late: {
        pattern: 0,
        profile: 0,
        startSec: 25 * 3600,
        route: 'R',
        service: 'SAT',
        name: '199',
      },
      fallback: {
        pattern: 0,
        profile: 0,
        startSec: 1.5 * 3600,
        route: 'R',
        service: 'SUN',
      },
      shuttle: {
        pattern: 1,
        profile: 1,
        startSec: 12 * 3600,
        route: 'R',
        service: 'DAILY',
      },
    },
    ...overrides,
  };
}

const at = (iso) => Date.parse(iso);
/** 08:00 EST on 2026-11-01, the morning trip's departure. */
const MORNING = at('2026-11-01T13:00:00Z');

test('relative chips read T−n ahead and T+n past, rounded like the Launches countdown', () => {
  assert.equal(formatRelative(4 * MIN), 'T−4');
  assert.equal(formatRelative(3.5 * MIN), 'T−4');
  assert.equal(formatRelative(30_000), 'T−1');
  assert.equal(formatRelative(0), 'T+0');
  assert.equal(formatRelative(-30_000), 'T+0');
  assert.equal(formatRelative(-3 * MIN), 'T+3');
  assert.equal(formatRelative(-3.5 * MIN), 'T+3');
  assert.equal(formatRelative(65 * MIN), 'T−1:05');
  assert.equal(formatRelative(-125 * MIN), 'T+2:05');
  assert.equal(formatRelative(NaN), '');
});

test('service days count from noon minus 12 h, across both DST changes', () => {
  // Ordinary day: local midnight.
  assert.equal(
    serviceDayOriginMs('2026-10-31', 'America/New_York'),
    at('2026-10-31T04:00:00Z'),
  );
  // Fall back: 01:00 EDT, so 08:00:00 is 08:00 EST.
  const fall = serviceDayOriginMs('20261101', 'America/New_York');
  assert.equal(fall, at('2026-11-01T05:00:00Z'));
  assert.equal(formatClock(fall + 8 * H, 'America/New_York'), '08:00');
  // Spring forward: 23:00 EST the evening before, so 06:00:00 is 06:00 EDT.
  const spring = serviceDayOriginMs('2026-03-08', 'America/New_York');
  assert.equal(spring, at('2026-03-08T04:00:00Z'));
  assert.equal(formatClock(spring + 6 * H, 'America/New_York'), '06:00');
  assert.ok(Number.isNaN(serviceDayOriginMs('2026-02-30', 'UTC')));
});

test('wall times resolve to instants: overlaps take the earlier, gaps move on', () => {
  assert.equal(
    zonedTimeToEpochMs('America/New_York', 2026, 11, 1, 1, 30),
    at('2026-11-01T05:30:00Z'),
  );
  assert.equal(
    zonedTimeToEpochMs('America/New_York', 2026, 3, 8, 2, 30),
    at('2026-03-08T07:30:00Z'),
  );
  assert.equal(
    zonedTimeToEpochMs('Europe/London', 2026, 7, 1, 12),
    at('2026-07-01T11:00:00Z'),
  );
  assert.equal(
    localDate(at('2026-11-01T03:59:00Z'), 'America/New_York'),
    '2026-10-31',
  );
  assert.equal(formatClock(at('2026-11-01T23:59:00Z'), 'Asia/Tokyo'), '08:59');
});

test('a malformed pack is refused', () => {
  assert.throws(() => createSchedule(null), TypeError);
  assert.throws(() => createSchedule({ ...pack(), version: 2 }), TypeError);
  assert.throws(
    () => createSchedule(pack({ patterns: [{ shape: 0, stops: [0, 99] }] })),
    TypeError,
  );
});

test('active trips come from service dates in the agency zone', () => {
  const schedule = createSchedule(pack());
  const ids = (now) =>
    activeTrips(schedule, now).map((run) => `${run.tripId}@${run.serviceDate}`);
  assert.deepEqual(ids(MORNING + 10 * MIN), ['morning@2026-11-01']);
  assert.deepEqual(ids(MORNING - MIN), []);
  assert.deepEqual(ids(MORNING + 26 * MIN), []);
  // Saturday's 25:00:00 trip runs at 01:00 EDT on Sunday, the first 01:00.
  assert.deepEqual(ids(at('2026-11-01T05:10:00Z')), ['late@2026-10-31']);
  // Sunday's 01:30:00 trip runs at 01:30 EST, the second 01:30.
  assert.deepEqual(ids(at('2026-11-01T06:40:00Z')), ['fallback@2026-11-01']);
  // A daily trip appears once per run; widening the window catches a train
  // waiting at its origin.
  assert.deepEqual(ids(at('2026-11-02T17:05:00Z')), ['shuttle@2026-11-02']);
  assert.deepEqual(
    activeTrips(schedule, MORNING - 2 * MIN, { beforeMs: 5 * MIN }).map(
      (run) => run.tripId,
    ),
    ['morning'],
  );
  const [run] = activeTrips(schedule, MORNING + MIN);
  assert.equal(run.name, '101');
  assert.equal(run.headsign, 'Delta');
  assert.equal(run.shape, 0);
  assert.equal(run.scheduledStartMs, MORNING);
  assert.equal(run.scheduledEndMs, MORNING + 25 * MIN);
});

test('the timetable position runs linearly between stops and holds through a dwell', () => {
  const schedule = createSchedule(pack());
  const [run] = activeTrips(schedule, MORNING + MIN);
  const moving = scheduledPosition(schedule, run, MORNING + 150_000);
  assert.equal(moving.state, 'running');
  assert.equal(moving.dwell, false);
  assert.equal(moving.s, 500);
  assert.equal(moving.prevStop, 0);
  assert.equal(moving.nextStop, 1);
  assert.equal(moving.nextStopId, 'B1');
  assert.equal(
    moving.lat,
    undefined,
    'a shaped pattern leaves lat/lon to the path',
  );
  const dwell = scheduledPosition(schedule, run, MORNING + 330_000);
  assert.equal(dwell.dwell, true);
  assert.equal(dwell.s, 1000);
  assert.equal(dwell.prevStop, 1);
  assert.equal(dwell.nextStop, 2);
  const leg = scheduledPosition(schedule, 'morning', MORNING + 630_000);
  assert.equal(leg.s, 2000, 'halfway from B (leaves +6) to C (arrives +15)');
  const before = scheduledPosition(schedule, run, MORNING - MIN);
  assert.equal(before.state, 'before');
  assert.equal(before.s, 0);
  assert.equal(before.nextStop, 0);
  const after = scheduledPosition(schedule, run, MORNING + 30 * MIN);
  assert.equal(after.state, 'arrived');
  assert.equal(after.s, 6000);
  assert.equal(after.nextStop, -1);
});

test('a pattern without a shape interpolates between its stops', () => {
  const schedule = createSchedule(pack());
  const noon = at('2026-11-01T17:00:00Z');
  const position = scheduledPosition(
    schedule,
    { tripId: 'shuttle', serviceDate: '2026-11-01' },
    noon + 5 * MIN,
  );
  assert.equal(position.shape, null);
  assert.equal(position.s, 1250);
  assert.ok(Math.abs(position.lon - -73.985) < 1e-9);
  assert.equal(position.lat, 40);
});

test('the stop list shows station-local 24 h clocks, states and chips', () => {
  const schedule = createSchedule(pack());
  const stops = tripStops(schedule, 'morning', MORNING + 320_000);
  assert.deepEqual(
    stops.map((stop) => [stop.stopId, stop.state, stop.atStop, stop.relative]),
    [
      ['A', 'passed', false, 'T+5'],
      ['B1', 'next', true, 'T−1'],
      ['C', 'upcoming', false, 'T−10'],
      ['D', 'upcoming', false, 'T−20'],
    ],
  );
  assert.equal(stops[0].scheduledDeparture, '08:00');
  assert.equal(stops[1].scheduledArrival, '08:05');
  assert.equal(stops[1].scheduledDeparture, '08:06');
  assert.equal(stops[1].name, 'Track 1');
  assert.equal(stops[1].parentName, 'Bravo');
  assert.equal(stops[1].platform, '1');
  assert.equal(stops[1].timezone, 'America/New_York');
  // Delta keeps Chicago time: 08:25 Eastern is 07:25 Central.
  assert.equal(stops[3].timezone, 'America/Chicago');
  assert.equal(stops[3].scheduledArrival, '07:25');
  assert.equal(stops[3].scheduledArrivalMs, MORNING + 25 * MIN);
  assert.equal(stops[3].realtime, false);
});

test('times past 24:00:00 land on the next calendar day', () => {
  const schedule = createSchedule(pack());
  const stops = tripStops(schedule, 'late', at('2026-11-01T05:00:00Z'));
  assert.equal(stops[0].scheduledDepartureMs, at('2026-11-01T05:00:00Z'));
  assert.equal(stops[0].scheduledDeparture, '01:00');
  assert.equal(stops[1].scheduledArrival, '01:05');
  // The fall-back trip at 01:30:00 runs an hour of real time later.
  const fallback = tripStops(schedule, 'fallback', at('2026-11-01T06:30:00Z'));
  assert.equal(fallback[0].scheduledDepartureMs, at('2026-11-01T06:30:00Z'));
  assert.equal(fallback[0].scheduledDeparture, '01:30');
});

test('a stop delay carries on to later stops until the next update', () => {
  const schedule = createSchedule(pack());
  const delays = {
    morning: {
      stops: [
        { stopId: 'B1', arrival: { delay: 120 } },
        { stopSequence: 4, arrival: { time: (MORNING + 26 * MIN) / 1000 } },
      ],
    },
  };
  const stops = tripStops(schedule, 'morning', MORNING, delays);
  assert.deepEqual(
    stops.map((stop) => [stop.arrivalDelaySec, stop.departureDelaySec]),
    [
      [0, 0],
      [120, 120],
      [120, 120],
      [60, 60],
    ],
  );
  assert.equal(stops[1].expectedArrival, '08:07');
  assert.equal(stops[1].scheduledArrival, '08:05');
  assert.equal(stops[1].realtime, true);
  // Between A (left on time) and B (arrives +7) the run is slower.
  const position = scheduledPosition(
    schedule,
    'morning',
    MORNING + 210_000,
    delays,
  );
  assert.equal(position.s, 500);
  assert.equal(position.delaySec, 120);
  // A late train is still active after its timetable ends.
  const late = { morning: { delaySec: 600 } };
  assert.deepEqual(
    activeTrips(schedule, MORNING + 30 * MIN).map((run) => run.tripId),
    [],
  );
  const [run] = activeTrips(schedule, MORNING + 30 * MIN, { delays: late });
  assert.equal(run.tripId, 'morning');
  assert.equal(run.expectedEndMs, MORNING + 35 * MIN);
});

test('a delay pinned to a start date leaves other runs alone; parent ids match platforms', () => {
  const schedule = createSchedule(pack());
  const pinned = { morning: { startDate: '20261031', delaySec: 300 } };
  assert.equal(
    tripStops(schedule, 'morning', MORNING, pinned)[2].arrivalDelaySec,
    0,
  );
  const own = {
    morning: {
      startDate: '2026-11-01',
      stops: [{ stopId: 'B', departure: { delay: 60 } }],
    },
  };
  const stops = tripStops(schedule, 'morning', MORNING, own);
  assert.equal(stops[1].departureDelaySec, 60);
  assert.equal(stops[2].arrivalDelaySec, 60);
});

test('a skipped stop is passed without a dwell', () => {
  const schedule = createSchedule(pack());
  // The record shape src/data/railTripUpdates.js serves.
  const delays = {
    morning: {
      tripId: 'morning',
      startDate: '20261101',
      delaySec: null,
      stops: [
        {
          stopId: null,
          stopSequence: 2,
          arrival: null,
          departure: null,
          relationship: 'SKIPPED',
        },
      ],
    },
  };
  const position = scheduledPosition(
    schedule,
    'morning',
    MORNING + 450_000,
    delays,
  );
  assert.equal(position.dwell, false);
  assert.equal(position.prevStop, 0);
  assert.equal(position.nextStop, 2);
  assert.equal(position.s, 1500, 'halfway from A (+0) to C (+15)');
  assert.equal(
    tripStops(schedule, 'morning', MORNING, delays)[1].skipped,
    true,
  );
});

test('a canceled run leaves the active list', () => {
  const schedule = createSchedule(pack());
  const now = MORNING + 10 * MIN;
  const canceled = { morning: { relationship: 'CANCELED' } };
  assert.equal(activeTrips(schedule, now).length, 1);
  assert.equal(activeTrips(schedule, now, { delays: canceled }).length, 0);
});

test('NO_DATA at a stop ends the delay carried to it: the timetable applies again', () => {
  const schedule = createSchedule(pack());
  const delays = {
    morning: {
      delaySec: 300,
      stops: [
        { stopId: 'B1', arrival: { delay: 240 } },
        { stopId: 'C', relationship: 'NO_DATA' },
      ],
    },
  };
  const stops = tripStops(schedule, 'morning', MORNING, delays);
  assert.deepEqual(
    stops.map((stop) => [stop.arrivalDelaySec, stop.departureDelaySec]),
    [
      [300, 300],
      [240, 240],
      // No prediction from C on: its time and D's are the timetable's.
      [0, 0],
      [0, 0],
    ],
  );
  assert.equal(stops[2].expectedArrival, stops[2].scheduledArrival);
  // A later update after NO_DATA counts again.
  const later = {
    morning: {
      stops: [
        { stopId: 'B1', arrival: { delay: 240 } },
        { stopId: 'C', scheduleRelationship: 'NO_DATA' },
        { stopSequence: 4, arrival: { delay: 60 } },
      ],
    },
  };
  assert.deepEqual(
    tripStops(schedule, 'morning', MORNING, later).map(
      (stop) => stop.arrivalDelaySec,
    ),
    [0, 240, 0, 60],
  );
});

test('a pack ends when the last run it holds arrives', () => {
  // The latest run: the shuttle on its last date, 2 November, at noon New
  // York time for 10 minutes (31 October's 25:00 train arrives earlier).
  const end = schedulePackEndMs(pack());
  assert.equal(
    end,
    serviceDayOriginMs('2026-11-02', 'America/New_York') + 12 * H + 10 * MIN,
  );
  // Without a window the end is not known; with no run there is none.
  assert.equal(schedulePackEndMs(pack({ window: undefined })), null);
  assert.equal(schedulePackEndMs(pack({ trips: {} })), -Infinity);
  assert.equal(schedulePackEndMs(null), null);
});

test('a live report states its own delay; a day or more either way is no delay', () => {
  assert.equal(liveDelaySec({ delaySec: 540 }), 540);
  assert.equal(liveDelaySec({ delaySec: -120 }), -120);
  assert.equal(liveDelaySec({ delaySec: 0 }), 0);
  for (const value of [null, undefined, '540', NaN, Infinity, 86_401, -86_401])
    assert.equal(liveDelaySec({ delaySec: value }), null, String(value));
  assert.equal(liveDelaySec(null), null);
});
