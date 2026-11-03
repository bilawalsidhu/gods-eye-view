import test from 'node:test';
import assert from 'node:assert/strict';
import { tilesForBbox } from './tileMath.js';

const keysOf = (tiles) => tiles.map((tile) => `${tile.x}/${tile.y}/${tile.z}`);

test('a polar view across the date line ranks 24 distinct tiles', () => {
  // The halves of [-10, 60, -20, 85] share a column at z3.
  const keys = keysOf(tilesForBbox([-10, 60, -20, 85], 3));
  assert.equal(keys.length, 24);
  assert.equal(new Set(keys).size, 24);
});

test('a limit is not spent on repeats', () => {
  const keys = keysOf(tilesForBbox([-10, 60, -20, 85], 3, { limit: 16 }));
  assert.equal(keys.length, 16);
  assert.equal(new Set(keys).size, 16);
});
