import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceText } from './distanceText.js';

test('rounding to 1,000 metres uses kilometres', () => {
  assert.equal(distanceText(0.9994), '999 m');
  assert.equal(distanceText(0.9996), '1 km');
});
