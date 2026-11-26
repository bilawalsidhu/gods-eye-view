import test from 'node:test';
import assert from 'node:assert/strict';
import { iconAtlas } from './iconAtlas.js';

test('an atlas slot is one per image and size, and has() agrees with slot()', () => {
  const url = `data:image/svg+xml;charset=utf-8,${'%3Csvg%3E'.repeat(400)}#slots`;
  const other = `${url}-other`;
  assert.equal(iconAtlas.has(url, 20), false);
  const small = iconAtlas.slot(url, 20);
  assert.equal(iconAtlas.has(url, 20), true);
  assert.equal(iconAtlas.slot(url, 20), small, 'the same image and size');
  // A copy of the URL, not the same string, finds it too.
  assert.equal(iconAtlas.slot(url.slice(0), 20), small);
  assert.equal(iconAtlas.has(url, 40), false, 'another size is another slot');
  const large = iconAtlas.slot(url, 40);
  assert.notEqual(large, small);
  assert.equal(iconAtlas.has(url, 40), true);
  assert.equal(
    iconAtlas.has(other, 20),
    false,
    'another image is another slot',
  );
  assert.notEqual(iconAtlas.slot(other, 20), small);
});
