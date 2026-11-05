import test from 'node:test';
import assert from 'node:assert/strict';
import { SHIPWRECK_ERAS, eraOf, normalizeEras } from './eras.js';

test('each wreck falls in one era', () => {
  assert.equal(eraOf({ year: 1588 }), 'before-1900');
  assert.equal(eraOf({ year: null, ancient: true }), 'before-1900');
  assert.equal(eraOf({ year: 1900 }), '1900-1945');
  assert.equal(eraOf({ year: 1945 }), '1900-1945');
  assert.equal(eraOf({ year: 1946 }), 'after-1945');
  assert.equal(eraOf({ year: null }), 'undated');
  assert.equal(eraOf(null), 'undated');
});

test('era requests keep known eras only', () => {
  const all = new Set(SHIPWRECK_ERAS);
  assert.deepEqual(
    [...normalizeEras(['after-1945', 'bogus'], all)],
    ['after-1945'],
  );
  assert.deepEqual([...normalizeEras('after-1945', all)], SHIPWRECK_ERAS);
  assert.deepEqual([...normalizeEras([], all)], []);
});
