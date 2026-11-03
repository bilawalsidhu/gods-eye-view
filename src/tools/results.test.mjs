import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_GROUPS,
  breakdown,
  breakdownPhrase,
  numericSummary,
} from './results.js';

test('a breakdown counts every row, case-insensitively, largest first', () => {
  const rows = [
    { operator: 'Delta' },
    { operator: 'United' },
    { operator: ' delta ' },
    { operator: null },
    { operator: '' },
    { operator: 'American' },
    { operator: 'United' },
    { operator: 'DELTA' },
  ];
  assert.deepEqual(breakdown(rows, 'operator'), {
    field: 'operator',
    groups: [
      { value: 'Delta', count: 3 },
      { value: 'United', count: 2 },
      { value: 'American', count: 1 },
    ],
    other_count: 0,
    unknown_count: 2,
  });
});

test('groups past the limit are counted as other', () => {
  const rows = Array.from({ length: MAX_GROUPS + 3 }, (_, index) => ({
    type: `T${String(index).padStart(2, '0')}`,
  }));
  rows.push({ type: 'T00' });
  const result = breakdown(rows, 'type');
  assert.equal(result.groups.length, MAX_GROUPS);
  assert.deepEqual(result.groups[0], { value: 'T00', count: 2 });
  assert.equal(result.other_count, 3);
  assert.equal(
    result.groups.reduce((total, group) => total + group.count, 0) +
      result.other_count +
      result.unknown_count,
    rows.length,
  );
});

test('a numeric summary skips missing values', () => {
  const rows = [{ v: 4 }, { v: null }, { v: 1 }, { v: 10 }, { v: 3 }, {}];
  assert.deepEqual(numericSummary(rows, 'v'), {
    count: 4,
    min: 1,
    median: 3.5,
    mean: 4.5,
    max: 10,
  });
  assert.equal(numericSummary([{ v: 2 }, { v: 7 }, { v: 5 }], 'v').median, 5);
  assert.equal(numericSummary([{ v: null }], 'v'), null);
  assert.equal(numericSummary([], 'v'), null);
});

test('the breakdown phrase names the three largest groups', () => {
  const result = {
    unknown_count: 0,
    groups: [
      { value: 'A', count: 4 },
      { value: 'B', count: 3 },
      { value: 'C', count: 2 },
      { value: 'D', count: 1 },
    ],
  };
  assert.equal(
    breakdownPhrase(result, 'type'),
    '; most by type: A (4), B (3), C (2)',
  );
  assert.equal(
    breakdownPhrase({ ...result, unknown_count: 5 }, 'type'),
    '; most by type: A (4), B (3), C (2); 5 unknown',
  );
  // A feed that never reports the field says so instead of staying silent.
  assert.equal(
    breakdownPhrase({ groups: [], unknown_count: 236 }, 'operator'),
    '; no operator reported',
  );
  assert.equal(breakdownPhrase({ groups: [], unknown_count: 0 }, 'type'), '');
});
