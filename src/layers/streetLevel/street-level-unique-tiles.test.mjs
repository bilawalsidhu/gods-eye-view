import test from 'node:test';
import assert from 'node:assert/strict';
import { tilesForBbox } from './tileMath.js';

test('reachable polar dateline coverage ranks 24 distinct tiles before overview truncation', () => {
  // coverage uses the actual view bbox above zoom 1; polar views can wrap.
  const bbox = [-10, 60, -20, 85];
  const result = tilesForBbox(bbox, 3);
  const keys = result.tiles.map((tile) => `${tile.x}/${tile.y}/${tile.z}`);
  assert.equal(keys.length, 24);
  assert.equal(new Set(keys).size, 24);
  assert.equal(result.total, 24);
  assert.equal(result.truncated, false);
  const overview = tilesForBbox(bbox, 3, { limit: 16 });
  assert.equal(overview.total, 24);
  assert.equal(overview.tiles.length, 16);
  assert.equal(
    new Set(overview.tiles.map((tile) => `${tile.x}/${tile.y}/${tile.z}`)).size,
    16,
  );
  assert.equal(overview.truncated, true);
});

test('a limit that fits every distinct tile is not spent on repeats', () => {
  // Before de-duplication this box yielded 27 entries for 24 tiles, so a
  // 24-slot overview held repeats and still reported itself truncated.
  const result = tilesForBbox([-10, 60, -20, 85], 3, { limit: 24 });
  const keys = result.tiles.map((tile) => `${tile.x}/${tile.y}/${tile.z}`);
  assert.equal(new Set(keys).size, 24);
  assert.equal(result.truncated, false);
});
