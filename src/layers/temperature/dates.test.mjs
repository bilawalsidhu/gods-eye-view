import assert from 'node:assert/strict';
import test from 'node:test';
import {
  frameLabel,
  monthIndex,
  monthName,
  recentMonths,
  utcDate,
  yearMonths,
} from './dates.js';

test('dates are UTC calendar dates, not host-timezone ones', () => {
  assert.equal(utcDate(Date.parse('2026-09-30T23:30:00Z')), '2026-09-30');
});

test('a month reads as its name and year, and a frame as the month it averages', () => {
  assert.equal(monthIndex('2026-01-01'), 0);
  assert.equal(monthIndex('2026-12-01'), 11);
  assert.equal(monthName('2026-08-01'), 'Aug 2026');
  assert.equal(monthName('2025-12-01'), 'Dec 2025');
  assert.equal(frameLabel('2026-08-01'), 'monthly mean, 2026-08');
});

test('recent months step back by calendar month across the year boundary', () => {
  assert.deepEqual(recentMonths(Date.parse('2026-02-10T00:00:00Z'), 3), [
    '2026-02-01',
    '2026-01-01',
    '2025-12-01',
  ]);
  assert.equal(recentMonths(Date.parse('2026-02-10T00:00:00Z'), 0).length, 1);
});

test('a year offers only months between the first and newest published', () => {
  assert.equal(yearMonths(2019, '2026-08-01').length, 12);
  // The product starts in March 2000 and the current year stops at the newest.
  assert.deepEqual(yearMonths(2000, '2026-08-01').slice(0, 2), [
    '2000-03-01',
    '2000-04-01',
  ]);
  assert.equal(yearMonths(2000, '2026-08-01').length, 10);
  assert.equal(yearMonths(2026, '2026-08-01').at(-1), '2026-08-01');
  assert.equal(yearMonths(2026, '2026-08-01').length, 8);
});
