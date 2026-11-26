import test from 'node:test';
import assert from 'node:assert/strict';
import { isTouchOnly, overlayPixelRatio } from './canvasPixelRatio.js';

const browser = (dpr, pointers) => ({
  devicePixelRatio: dpr,
  matchMedia: (query) => ({
    matches:
      (query === '(pointer: coarse)' && pointers.includes('coarse')) ||
      (query === '(pointer: fine)' && pointers.includes('fine')),
  }),
});

test('a phone (finger only) draws overlays at CSS pixels', () => {
  assert.equal(isTouchOnly(browser(3, ['coarse'])), true);
  assert.equal(overlayPixelRatio(browser(3, ['coarse'])), 1);
});

test('a fine pointer keeps the display ratio, a touch laptop or an iPad with a trackpad too', () => {
  assert.equal(overlayPixelRatio(browser(2, ['fine'])), 2);
  assert.equal(overlayPixelRatio(browser(2, ['coarse', 'fine'])), 2);
  assert.equal(isTouchOnly(browser(2, ['coarse', 'fine'])), false);
});

test('without matchMedia the display ratio is kept, at least 1 and up to the cap', () => {
  assert.equal(overlayPixelRatio({ devicePixelRatio: 3 }), 3);
  assert.equal(overlayPixelRatio({ devicePixelRatio: 3 }, 2), 2);
  assert.equal(overlayPixelRatio({ devicePixelRatio: 0 }), 1);
  assert.equal(overlayPixelRatio(undefined), 1);
  assert.equal(isTouchOnly(undefined), false);
});
