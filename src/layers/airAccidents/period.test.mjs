import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inPeriod,
  normalizePeriod,
  periodRange,
  recordYear,
  yearExtent,
} from './period.js';

const RECORDS = [
  { date: '1956-06-30' },
  { date: '2002-07-01' },
  { date: '2024-08-09' },
  { date: null },
];

test('years come from the ISO date; the extent ignores undated records', () => {
  assert.equal(recordYear(RECORDS[1]), 2002);
  assert.equal(recordYear(RECORDS[3]), null);
  assert.deepEqual(yearExtent(RECORDS), { min: 1956, max: 2024 });
  assert.equal(yearExtent([{ date: null }]), null);
});

test('the default period shows every record, undated ones included', () => {
  const range = periodRange({ from: null, to: null }, yearExtent(RECORDS));
  assert.deepEqual(range, { from: 1956, to: 2024, all: true });
  assert.ok(RECORDS.every((record) => inPeriod(record, range)));
});

test('a start and an end year select the matching years only', () => {
  const extent = yearExtent(RECORDS);
  const decade = periodRange({ from: 2000, to: 2009 }, extent);
  assert.deepEqual(decade, { from: 2000, to: 2009, all: false });
  assert.deepEqual(
    RECORDS.filter((record) => inPeriod(record, decade)),
    [RECORDS[1]],
  );
  const recent = periodRange({ from: 2010, to: null }, extent);
  assert.deepEqual(
    RECORDS.filter((record) => inPeriod(record, recent)),
    [RECORDS[2]],
  );
  // Out-of-range years are clamped to the data; a reversed pair is swapped.
  assert.deepEqual(periodRange({ from: 3000, to: null }, extent), {
    from: 2024,
    to: 2024,
    all: false,
  });
  assert.deepEqual(periodRange({ from: 2010, to: 1990 }, extent), {
    from: 1990,
    to: 2010,
    all: false,
  });
});

test('requests merge into the current period; bad values are ignored', () => {
  const current = { from: null, to: null };
  assert.deepEqual(normalizePeriod({ from: 2000 }, current), {
    from: 2000,
    to: null,
  });
  assert.deepEqual(normalizePeriod({ to: '2015' }, current), {
    from: null,
    to: 2015,
  });
  assert.deepEqual(normalizePeriod({ from: 1.5, to: 'x' }, current), current);
  assert.deepEqual(normalizePeriod({ from: null }, { from: 2000, to: 2010 }), {
    from: null,
    to: 2010,
  });
});
