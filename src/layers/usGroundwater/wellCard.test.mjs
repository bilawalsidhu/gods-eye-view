import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wellCardColumns,
  wellCardLines,
  wellLabel,
  wrapWellCardLine,
} from './wellCard.js';

const record = (fields = {}) => ({
  id: 'USGWD-x-TX1',
  recordId: 'TX1',
  state: 'Texas',
  longitude: -97.74,
  latitude: 30.27,
  depthFt: null,
  capacityGpm: null,
  screenDepthFt: null,
  screenLengthFt: null,
  constructedYear: null,
  reportedYear: null,
  ...fields,
});

test('the card lists the facts a record has, then its state, caveat and source', () => {
  assert.equal(wellLabel(record()), 'USGWD TX1');
  assert.deepEqual(
    wellCardLines(
      record({
        depthFt: 1250.5,
        capacityGpm: 15,
        screenDepthFt: 0,
        constructedYear: '1987',
      }),
    ),
    [
      'Well depth: 1,250.5 ft',
      'Reported capacity: 15 gal/min',
      'Screen depth: 0 ft',
      'Constructed: 1987',
      'Texas',
      'Historical record; not current conditions.',
      'Source: USGWD TX1',
    ],
  );
});

test('a record with no measurements says so instead of showing an empty card', () => {
  assert.deepEqual(wellCardLines(record({ state: null })), [
    'No size or capacity details in this record.',
    'Historical record; not current conditions.',
    'Source: USGWD TX1',
  ]);
});

test('card lines wrap to the columns the canvas has room for', () => {
  assert.equal(wellCardColumns(1440), 68);
  assert.equal(wellCardColumns(390), 49);
  assert.equal(wellCardColumns(100), 16);
  assert.equal(wellCardColumns(undefined), 68);
  assert.deepEqual(wrapWellCardLine('one two three four', 9), [
    'one two',
    'three',
    'four',
  ]);
  assert.deepEqual(wrapWellCardLine('abcdefghijkl', 5), [
    'abcde',
    'fghij',
    'kl',
  ]);
  assert.deepEqual(wrapWellCardLine('   '), []);
});
