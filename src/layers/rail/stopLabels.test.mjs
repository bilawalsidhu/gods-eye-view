// Which of a selected train's stops the map labels, how the label's time
// chip is coloured by delay, and the overlay entries the layer publishes.
// Stops have the shape railSchedule.tripStops() returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STOP_CHIP_COLORS,
  STOP_LATE_MS,
  STOP_VERY_LATE_MS,
  createStopOverlayEntries,
  selectStopLabels,
  stopChipColor,
  stopClock,
  stopDelayMs,
  stopLabelText,
  stopLateMinutes,
  stopName,
  stopRoleIndices,
} from './stopLabels.js';

/** A stop as tripStops() lists it; times and delays are illustrative. */
function stop(index, name, state, extra = {}) {
  return {
    index,
    stopId: `s${index}`,
    name,
    lat: 40.9 + index * 0.01,
    lon: -73.9,
    state,
    atStop: false,
    expectedArrival: `14:${String(20 + index * 4).padStart(2, '0')}`,
    expectedDeparture: `14:${String(21 + index * 4).padStart(2, '0')}`,
    arrivalDelaySec: 0,
    departureDelaySec: 0,
    skipped: false,
    passThrough: false,
    relative: state === 'passed' ? 'T+3' : 'T−4',
    ...extra,
  };
}

const trip = [
  stop(0, 'Grand Central', 'passed'),
  stop(1, 'Harlem–125 St', 'passed'),
  stop(2, 'Riverdale', 'passed'),
  stop(3, 'Yonkers', 'next'),
  stop(4, 'Glenwood', 'upcoming'),
  stop(5, 'Hastings', 'upcoming'),
  stop(6, 'Poughkeepsie', 'upcoming'),
];

test('the map labels previous, next, after-next and terminus only', () => {
  const { labels, dots } = selectStopLabels(trip);
  assert.deepEqual(
    labels.map((label) => [label.stop.name, label.role]),
    [
      ['Riverdale', 'previous'],
      ['Yonkers', 'next'],
      ['Glenwood', 'afterNext'],
      ['Poughkeepsie', 'terminus'],
    ],
  );
  assert.deepEqual(
    dots.map((dot) => [dot.stop.name, dot.passed]),
    [
      ['Grand Central', true],
      ['Harlem–125 St', true],
      ['Hastings', false],
    ],
  );
  // The next stop outranks the rest when labels compete for room.
  const top = labels.reduce((a, b) => (b.priority > a.priority ? b : a));
  assert.equal(top.role, 'next');
});

test('never more than four labels, and none repeated near the end', () => {
  const nearEnd = [
    stop(0, 'A', 'passed'),
    stop(1, 'B', 'passed'),
    stop(2, 'C', 'next'),
    stop(3, 'D', 'upcoming'),
  ];
  const { labels, dots } = selectStopLabels(nearEnd);
  // After-next is the terminus: one label, not two.
  assert.deepEqual(
    labels.map((label) => label.role),
    ['previous', 'next', 'afterNext'],
  );
  assert.deepEqual(
    dots.map((dot) => dot.stop.name),
    ['A'],
  );
  for (let n = 0; n <= 12; n++) {
    const list = Array.from({ length: n }, (_, i) =>
      stop(
        i,
        `S${i}`,
        i < n / 2 ? 'passed' : i === Math.ceil(n / 2) ? 'next' : 'upcoming',
      ),
    );
    const chosen = selectStopLabels(list);
    assert.ok(chosen.labels.length <= 4, String(n));
    assert.equal(chosen.labels.length + chosen.dots.length, n);
  }
});

test('a finished trip labels only the stop it last called at', () => {
  const done = trip.map((s) => ({ ...s, state: 'passed' }));
  const { labels } = selectStopLabels(done);
  assert.deepEqual(
    labels.map((label) => [label.stop.name, label.role]),
    [['Poughkeepsie', 'previous']],
  );
});

test('skipped and run-through stops get a dot, never a label or a role', () => {
  const list = [
    stop(0, 'A', 'passed'),
    stop(1, 'B', 'passed', { passThrough: true }),
    stop(2, 'C', 'next', { skipped: true }),
    stop(3, 'D', 'upcoming'),
    stop(4, 'E', 'upcoming'),
    stop(5, 'F', 'upcoming', { skipped: true }),
  ];
  assert.deepEqual(stopRoleIndices(list), { previous: 0, next: 3 });
  const { labels, dots } = selectStopLabels(list);
  assert.deepEqual(
    labels.map((label) => [label.stop.name, label.role]),
    [
      ['A', 'previous'],
      ['D', 'next'],
      ['E', 'afterNext'],
    ],
  );
  assert.deepEqual(
    dots.map((dot) => dot.stop.name),
    ['B', 'C', 'F'],
  );
});

test('unplaced or unnamed stops are neither labelled nor dotted', () => {
  const list = [
    stop(0, 'A', 'passed'),
    { ...stop(1, 'B', 'next'), lat: NaN },
    stop(2, '', 'upcoming'),
    stop(3, 'D', 'upcoming'),
  ];
  const { labels, dots } = selectStopLabels(list);
  assert.deepEqual(
    labels.map((label) => label.stop.name),
    ['A', 'D'],
  );
  assert.deepEqual(dots, []);
  assert.deepEqual(selectStopLabels(null), { labels: [], dots: [] });
  assert.deepEqual(stopRoleIndices(undefined), { previous: -1, next: -1 });
});

test('the time chip is neutral on time, amber from 3 min, red from 10 min', () => {
  assert.equal(STOP_LATE_MS, 180_000);
  assert.equal(STOP_VERY_LATE_MS, 600_000);
  assert.equal(stopChipColor(0), STOP_CHIP_COLORS.onTime);
  assert.equal(stopChipColor(STOP_LATE_MS - 1), STOP_CHIP_COLORS.onTime);
  assert.equal(stopChipColor(STOP_LATE_MS), STOP_CHIP_COLORS.late);
  assert.equal(stopChipColor(STOP_VERY_LATE_MS - 1), STOP_CHIP_COLORS.late);
  assert.equal(stopChipColor(STOP_VERY_LATE_MS), STOP_CHIP_COLORS.veryLate);
  assert.equal(stopChipColor(3 * 3_600_000), STOP_CHIP_COLORS.veryLate);
  assert.equal(stopChipColor(NaN), STOP_CHIP_COLORS.onTime);
  const colors = new Set(Object.values(STOP_CHIP_COLORS));
  assert.equal(colors.size, 3);
});

test('the delay and clock are those of the event the chip counts to', () => {
  const late = stop(3, 'Yonkers', 'next', {
    arrivalDelaySec: 240,
    departureDelaySec: 660,
  });
  // Arriving: the arrival's clock and delay.
  assert.equal(stopClock(late), '14:32');
  assert.equal(stopDelayMs(late), 240_000);
  assert.equal(stopChipColor(stopDelayMs(late)), STOP_CHIP_COLORS.late);
  assert.equal(stopLateMinutes(late), 4);
  // Standing at the stop, or past it: the departure's.
  const dwelling = { ...late, atStop: true };
  assert.equal(stopClock(dwelling), '14:33');
  assert.equal(stopDelayMs(dwelling), 660_000);
  assert.equal(stopChipColor(stopDelayMs(dwelling)), STOP_CHIP_COLORS.veryLate);
  assert.equal(stopClock({ ...late, state: 'passed' }), '14:33');
  // An early train is on time; a missing delay or clock falls back.
  assert.equal(stopDelayMs({ ...late, arrivalDelaySec: -120 }), 0);
  assert.equal(stopLateMinutes({ ...late, arrivalDelaySec: -120 }), 0);
  assert.equal(stopDelayMs({ ...late, arrivalDelaySec: undefined }), 660_000);
  assert.ok(
    Number.isNaN(
      stopDelayMs({ name: 'X', arrivalDelaySec: null, departureDelaySec: 'x' }),
    ),
  );
  assert.equal(stopClock({ ...late, expectedArrival: '' }), '14:33');
  assert.equal(stopClock({ name: 'X' }), '');
});

test('a label reads name, then clock and relative time', () => {
  assert.deepEqual(stopLabelText(stop(3, 'Yonkers', 'next')), {
    title: 'Yonkers',
    detail: '14:32 T−4',
  });
  assert.deepEqual(stopLabelText(stop(2, 'Riverdale', 'passed')), {
    title: 'Riverdale',
    detail: '14:29 T+3',
  });
  assert.deepEqual(stopLabelText({ name: ' Glenwood ', relative: '' }), {
    title: 'Glenwood',
    detail: '',
  });
});

test('overlay entries collide as labels and yield to the selected card', () => {
  const late = trip.map((s) =>
    s.name === 'Yonkers' ? { ...s, arrivalDelaySec: 720 } : s,
  );
  const { labels } = selectStopLabels(late);
  const anchors = [];
  const entries = createStopOverlayEntries(
    'rail:mta-metro-north:123',
    labels,
    (s) => {
      anchors.push(s.name);
      return s.name === 'Glenwood' ? null : { x: 1, y: 2, z: 3 };
    },
  );
  // A stop without an anchor is left out, not drawn at the origin.
  assert.deepEqual(
    entries.map((entry) => entry.title),
    ['Riverdale', 'Yonkers', 'Poughkeepsie'],
  );
  assert.equal(anchors.length, 4);
  const yonkers = entries[1];
  assert.equal(yonkers.variant, 'track');
  assert.deepEqual(yonkers.details, ['14:32 T−4']);
  assert.equal(yonkers.accent, STOP_CHIP_COLORS.veryLate);
  assert.equal(yonkers.collisionGroup, 'ambient-label');
  assert.equal(yonkers.yieldToCollisionGroup, 'ambient-card');
  assert.equal(yonkers.protected, undefined);
  assert.equal(entries[0].accent, STOP_CHIP_COLORS.onTime);
  assert.ok(yonkers.priority > entries[0].priority);
  assert.ok(entries[0].priority > entries[2].priority);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.ok(
    entries.every((entry) => entry.id.startsWith('rail:mta-metro-north:123:')),
  );
});

test('a platform stop is shown by its station’s name', () => {
  const platform = stop(3, 'Wynyard Station Platform 4', 'next', {
    parentName: 'Wynyard Station',
  });
  assert.equal(stopName(platform), 'Wynyard Station');
  assert.equal(stopLabelText(platform).title, 'Wynyard Station');
  assert.equal(
    stopName({ ...platform, parentName: null }),
    'Wynyard Station Platform 4',
  );
  assert.equal(
    stopName({ ...platform, parentName: '  ' }),
    'Wynyard Station Platform 4',
  );
  // A stop known only by its station is still drawable.
  const { labels } = selectStopLabels([
    stop(0, 'A', 'passed'),
    { ...stop(1, '', 'next'), parentName: 'Central' },
  ]);
  assert.deepEqual(
    labels.map((label) => stopName(label.stop)),
    ['A', 'Central'],
  );
});
