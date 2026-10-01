import assert from 'node:assert/strict';
import test from 'node:test';
import { readoutEntry } from './sampling.js';

test('a sample is a protected overlay card titled with the reading', () => {
  const position = { x: 1, y: 2, z: 3 };
  const lines = ['land surface temperature', '~2.4 km pixel'];
  const entry = readoutEntry('31.4 °C', lines, position);
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.title, '31.4 °C');
  assert.deepEqual(entry.details, lines);
  assert.equal(entry.position, position);
  assert.equal(entry.protected, true);
});
