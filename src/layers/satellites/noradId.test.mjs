import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noradIdFromSatnum } from './noradId.js';

test('five-digit fields are unchanged', () => {
  assert.equal(noradIdFromSatnum('25544'), 25544);
  assert.equal(noradIdFromSatnum('00404'), 404);
});

test('Alpha-5 fields decode, skipping I and O', () => {
  for (const [field, id] of [
    ['A0000', 100000], ['A0404', 100404], ['H9999', 179999], ['J0000', 180000],
    ['N9999', 229999], ['P0000', 230000], ['T0449', 270449], ['Z9999', 339999],
  ]) assert.equal(noradIdFromSatnum(field), id, field);
});

test('anything else stays NaN', () => {
  for (const field of ['I0000', 'O0000', 'a0404', 'A00']) assert.ok(Number.isNaN(noradIdFromSatnum(field)), field);
  assert.equal(noradIdFromSatnum(''), 0); // as Number('') did before
});
