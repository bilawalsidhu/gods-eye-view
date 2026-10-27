import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAwarenessDirection } from './presentation.js';

test('awareness bearings that round through north read 000, not 360', () => {
  assert.equal(formatAwarenessDirection(359.4), '359');
  assert.equal(formatAwarenessDirection(359.6), '000');
  assert.equal(formatAwarenessDirection(0), '000');
  assert.equal(formatAwarenessDirection(-0.4), '000');
  assert.equal(formatAwarenessDirection(Number.NaN), '—');
});
