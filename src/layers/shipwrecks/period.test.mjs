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
  { year: 1588 },
  { year: 1912 },
  { year: 2012 },
  { year: null, ancient: true },
];

test('years come from the record; the extent ignores undated wrecks', () => {
  assert.equal(recordYear(RECORDS[1]), 1912);
  assert.equal(recordYear(RECORDS[3]), null);
  assert.deepEqual(yearExtent(RECORDS), { min: 1588, max: 2012 });
  assert.equal(yearExtent([{ year: null }]), null);
});

test('all years show every wreck; a narrower period hides undated ones', () => {
  const extent = yearExtent(RECORDS);
  const all = periodRange({ from: null, to: null }, extent);
  assert.deepEqual(all, { from: 1588, to: 2012, all: true });
  assert.ok(RECORDS.every((record) => inPeriod(record, all)));
  const wars = periodRange(normalizePeriod({ from: '1914', to: 1945 }), extent);
  assert.deepEqual(
    RECORDS.map((record) => inPeriod(record, wars)),
    [false, false, false, false],
  );
  const reversed = periodRange({ from: 1950, to: 1900 }, extent);
  assert.deepEqual(reversed, { from: 1900, to: 1950, all: false });
  assert.equal(inPeriod(RECORDS[1], reversed), true);
});
