import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFlightIdentity } from './flightIdentity.js';

const fixtures = [
  ['BA123', 'BAW123'],
  ['BA0123', 'BAW123'],
  ['UA123', 'UAL123'],
  ['BAW123', 'BAW123'],
  ['BAW0123', 'BAW0123'],
  ['ZXY0123', 'ZXY0123'],
  ['ZXY123', 'ZXY123'],
  ['ual123', 'UAL123'],
  ['BAW 123', 'BAW123'],
  ['UAL-123', 'UAL123'],
  ['UAL12A', 'UAL12A'],
  ['ZZ123', 'ZZ123'],
  ['BA0000', 'BA0000'],
  ['0000', '0000'],
  [' ba-0000a ', 'BA-0000A'],
];

for (const [input, expected] of fixtures) {
  test(`normalizeFlightIdentity(${JSON.stringify(input)}) preserves identity`, () => {
    assert.equal(normalizeFlightIdentity(input), expected);
  });
}
