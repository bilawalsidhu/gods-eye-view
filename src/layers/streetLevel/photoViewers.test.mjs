import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribePhotoViewers } from './photoViewers.js';

/**
 * A photo viewer whose presentations the test sends; `superseded` counts.
 * Unlike photoViewer.js it keeps presenting once superseded, so the order
 * is seen to come from the mount keys alone.
 */
function fakeViewer() {
  const listeners = new Set();
  const viewer = {
    superseded: 0,
    view(mountKey) {
      return {
        mountKey,
        actions: { supersede: () => viewer.superseded++ },
      };
    },
    present(view) {
      for (const listener of [...listeners]) listener(view);
    },
    subscribeView(listener) {
      listeners.add(listener);
      listener(null);
      return () => listeners.delete(listener);
    },
  };
  return viewer;
}

test('the later mount is drawn, whatever order the viewers present in', () => {
  const a = fakeViewer();
  const b = fakeViewer();
  const shown = [];
  const unsubscribe = subscribePhotoViewers([a, b], (view) => shown.push(view));
  assert.deepEqual(shown, [null], 'the current one first');
  const first = a.view(1);
  a.present(first);
  const later = b.view(2);
  b.present(later);
  assert.equal(shown.at(-1), later);
  assert.equal(a.superseded, 1, 'the earlier mount is told it is not drawn');
  // The earlier viewer presents again: it does not take the view back.
  a.present({ ...first, kind: 'flat' });
  assert.equal(shown.at(-1), later);
  assert.equal(shown.length, 3);
  b.present(null);
  assert.equal(shown.at(-1).mountKey, 1, 'the only one presenting');
  a.present(null);
  assert.equal(shown.at(-1), null);
  unsubscribe();
  a.present(first);
  assert.equal(shown.length, 5, 'unsubscribed');
});
