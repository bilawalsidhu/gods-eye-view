import test from 'node:test';
import assert from 'node:assert/strict';
import { imageryHostStatus, NO_IMAGERY_HOST } from './imageryHost.js';

test('only a missing host suspends weather; 3D Tiles has no height gate', () => {
  assert.equal(imageryHostStatus({ kind: 'tileset' }), null);
  assert.equal(imageryHostStatus({ kind: 'globe' }), null);
  assert.equal(imageryHostStatus({ kind: 'none' }), NO_IMAGERY_HOST);
});

test('missing imagery host offers a globe map', () => {
  assert.match(NO_IMAGERY_HOST, /globe map/);
});
