import test from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionMsUtc } from './firmsCsv.js';
test('FIRMS acquisition dates cannot roll into a different calendar day', () => {
  for (const [date, time] of [
    ['2026-02-30', '1200'],
    ['2026-04-31', '1200'],
    ['2026-13-01', '1200'],
    ['2026-07-16junk', '1200'],
    ['2026-07-16', '2400'],
    ['2026-07-16', '1260'],
    ['2026-07-16', null],
    ['2026-07-16', ''],
  ]) {
    assert.ok(Number.isNaN(acquisitionMsUtc(date, time)), `${date}:${time}`);
  }
  for (const [date, time, expected] of [
    ['2024-02-29', '45', Date.UTC(2024, 1, 29, 0, 45)],
    ['2026-07-16', '0', Date.UTC(2026, 6, 16)],
  ]) {
    assert.equal(acquisitionMsUtc(date, time), expected);
  }
});
