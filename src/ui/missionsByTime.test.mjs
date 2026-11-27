// src/ui/missionsByTime.test.mjs — the order Inspect's Space Missions
// list shows the roster in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { missionsByTime } from '../data/missionsByTime.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const HOUR = 3_600_000;
const entry = (id, hours) => ({
  id,
  launchAt: hours === null ? null : NOW + hours * HOUR,
});
const ids = (rows) => rows.map((row) => row.entry.id);

test('upcoming soonest first, then past newest first', () => {
  const entries = [
    entry('past-old', -100),
    entry('next-week', 168),
    entry('past-recent', -2),
    entry('soon', 1),
    entry('past-mid', -30),
    entry('tomorrow', 24),
  ];
  const rows = missionsByTime(entries, NOW, 5);
  assert.deepEqual(ids(rows), [
    'soon',
    'tomorrow',
    'next-week',
    'past-recent',
    'past-mid',
  ]);
  assert.deepEqual(
    rows.map((row) => row.upcoming),
    [true, true, true, false, false],
  );
});

test('delayed scheduled launches stay upcoming and coarse dates follow precise ones', () => {
  const rows = missionsByTime(
    [
      { ...entry('delayed', -2), status: 'Launch On Hold' },
      { ...entry('completed', -1), status: 'Launch Successful' },
      {
        ...entry('month', -3),
        launchPrecision: 'month',
        status: 'To Be Confirmed',
      },
      { ...entry('go', 1), status: 'Go for Launch' },
    ],
    NOW,
  );
  assert.deepEqual(
    rows.map(({ entry, upcoming }) => [entry.id, upcoming]),
    [
      ['delayed', true],
      ['go', true],
      ['month', true],
      ['completed', false],
    ],
  );
});

test('the same launch time keeps the roster order', () => {
  const rows = missionsByTime(
    [entry('a', 5), entry('b', 5), entry('c', -5), entry('d', -5)],
    NOW,
  );
  assert.deepEqual(ids(rows), ['a', 'b', 'c', 'd']);
});

test('entries without a launch time come last, in roster order', () => {
  const rows = missionsByTime(
    [
      entry('x', null),
      { id: 'y' },
      entry('past', -1),
      entry('soon', 1),
      { id: 'z', launchAt: Number.NaN },
    ],
    NOW,
    10,
  );
  assert.deepEqual(ids(rows), ['soon', 'past', 'x', 'y', 'z']);
  assert.equal(rows.at(-1).upcoming, false);
});

test('a launch at this very moment is still upcoming; a moment later it is past', () => {
  const entries = [entry('later', 2), entry('now', 0), entry('before', -1)];
  assert.deepEqual(ids(missionsByTime(entries, NOW)), [
    'now',
    'later',
    'before',
  ]);
  const after = missionsByTime(entries, NOW + 1);
  assert.deepEqual(ids(after), ['later', 'now', 'before']);
  assert.equal(after[1].upcoming, false);
});

test('a launch passing its time leaves the upcoming block for the top of the past', () => {
  const entries = [
    entry('a', 0.5),
    entry('b', 3),
    entry('c', 4),
    entry('d', 5),
    entry('e', 6),
    entry('f', 7),
    entry('old', -10),
  ];
  assert.deepEqual(ids(missionsByTime(entries, NOW, 5)), [
    'a',
    'b',
    'c',
    'd',
    'e',
  ]);
  // An hour on, five launches are still ahead: the one gone drops out.
  assert.deepEqual(ids(missionsByTime(entries, NOW + HOUR, 5)), [
    'b',
    'c',
    'd',
    'e',
    'f',
  ]);
  assert.deepEqual(ids(missionsByTime(entries, NOW + HOUR, 7)).slice(5), [
    'a',
    'old',
  ]);
});

test('the roster is left as it was', () => {
  const entries = Object.freeze([entry('b', 2), entry('a', 1)]);
  missionsByTime(entries, NOW);
  assert.deepEqual(
    entries.map((one) => one.id),
    ['b', 'a'],
  );
  assert.deepEqual(missionsByTime(null, NOW), []);
});
