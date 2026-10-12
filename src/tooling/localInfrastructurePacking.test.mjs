import test from 'node:test';
import assert from 'node:assert/strict';
import { packInfrastructure } from '../../scripts/prepare-local-infrastructure.mjs';

test('local packing uses safe filenames, preserves explicit technology and reports complete source counts', () => {
  const result = packInfrastructure([
    {
      id: 'synthetic-a',
      name: 'Invented demonstration point',
      lat: 1.25,
      lon: 2.5,
      technologies: ['5G'],
      owner: 'Unknown',
    },
  ]);
  assert.equal(result.index.tiles[0].count, 1);
  assert.equal(result.index.tiles[0].tile, 'tile_0_2');
  assert.deepEqual(result.tiles.get('tile_0_2').rows[0].technologies, ['5G']);
  assert.equal(result.tiles.get('tile_0_2').rows[0].owner, 'Unknown');
});
test('invalid or oversized local public-data inputs fail before output', () => {
  assert.throws(() => packInfrastructure({}));
  assert.throws(() => packInfrastructure(Array(100001).fill({})));
  assert.throws(() =>
    packInfrastructure([{ id: 'a', name: 'a', lat: 91, lon: 0 }]),
  );
  assert.throws(() =>
    packInfrastructure([{ id: 'a', name: 'a', lat: 0, lon: NaN }]),
  );
});
