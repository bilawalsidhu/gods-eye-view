import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTouchOnly,
  overlayPixelRatio,
  watchTouchOnly,
} from './canvasPixelRatio.js';

/**
 * A browser whose primary pointer is `primary` ('coarse' or 'fine'), with a
 * fine pointer attached as well or not.
 */
const browser = (dpr, primary, anyFine = primary === 'fine') => ({
  devicePixelRatio: dpr,
  matchMedia: (query) => ({
    matches:
      query === '(pointer: coarse)'
        ? primary === 'coarse'
        : query === '(pointer: fine)'
          ? primary === 'fine'
          : query === '(any-pointer: fine)'
            ? anyFine
            : false,
  }),
});

test('a phone (finger only) draws overlays at CSS pixels', () => {
  assert.equal(isTouchOnly(browser(3, 'coarse')), true);
  assert.equal(overlayPixelRatio(browser(3, 'coarse')), 1);
});

test('a tablet with a trackpad, mouse or pencil keeps the display ratio', () => {
  // Its primary pointer is still coarse; a fine one is attached.
  assert.equal(isTouchOnly(browser(2, 'coarse', true)), false);
  assert.equal(overlayPixelRatio(browser(2, 'coarse', true)), 2);
});

test('a fine primary pointer keeps the display ratio', () => {
  assert.equal(isTouchOnly(browser(2, 'fine')), false);
  assert.equal(overlayPixelRatio(browser(2, 'fine')), 2);
});

test('without matchMedia the display ratio is kept, at least 1 and up to the cap', () => {
  assert.equal(overlayPixelRatio({ devicePixelRatio: 3 }), 3);
  assert.equal(overlayPixelRatio({ devicePixelRatio: 3 }, 2), 2);
  assert.equal(overlayPixelRatio({ devicePixelRatio: 0 }), 1);
  assert.equal(overlayPixelRatio(undefined), 1);
  assert.equal(isTouchOnly(undefined), false);
});

test('watchTouchOnly calls back when the touch-only answer changes, until stopped', () => {
  const listeners = new Map();
  let anyFine = false;
  const win = {
    matchMedia: (query) => ({
      matches:
        query === '(pointer: coarse)' ||
        (query === '(any-pointer: fine)' && anyFine),
      addEventListener: (_type, fn) => listeners.set(query, fn),
      removeEventListener: (_type, fn) => {
        if (listeners.get(query) === fn) listeners.delete(query);
      },
    }),
  };
  let calls = 0;
  const stop = watchTouchOnly(() => calls++, win);
  assert.deepEqual([...listeners.keys()].sort(), [
    '(any-pointer: fine)',
    '(pointer: coarse)',
  ]);
  // A change event that leaves the answer as it was calls nothing.
  listeners.get('(pointer: coarse)')();
  assert.equal(calls, 0);
  anyFine = true; // a trackpad attached
  listeners.get('(any-pointer: fine)')();
  anyFine = false; // and taken away
  listeners.get('(any-pointer: fine)')();
  assert.equal(calls, 2);
  stop();
  assert.equal(listeners.size, 0);
  assert.doesNotThrow(() => watchTouchOnly(() => {}, {})());
});
