import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boxCentre,
  boxFromRectangle,
  dequantizeBox,
  validateBox,
} from './model.js';
import { searchHls } from './catalog.js';

test('missing imagery edges do not turn into invented zero coordinates', () => {
  for (const value of [null, undefined, '', ' ', false, true]) {
    const box = { west: value, south: 0, east: 1, north: 1 };
    assert.equal(validateBox(box).ok, false);
    assert.equal(validateBox(box).reason, 'invalid');
    assert.equal(boxCentre(box), null);
  }
  assert.equal(validateBox({ west: 0, south: 0, east: 1, north: 1 }).ok, true);
  assert.equal(
    validateBox({ west: '0', south: '0', east: '1', north: '1' }).ok,
    true,
  );
});

test('every edge and every box entry point refuses a missing edge', async () => {
  const blanks = [null, undefined, '', ' ', false, [], {}];
  for (const edge of ['west', 'south', 'east', 'north']) {
    for (const value of blanks) {
      const box = { west: 1, south: 1, east: 2, north: 2, [edge]: value };
      assert.equal(validateBox(box).ok, false, `${edge}=${String(value)}`);
      // Share-link integers and Cesium radians are converted per edge.
      assert.equal(dequantizeBox(box), null, `share ${edge}`);
      assert.equal(boxFromRectangle(box), null, `radians ${edge}`);
    }
  }
  let fetched = false;
  await assert.rejects(
    searchHls({
      box: { west: ' ', south: 1, east: 2, north: 2 },
      fetchImpl: async () => {
        fetched = true;
      },
    }),
    TypeError,
  );
  assert.equal(fetched, false);
  assert.ok(dequantizeBox({ west: 0, south: 0, east: 100000, north: 100000 }));
});
